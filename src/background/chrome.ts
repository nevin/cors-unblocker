import { loadSettings, onSettingsChanged, recordDiscoveredRequest } from '../shared/browserApi';
import { ExtensionSettings, getActivePatterns, getPatternHost, isCredentialsSupported, toUrlPatternRegExpSource } from '../shared/settings';

const TARGET_RULE_ID_BASE = 10_000;
const INITIATOR_RULE_ID_BASE = 20_000;
const MAX_RULES = 250;
let ruleUpdateQueue = Promise.resolve();
const GLOBAL_RULE_PRIORITY = 1;
const DOMAIN_RULE_PRIORITY_BASE = 100;
const INDIVIDUAL_RULE_PRIORITY_BASE = 200;

const RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
  chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
  chrome.declarativeNetRequest.ResourceType.STYLESHEET,
  chrome.declarativeNetRequest.ResourceType.SCRIPT,
  chrome.declarativeNetRequest.ResourceType.IMAGE,
  chrome.declarativeNetRequest.ResourceType.FONT,
  chrome.declarativeNetRequest.ResourceType.OBJECT,
  chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
  chrome.declarativeNetRequest.ResourceType.PING,
  chrome.declarativeNetRequest.ResourceType.MEDIA,
  chrome.declarativeNetRequest.ResourceType.WEBSOCKET,
  chrome.declarativeNetRequest.ResourceType.OTHER
];
chrome.runtime.onInstalled.addListener(() => {
  void refreshRules();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshRules();
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void recordDiscoveredRequest(details.url, details.initiator, details.tabId);
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'ping']
  }
);

onSettingsChanged((settings) => {
  queueApplyRules(settings);
});

void refreshRules();

async function refreshRules(): Promise<void> {
  await queueApplyRules(await loadSettings());
}

function queueApplyRules(settings: ExtensionSettings): Promise<void> {
  ruleUpdateQueue = ruleUpdateQueue
    .then(() => applyRules(settings))
    .catch((error: unknown) => {
      console.error('Unable to update CORS rules', error);
    });

  return ruleUpdateQueue;
}

async function applyRules(settings: ExtensionSettings): Promise<void> {
  // Only patterns getActivePatterns() approves get a rule; overrides never bypass the enabled/mode/skip gate.
  const activePatterns = getActivePatterns(settings).slice(0, MAX_RULES);
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules
    .filter((rule) => (
      (rule.id >= TARGET_RULE_ID_BASE && rule.id < TARGET_RULE_ID_BASE + MAX_RULES) ||
      (rule.id >= INITIATOR_RULE_ID_BASE && rule.id < INITIATOR_RULE_ID_BASE + MAX_RULES)
    ))
    .map((rule) => rule.id);
  const addRules = activePatterns.flatMap((pattern, index) => createRules(pattern, index, settings));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

function createRules(pattern: string, index: number, settings: ExtensionSettings): chrome.declarativeNetRequest.Rule[] {
  const excludedDomains = getExcludedDomains(settings.skiplist);
  const allowedMethods = settings.methodOverrides[pattern] ?? settings.allowMethods;
  const credentialsActive = settings.allowCredentials && isCredentialsSupported(settings);
  const responseOrigin = credentialsActive ? getPatternOrigin(pattern) : null;
  const responseHeaders = createResponseHeaders(allowedMethods, settings.allowAllHeaders, credentialsActive, responseOrigin);
  const isIndividualPattern = settings.whitelist.includes(pattern);
  const priority = pattern === '<all_urls>'
    ? GLOBAL_RULE_PRIORITY
    : (isIndividualPattern ? INDIVIDUAL_RULE_PRIORITY_BASE : DOMAIN_RULE_PRIORITY_BASE) + Math.min(pattern.length, 1000);
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  const initiatorDomain = toInitiatorDomain(pattern);
  const domainRuleType = isIndividualPattern ? 'both' : settings.domainRules.find((rule) => rule.pattern === pattern)?.type ?? 'both';
  if (!credentialsActive && domainRuleType !== 'third_party') {
    rules.push(createTargetRule(pattern, index, excludedDomains, responseHeaders, priority));
  }

  if (initiatorDomain && domainRuleType !== 'first_party' && (!credentialsActive || responseOrigin)) {
    rules.push(createInitiatorRule(initiatorDomain, index, excludedDomains, responseHeaders, priority));
  }

  return rules;
}


function createTargetRule(pattern: string, index: number, excludedDomains: string[], responseHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[], priority: number): chrome.declarativeNetRequest.Rule {
  return {
    id: TARGET_RULE_ID_BASE + index,
    priority,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders
    },
    condition: {
      ...toDnrUrlCondition(pattern),
      ...(excludedDomains.length > 0 ? { excludedRequestDomains: excludedDomains } : {}),
      ...(excludedDomains.length > 0 ? { excludedInitiatorDomains: excludedDomains } : {}),
      resourceTypes: RESOURCE_TYPES
    }
  };
}

function createInitiatorRule(domain: string, index: number, excludedDomains: string[], responseHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[], priority: number): chrome.declarativeNetRequest.Rule {
  return {
    id: INITIATOR_RULE_ID_BASE + index,
    priority,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders
    },
    condition: {
      urlFilter: '|http',
      initiatorDomains: [domain],
      ...(excludedDomains.length > 0 ? { excludedRequestDomains: excludedDomains } : {}),
      ...(excludedDomains.length > 0 ? { excludedInitiatorDomains: excludedDomains } : {}),
      resourceTypes: RESOURCE_TYPES
    }
  };
}

function createResponseHeaders(methods: string[], allowAllHeaders: boolean, allowCredentials: boolean, origin: string | null): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  const headers: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
    { header: 'access-control-allow-origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: origin ?? '*' },
    { header: 'access-control-allow-methods', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: methods.join(', ') }
  ];

  if (allowAllHeaders) {
    headers.push({ header: 'access-control-allow-headers', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: '*' });
  }

  if (allowCredentials) {
    headers.push({ header: 'access-control-allow-credentials', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'true' });
  }

  return headers;
}

function getPatternOrigin(pattern: string): string | null {
  const match = /^(https?):\/\/([^/]+)\//.exec(pattern);
  return match?.[1] && match[2] ? `${match[1]}://${match[2]}` : null;
}

// Uses the same regex as the shared matcher so Chrome and Firefox agree on what a pattern covers.
function toDnrUrlCondition(pattern: string): Pick<chrome.declarativeNetRequest.RuleCondition, 'urlFilter' | 'regexFilter' | 'isUrlFilterCaseSensitive'> {
  if (pattern === '<all_urls>') {
    return { urlFilter: '|http' };
  }

  return { regexFilter: toUrlPatternRegExpSource(pattern), isUrlFilterCaseSensitive: true };
}

function toInitiatorDomain(pattern: string): string | null {
  return getPatternHost(pattern)?.replace(/^\*\./, '') ?? null;
}

function getExcludedDomains(patterns: string[]): string[] {
  return patterns
    .map(toInitiatorDomain)
    .filter((domain): domain is string => Boolean(domain));
}
