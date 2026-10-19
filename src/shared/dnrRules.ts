import { CallRule, ExtensionSettings, getActivePatterns, getExplicitPatternOrigin, getPatternHost, isAnyOriginTarget, isCredentialsSupported, toUrlPatternRegExpSource } from './settings.js';

// Structural mirror of chrome.declarativeNetRequest.Rule using plain strings, so rules can be built and
// tested outside the browser. The Chrome background casts these to the real type when applying them.
export interface DnrHeader {
  header: string;
  operation: 'set' | 'append';
  value: string;
}

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  initiatorDomains?: string[];
  excludedResponseHeaders?: Array<{ header: string }>;
  resourceTypes: string[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'modifyHeaders'; responseHeaders: DnrHeader[] } | { type: 'allow' };
  condition: DnrCondition;
}

export const MAX_PATTERN_RULES = 250;
export const MAX_SKIP_RULES = 250;
export const MAX_METHOD_OVERRIDE_RULES = 250;
export const MAX_CALL_RULES = 250;

const GLOBAL_RULE_PRIORITY = 1;
// Pattern lengths add at most 1,000, so every individual rule outranks every domain rule.
const DOMAIN_RULE_PRIORITY_BASE = 1_000;
const INDIVIDUAL_RULE_PRIORITY_BASE = 3_000;
// Above every modifyHeaders rule, so a matching skip rule stops all of this extension's header changes.
const SKIP_RULE_PRIORITY = 10_000;

// Wildcard Allow-Headers never covers Authorization, and with credentials browsers read '*' as a literal
// header name. Common request headers are listed by name so credentialed calls can still send them.
export const ALLOW_ALL_HEADERS_VALUE = '*, Authorization, Content-Type, Accept, X-Requested-With, X-CSRF-Token, X-XSRF-Token, X-Api-Key, Cache-Control, If-Match, If-None-Match, If-Modified-Since';

const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

export function buildDynamicRules(settings: ExtensionSettings): DnrRule[] {
  const rules: Array<Omit<DnrRule, 'id'>> = [];
  if (!settings.enabled) {
    return [];
  }

  // Only patterns getActivePatterns() approves get a rule; overrides never bypass the enabled/mode gate.
  const activePatterns = getActivePatterns(settings).slice(0, MAX_PATTERN_RULES);
  activePatterns.forEach((pattern) => rules.push(...createPatternRules(pattern, settings)));
  settings.callRules.slice(0, MAX_CALL_RULES).forEach((callRule) => rules.push(...createCallRules(callRule, settings)));

  // A method override on a call rule's target applies only through that call rule.
  const activePatternSet = new Set([...activePatterns, ...settings.callRules.map((rule) => rule.target)]);
  Object.entries(settings.methodOverrides)
    .filter(([pattern]) => !activePatternSet.has(pattern))
    .slice(0, MAX_METHOD_OVERRIDE_RULES)
    .forEach(([pattern, methods]) => rules.push(createMethodOverrideRule(pattern, methods)));

  // Responses that already carry Allow-Origin come from servers that handle CORS themselves; leave them alone.
  if (settings.respectServerCors) {
    rules.forEach((rule) => {
      rule.condition.excludedResponseHeaders = [{ header: 'access-control-allow-origin' }];
    });
  }

  settings.skiplist.slice(0, MAX_SKIP_RULES).forEach((pattern) => rules.push(...createSkipRules(pattern)));

  return rules.map((rule, index) => ({ id: index + 1, ...rule }));
}

function createPatternRules(pattern: string, settings: ExtensionSettings): Array<Omit<DnrRule, 'id'>> {
  const allowedMethods = settings.methodOverrides[pattern] ?? settings.allowMethods;
  const credentialsActive = settings.allowCredentials && isCredentialsSupported(settings);
  const responseOrigin = credentialsActive ? getExplicitPatternOrigin(pattern) : null;
  const responseHeaders = createResponseHeaders(allowedMethods, settings, credentialsActive, responseOrigin);
  const isIndividualPattern = settings.whitelist.includes(pattern);
  const priority = pattern === '<all_urls>'
    ? GLOBAL_RULE_PRIORITY
    : (isIndividualPattern ? INDIVIDUAL_RULE_PRIORITY_BASE : DOMAIN_RULE_PRIORITY_BASE) + Math.min(pattern.length, 1000);
  const rules: Array<Omit<DnrRule, 'id'>> = [];
  const initiatorDomain = toInitiatorDomain(pattern);
  const domainRuleType = isIndividualPattern ? 'both' : settings.domainRules.find((rule) => rule.pattern === pattern)?.type ?? 'both';
  // Target rules relax this pattern's responses for every site, so they need the rule's explicit opt-in.
  // Global mode is the one exception: it already applies to every site by definition.
  const anyOrigin = pattern === '<all_urls>' || isAnyOriginTarget(pattern, settings);
  if (anyOrigin && !credentialsActive && domainRuleType !== 'third_party') {
    rules.push({
      priority,
      action: { type: 'modifyHeaders', responseHeaders },
      condition: { ...toDnrUrlCondition(pattern), resourceTypes: RESOURCE_TYPES }
    });
  }

  if (initiatorDomain && domainRuleType !== 'first_party' && (!credentialsActive || responseOrigin)) {
    rules.push({
      priority,
      action: { type: 'modifyHeaders', responseHeaders },
      condition: { urlFilter: '|http', initiatorDomains: [initiatorDomain], resourceTypes: RESOURCE_TYPES }
    });
  }

  return rules;
}

// One unblocked call: responses from the target, for requests made by the `from` page only.
function createCallRules({ target, from }: CallRule, settings: ExtensionSettings): Array<Omit<DnrRule, 'id'>> {
  const initiatorDomain = toInitiatorDomain(from);
  const credentialsActive = settings.allowCredentials && isCredentialsSupported(settings);
  const responseOrigin = credentialsActive ? getExplicitPatternOrigin(from) : null;
  // Without a plain domain Chrome cannot match the page, and with credentials it must name the page's origin.
  if (!initiatorDomain || (credentialsActive && !responseOrigin)) {
    return [];
  }

  const methods = settings.methodOverrides[target] ?? settings.allowMethods;
  return [{
    priority: INDIVIDUAL_RULE_PRIORITY_BASE + Math.min(target.length, 1000),
    action: { type: 'modifyHeaders', responseHeaders: createResponseHeaders(methods, settings, credentialsActive, responseOrigin) },
    condition: { ...toDnrUrlCondition(target), initiatorDomains: [initiatorDomain], resourceTypes: RESOURCE_TYPES }
  }];
}

// Sets only the allowed methods, so it changes nothing unless another rule already relaxed the response.
// Its priority follows the same longest-pattern-wins order as getAllowedMethodsForRequest().
function createMethodOverrideRule(pattern: string, methods: string[]): Omit<DnrRule, 'id'> {
  return {
    priority: INDIVIDUAL_RULE_PRIORITY_BASE + Math.min(pattern.length, 1000),
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'access-control-allow-methods', operation: 'set', value: methods.join(', ') }] },
    condition: { ...toDnrUrlCondition(pattern), resourceTypes: RESOURCE_TYPES }
  };
}

// A skip pattern matches a request by its URL or by the page that made it, like isCorsSkippedForRequest().
function createSkipRules(pattern: string): Array<Omit<DnrRule, 'id'>> {
  const rules: Array<Omit<DnrRule, 'id'>> = [{
    priority: SKIP_RULE_PRIORITY,
    action: { type: 'allow' },
    condition: { ...toDnrUrlCondition(pattern), resourceTypes: RESOURCE_TYPES }
  }];

  // Chrome reports the initiator as an origin, which only a whole-host pattern can match.
  const initiatorDomain = /^(?:\*|https?):\/\/[^/]+\/\*$/.test(pattern) ? toInitiatorDomain(pattern) : null;
  if (initiatorDomain) {
    rules.push({
      priority: SKIP_RULE_PRIORITY,
      action: { type: 'allow' },
      condition: { urlFilter: '|http', initiatorDomains: [initiatorDomain], resourceTypes: RESOURCE_TYPES }
    });
  }

  return rules;
}

function createResponseHeaders(methods: string[], settings: ExtensionSettings, allowCredentials: boolean, origin: string | null): DnrHeader[] {
  const headers: DnrHeader[] = [
    { header: 'access-control-allow-origin', operation: 'set', value: origin ?? '*' },
    { header: 'access-control-allow-methods', operation: 'set', value: methods.join(', ') }
  ];

  // A response that names one origin differs per requesting page, so caches must key on Origin.
  if (origin) {
    headers.push({ header: 'vary', operation: 'append', value: 'Origin' });
  }

  // DNR rules are static, so Chrome can only send '*'; browsers ignore that wildcard on credentialed calls.
  if (settings.exposeAllHeaders) {
    headers.push({ header: 'access-control-expose-headers', operation: 'set', value: '*' });
  }

  if (settings.allowAllHeaders) {
    headers.push({ header: 'access-control-allow-headers', operation: 'set', value: ALLOW_ALL_HEADERS_VALUE });
  }

  if (allowCredentials) {
    headers.push({ header: 'access-control-allow-credentials', operation: 'set', value: 'true' });
  }

  return headers;
}


// Uses the same regex as the shared matcher so Chrome and Firefox agree on what a pattern covers.
function toDnrUrlCondition(pattern: string): Pick<DnrCondition, 'urlFilter' | 'regexFilter' | 'isUrlFilterCaseSensitive'> {
  if (pattern === '<all_urls>') {
    return { urlFilter: '|http' };
  }

  return { regexFilter: toUrlPatternRegExpSource(pattern), isUrlFilterCaseSensitive: true };
}

// DNR initiatorDomains takes plain domains (subdomains included), so hosts with other wildcards,
// such as 'www.*.example.com', cannot be expressed and get no initiator rule.
function toInitiatorDomain(pattern: string): string | null {
  const domain = getPatternHost(pattern)?.replace(/^\*\./, '') ?? null;
  return domain && !domain.includes('*') ? domain : null;
}
