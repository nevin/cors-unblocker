export type CorsMode = 'global' | 'whitelist';
export type ThemeMode = 'light' | 'dark' | 'system';
export type DomainRuleType = 'first_party' | 'third_party' | 'both';

export interface DomainRule {
  pattern: string;
  type: DomainRuleType;
}

// One unblocked call: requests to `target`, made by pages matching `from`. Nothing else on that page
// or that API is affected, so some requests can be relaxed while others keep normal CORS.
export interface CallRule {
  target: string;
  from: string;
}

export interface RulesExport {
  version: 1;
  whitelist: string[];
  skiplist: string[];
  domainRules: DomainRule[];
  allowMethods: string[];
  methodOverrides: Record<string, string[]>;
  allowAllHeaders: boolean;
  allowCredentials: boolean;
  anyOriginTargets?: string[];
  respectServerCors?: boolean;
  exposeAllHeaders?: boolean;
  callRules?: CallRule[];
}

export interface ExtensionSettings {
  enabled: boolean;
  mode: CorsMode;
  whitelist: string[];
  skiplist: string[];
  allowMethods: string[];
  methodOverrides: Record<string, string[]>;
  theme: ThemeMode;
  allowAllHeaders: boolean;
  allowCredentials: boolean;
  domainRules: DomainRule[];
  // Rule patterns whose responses are relaxed for requests from any site, not just from trusted pages.
  anyOriginTargets: string[];
  // Leave responses alone when the server already sent Access-Control-Allow-Origin, so APIs that
  // handle CORS themselves (including credentialed ones) keep working on a trusted page.
  respectServerCors: boolean;
  // Watch cross-origin API calls for CORS failures and report them per tab, even while overrides are off.
  detectCorsIssues: boolean;
  // Let pages read every response header (such as X-Total-Count), not just the CORS-safelisted few.
  exposeAllHeaders: boolean;
  // While paused, overrides are off (enabled is false) until this time, when the background turns them back on.
  pausedUntil: number | null;
  // Individually unblocked calls: one API URL pattern, from one page.
  callRules: CallRule[];
  // What the organization's browser policy enforces. Never stored: loadSettings() fills it in from
  // managed storage on every load, and the stored settings stay the user's own.
  policy: AdminPolicy;
}

// Settings an IT administrator enforces through browser policy (see docs/enterprise-policy.md).
export interface AdminPolicy {
  // Overrides stay off and cannot be switched on. Detection of blocked calls keeps working.
  overridesOff: boolean;
  // Pages trusted for everyone, on top of the user's own; they cannot be edited or removed.
  trustedPages: string[];
  // "Every website" mode is unavailable; only trusted pages and unblocked calls get relaxed CORS.
  everyWebsiteBlocked: boolean;
}

export const NO_POLICY: AdminPolicy = { overridesOff: false, trustedPages: [], everyWebsiteBlocked: false };

export type EffectiveCorsRule =
  | { state: 'active'; source: 'global'; pattern: '<all_urls>' }
  | { state: 'active'; source: 'pattern'; pattern: string }
  | { state: 'active'; source: 'domain'; pattern: string; domainType: DomainRuleType }
  | { state: 'active'; source: 'call'; pattern: string; from: string }
  | { state: 'skipped'; source: 'skip'; pattern: string }
  | { state: 'inactive'; source: 'disabled' | 'none' };

export const DEFAULT_ALLOW_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const ALLOWED_METHODS = new Set(DEFAULT_ALLOW_METHODS);

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  mode: 'whitelist',
  whitelist: [],
  skiplist: [],
  allowMethods: DEFAULT_ALLOW_METHODS,
  methodOverrides: {}
  ,theme: 'system'
  ,allowAllHeaders: false
  ,allowCredentials: false
  ,domainRules: []
  ,anyOriginTargets: []
  ,respectServerCors: true
  ,detectCorsIssues: true
  ,exposeAllHeaders: true
  ,pausedUntil: null
  ,callRules: []
  ,policy: NO_POLICY
};

export const SETTINGS_KEY = 'corsDevControlSettings';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizePattern(input: string): string | null {
  const value = input.trim();

  if (!value) {
    return null;
  }

  if (value === '<all_urls>') {
    return value;
  }

  if (value.includes('*://') || /^(?:\*|https?):\/\/[^/]*\*/.test(value)) {
    const browserPattern = /^(?:\*|https?):\/\/\*\.[^/]+$/.test(value) ? `${value}/*` : value;
    return normalizeBrowserMatchPattern(browserPattern);
  }

  if (value.startsWith('*.')) {
    return `*://*.${value.slice(2).replace(/\/$/, '')}/*`;
  }

  if (!value.includes('://')) {
    return `*://${value.replace(/\/$/, '')}/*`;
  }

  return normalizeUrlLikePattern(value);
}

export function normalizePatterns(inputs: string[]): string[] {
  const normalized = inputs
    .map(normalizePattern)
    .filter((value): value is string => Boolean(value));

  return [...new Set(normalized)];
}

export function normalizeWhitelistPatterns(inputs: string[]): string[] {
  return normalizePatterns(inputs).filter((pattern) => pattern !== '<all_urls>');
}

export function normalizeAllowMethods(inputs: string[]): string[] {
  return [...new Set(inputs.map((method) => method.trim().toUpperCase()).filter((method) => ALLOWED_METHODS.has(method)))];
}

export function normalizeMethodOverrides(value: Record<string, string[]> | undefined): Record<string, string[]> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(Object.entries(value).flatMap(([pattern, methods]) => {
    const normalizedPattern = normalizeMethodOverridePattern(pattern);
    const normalizedMethods = Array.isArray(methods) ? normalizeAllowMethods(methods) : [];
    return normalizedPattern && normalizedMethods.length > 0 ? [[normalizedPattern, normalizedMethods]] : [];
  }));
}

export function normalizeMethodOverridePattern(input: string): string | null {
  const value = input.trim();
  try {
    const url = new URL(value);
    if (ALLOWED_PROTOCOLS.has(url.protocol) && url.search) {
      return url.toString();
    }
  } catch {
    // Fall through to standard browser match-pattern normalization.
  }

  return normalizePattern(value);
}

export function normalizeDomainRules(value: DomainRule[] | undefined): DomainRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules = value.flatMap((rule) => {
    const pattern = normalizePattern(rule.pattern);
    const type = rule.type === 'first_party' || rule.type === 'third_party' || rule.type === 'both' ? rule.type : null;
    return pattern && type ? [{ pattern, type }] : [];
  });

  return [...new Map(rules.map((rule) => [`${rule.type}|${rule.pattern}`, rule])).values()];
}

export function exportRules(settings: ExtensionSettings): string {
  const rules: RulesExport = {
    version: 1,
    whitelist: settings.whitelist,
    skiplist: settings.skiplist,
    domainRules: settings.domainRules,
    allowMethods: settings.allowMethods,
    methodOverrides: settings.methodOverrides,
    allowAllHeaders: settings.allowAllHeaders,
    allowCredentials: settings.allowCredentials,
    anyOriginTargets: settings.anyOriginTargets,
    respectServerCors: settings.respectServerCors,
    exposeAllHeaders: settings.exposeAllHeaders,
    callRules: settings.callRules
  };

  return `${JSON.stringify(rules, null, 2)}\n`;
}

export function importRules(value: string): Partial<ExtensionSettings> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Unsupported rules file.');
  }

  const rules = parsed as Partial<RulesExport>;
  return {
    whitelist: Array.isArray(rules.whitelist) ? rules.whitelist : [],
    skiplist: Array.isArray(rules.skiplist) ? rules.skiplist : [],
    domainRules: Array.isArray(rules.domainRules) ? rules.domainRules : [],
    allowMethods: Array.isArray(rules.allowMethods) ? rules.allowMethods : DEFAULT_ALLOW_METHODS,
    methodOverrides: rules.methodOverrides && typeof rules.methodOverrides === 'object' ? rules.methodOverrides : {},
    allowAllHeaders: rules.allowAllHeaders === true,
    allowCredentials: rules.allowCredentials === true,
    anyOriginTargets: Array.isArray(rules.anyOriginTargets) ? rules.anyOriginTargets : [],
    respectServerCors: rules.respectServerCors !== false,
    exposeAllHeaders: rules.exposeAllHeaders !== false,
    callRules: Array.isArray(rules.callRules) ? rules.callRules : []
  };
}

// The rule that makes a blocked request work: trust the page that made it, or the URL itself when
// nothing initiated it (top-level navigations, which CORS does not apply to anyway).
export function getTrustPatternForRequest(url: string, initiatorUrl: string | null | undefined): string | null {
  if (initiatorUrl) {
    try {
      const initiator = new URL(initiatorUrl);
      if (ALLOWED_PROTOCOLS.has(initiator.protocol)) {
        return normalizePattern(`${initiator.origin}/*`);
      }
    } catch {
      // Fall back to the request URL below.
    }
  }

  return normalizePattern(url);
}

export function isValidPattern(input: string): boolean {
  return normalizePattern(input) !== null;
}

export function mergeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    mode: value?.mode === 'global' || value?.mode === 'whitelist' ? value.mode : DEFAULT_SETTINGS.mode,
    whitelist: Array.isArray(value?.whitelist) ? normalizeWhitelistPatterns(value.whitelist) : DEFAULT_SETTINGS.whitelist,
    skiplist: Array.isArray(value?.skiplist) ? normalizeWhitelistPatterns(value.skiplist) : DEFAULT_SETTINGS.skiplist,
    allowMethods: Array.isArray(value?.allowMethods) && normalizeAllowMethods(value.allowMethods).length > 0
      ? normalizeAllowMethods(value.allowMethods)
      : DEFAULT_SETTINGS.allowMethods,
    methodOverrides: normalizeMethodOverrides(value?.methodOverrides)
    ,theme: value?.theme === 'light' || value?.theme === 'dark' || value?.theme === 'system' ? value.theme : DEFAULT_SETTINGS.theme
    ,allowAllHeaders: typeof value?.allowAllHeaders === 'boolean' ? value.allowAllHeaders : DEFAULT_SETTINGS.allowAllHeaders
    ,allowCredentials: typeof value?.allowCredentials === 'boolean' ? value.allowCredentials : DEFAULT_SETTINGS.allowCredentials
    ,domainRules: normalizeDomainRules(value?.domainRules)
    ,anyOriginTargets: normalizeAnyOriginTargets(value)
    ,respectServerCors: typeof value?.respectServerCors === 'boolean' ? value.respectServerCors : DEFAULT_SETTINGS.respectServerCors
    ,detectCorsIssues: typeof value?.detectCorsIssues === 'boolean' ? value.detectCorsIssues : DEFAULT_SETTINGS.detectCorsIssues
    ,exposeAllHeaders: typeof value?.exposeAllHeaders === 'boolean' ? value.exposeAllHeaders : DEFAULT_SETTINGS.exposeAllHeaders
    // Switching on ends any pause.
    ,pausedUntil: value?.enabled !== true && typeof value?.pausedUntil === 'number' && value.pausedUntil > 0 ? value.pausedUntil : null
    ,callRules: normalizeCallRules(value?.callRules)
    ,policy: normalizeAdminPolicy(value?.policy)
  };
}

export function normalizeAdminPolicy(value: Partial<AdminPolicy> | undefined): AdminPolicy {
  if (!value || typeof value !== 'object') {
    return NO_POLICY;
  }
  return {
    overridesOff: value.overridesOff === true,
    trustedPages: Array.isArray(value.trustedPages) ? normalizeWhitelistPatterns(value.trustedPages.filter((page): page is string => typeof page === 'string')) : [],
    everyWebsiteBlocked: value.everyWebsiteBlocked === true
  };
}

// Managed storage keys, as administrators write them (policy-schema.json describes them).
export function policyFromManagedStorage(managed: Record<string, unknown>): AdminPolicy {
  return normalizeAdminPolicy({
    overridesOff: managed.disableOverrides === true,
    trustedPages: Array.isArray(managed.trustedPages) ? managed.trustedPages as string[] : [],
    everyWebsiteBlocked: managed.blockEveryWebsiteMode === true
  });
}

export function hasAdminPolicy(policy: AdminPolicy): boolean {
  return policy.overridesOff || policy.everyWebsiteBlocked || policy.trustedPages.length > 0;
}

// The settings in effect: the user's own, with the organization's policy enforced on top.
export function applyAdminPolicy(settings: ExtensionSettings, policy: AdminPolicy): ExtensionSettings {
  return mergeSettings({
    ...settings,
    ...(policy.overridesOff ? { enabled: false, pausedUntil: null } : {}),
    ...(policy.everyWebsiteBlocked ? { mode: 'whitelist' as const } : {}),
    whitelist: [...policy.trustedPages, ...settings.whitelist],
    policy
  });
}

// The user's own part of a settings change: the policy is never stored, and pages the policy trusts
// stay out of the user's list, so they disappear when the administrator removes them.
export function withoutAdminPolicy(next: Partial<ExtensionSettings>, policy: AdminPolicy): Partial<ExtensionSettings> {
  const { policy: _ignored, ...own } = next;
  if (own.whitelist && policy.trustedPages.length > 0) {
    const managed = new Set(policy.trustedPages);
    own.whitelist = own.whitelist.filter((pattern) => !managed.has(normalizePattern(pattern) ?? pattern));
  }
  return own;
}

// Keeps only opt-ins for rules that still exist, so removing or renaming a rule drops its opt-in.
function normalizeAnyOriginTargets(value: Partial<ExtensionSettings> | undefined): string[] {
  if (!Array.isArray(value?.anyOriginTargets)) {
    return [];
  }

  const rulePatterns = new Set([
    ...(Array.isArray(value.whitelist) ? normalizeWhitelistPatterns(value.whitelist) : []),
    ...normalizeDomainRules(value.domainRules).map((rule) => rule.pattern)
  ]);
  return normalizePatterns(value.anyOriginTargets).filter((pattern) => rulePatterns.has(pattern));
}

export function normalizeCallRules(value: CallRule[] | undefined): CallRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules = value.flatMap((rule) => {
    const target = normalizePattern(String(rule?.target ?? ''));
    const from = normalizePattern(String(rule?.from ?? ''));
    return target && from && target !== '<all_urls>' && from !== '<all_urls>' ? [{ target, from }] : [];
  });
  return [...new Map(rules.map((rule) => [`${rule.from} ${rule.target}`, rule])).values()];
}

// The call rule that unblocks exactly this request from this page: the request URL (path included,
// query dropped) as the target, and the page's origin as `from`.
export function getCallRuleForRequest(url: string, initiatorUrl: string | null | undefined): CallRule | null {
  if (!initiatorUrl) {
    return null;
  }
  try {
    const request = new URL(url);
    const target = normalizePattern(`${request.origin}${request.pathname}`);
    const from = getTrustPatternForRequest(url, initiatorUrl);
    return target && from && from !== normalizePattern(url) ? { target, from } : null;
  } catch {
    return null;
  }
}

export function matchesCallRule(url: string, initiatorUrl: string | undefined, rule: CallRule): boolean {
  return Boolean(initiatorUrl) && matchesUrlPattern(url, rule.target) && matchesUrlPattern(initiatorUrl ?? '', rule.from);
}

// How a pattern reads to people: 'http://localhost:3000/*' becomes 'localhost:3000'. Schemes and
// trailing wildcards are syntax, not meaning, for the sites people trust day to day.
export function formatPatternForPeople(pattern: string): string {
  if (pattern === '<all_urls>') {
    return 'every website';
  }

  const match = /^(?:\*|https?|file):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!match) {
    return pattern;
  }

  const path = match[2] ?? '';
  return `${match[1] ?? ''}${path === '/*' || path === '/' ? '' : path.replace(/\/\*$/, '')}`;
}

export function getActivePatterns(settings: ExtensionSettings): string[] {
  if (!settings.enabled) {
    return [];
  }

  // Global mode already relaxes everything; its pattern rules still decide which allowed methods apply.
  if (settings.mode === 'global') {
    return ['<all_urls>', ...normalizePatterns([...settings.whitelist, ...settings.domainRules.map((rule) => rule.pattern)])];
  }

  return normalizePatterns([...settings.whitelist, ...settings.domainRules.map((rule) => rule.pattern)]);
}

export function isCorsEnabledForRequest(url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): boolean {
  if (!settings.enabled || settings.skiplist.some((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))) {
    return false;
  }

  if (settings.mode === 'global') {
    return true;
  }

  return settings.whitelist.some((pattern) => matchesActiveRule(url, initiatorUrl, pattern, settings))
    || settings.domainRules.some((rule) => matchesDomainRule(url, initiatorUrl, rule, settings))
    || settings.callRules.some((rule) => matchesCallRule(url, initiatorUrl, rule));
}

export function isCorsSkippedForRequest(url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): boolean {
  return settings.skiplist.some((pattern) => matchesRequestPattern(url, initiatorUrl, pattern));
}

export function getEffectiveCorsRuleForRequest(url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): EffectiveCorsRule {
  if (!settings.enabled) {
    return { state: 'inactive', source: 'disabled' };
  }

  const skippedPattern = findMostSpecificPattern(settings.skiplist, url, initiatorUrl);
  if (skippedPattern) {
    return { state: 'skipped', source: 'skip', pattern: skippedPattern };
  }

  if (settings.mode === 'global') {
    return { state: 'active', source: 'global', pattern: '<all_urls>' };
  }

  const callRule = settings.callRules
    .filter((rule) => matchesCallRule(url, initiatorUrl, rule))
    .sort((left, right) => right.target.length - left.target.length)[0];
  const activePattern = settings.whitelist
    .filter((pattern) => matchesActiveRule(url, initiatorUrl, pattern, settings))
    .sort((left, right) => right.length - left.length)[0];
  // The more specific of the two explains the request best, as in getAllowedMethodsForRequest.
  if (callRule && (!activePattern || callRule.target.length >= activePattern.length)) {
    return { state: 'active', source: 'call', pattern: callRule.target, from: callRule.from };
  }
  if (activePattern) {
    return { state: 'active', source: 'pattern', pattern: activePattern };
  }

  const domainRule = settings.domainRules
    .filter((rule) => matchesDomainRule(url, initiatorUrl, rule, settings))
    .sort((left, right) => right.pattern.length - left.pattern.length)[0];
  if (domainRule) {
    return { state: 'active', source: 'domain', pattern: domainRule.pattern, domainType: domainRule.type };
  }

  return { state: 'inactive', source: 'none' };
}

// Methods come from the most specific rule that relaxed this request. A method override on a URL that is
// not itself a rule (such as a query-specific URL) refines whichever rule relaxed a request to that URL.
// Individual rules outrank domain rules; within each, the longer pattern wins. Chrome's DNR priorities
// in dnrRules.ts encode the same order.
export function getAllowedMethodsForRequest(url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): string[] {
  const rulePatterns = new Set([...settings.whitelist, ...settings.domainRules.map((rule) => rule.pattern), ...settings.callRules.map((rule) => rule.target)]);
  const individualCandidates = [
    ...settings.whitelist.filter((pattern) => matchesActiveRule(url, initiatorUrl, pattern, settings)),
    ...settings.callRules.filter((rule) => matchesCallRule(url, initiatorUrl, rule)).map((rule) => rule.target),
    ...Object.keys(settings.methodOverrides).filter((pattern) => !rulePatterns.has(pattern) && matchesUrlPattern(url, pattern))
  ].sort((left, right) => right.length - left.length);
  const domainCandidates = settings.domainRules
    .filter((rule) => matchesDomainRule(url, initiatorUrl, rule, settings))
    .map((rule) => rule.pattern)
    .sort((left, right) => right.length - left.length);
  const matchingPattern = individualCandidates[0] ?? domainCandidates[0];
  return matchingPattern ? settings.methodOverrides[matchingPattern] ?? settings.allowMethods : settings.allowMethods;
}

export function isRequestMethodAllowed(method: string, url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): boolean {
  if (!isCorsEnabledForRequest(url, initiatorUrl, settings)) {
    return true;
  }

  return getAllowedMethodsForRequest(url, initiatorUrl, settings).includes(method.toUpperCase());
}

// The single origin a pattern names, such as 'http://localhost:3000' for 'http://localhost:3000/*'.
// Credentialed responses must name the page's exact origin, so only these patterns can serve them.
export function getExplicitPatternOrigin(pattern: string): string | null {
  const match = /^(https?):\/\/([^/*]+)\//.exec(pattern);
  return match?.[1] && match[2] ? `${match[1]}://${match[2]}` : null;
}

export function isCredentialsSupported(settings: ExtensionSettings): boolean {
  if (settings.mode === 'global') {
    return false;
  }

  return [...settings.whitelist, ...settings.domainRules.map((rule) => rule.pattern), ...settings.callRules.map((rule) => rule.from)]
    .some((pattern) => /^(https?):\/\/[^/*]+\//.test(pattern));
}

export function isAnyOriginTarget(pattern: string, settings: ExtensionSettings): boolean {
  return settings.anyOriginTargets.includes(pattern);
}

// A rule trusts the pages it matches: their requests are relaxed whatever they call. The rule's own
// responses are relaxed for other sites only when the user opted that rule in to any-origin reads.
function matchesActiveRule(url: string, initiatorUrl: string | undefined, pattern: string, settings: ExtensionSettings): boolean {
  return Boolean(initiatorUrl && matchesUrlPattern(initiatorUrl, pattern))
    || (isAnyOriginTarget(pattern, settings) && matchesUrlPattern(url, pattern));
}

function matchesRequestPattern(url: string, initiatorUrl: string | undefined, pattern: string): boolean {
  return matchesUrlPattern(url, pattern) || Boolean(initiatorUrl && matchesUrlPattern(initiatorUrl, pattern));
}

function findMostSpecificPattern(patterns: string[], url: string, initiatorUrl: string | undefined): string | undefined {
  return patterns
    .filter((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))
    .sort((left, right) => right.length - left.length)[0];
}

function matchesDomainRule(url: string, initiatorUrl: string | undefined, rule: DomainRule, settings: ExtensionSettings): boolean {
  const destinationMatches = isAnyOriginTarget(rule.pattern, settings) && matchesUrlPattern(url, rule.pattern);
  const initiatorMatches = Boolean(initiatorUrl && matchesUrlPattern(initiatorUrl, rule.pattern));
  const crossOrigin = Boolean(initiatorUrl && getOrigin(url) !== getOrigin(initiatorUrl));

  if (rule.type === 'first_party') {
    return destinationMatches;
  }
  if (rule.type === 'third_party') {
    return initiatorMatches && crossOrigin;
  }
  return destinationMatches || initiatorMatches;
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function matchesUrlPattern(url: string, pattern: string): boolean {
  return new RegExp(toUrlPatternRegExpSource(pattern)).test(url);
}

// Shared by the in-page matcher and Chrome's DNR regexFilter, so keep the output RE2-compatible (no lookarounds).
// Host wildcards never cross '/', so a host pattern cannot be satisfied by text in the path or query.
export function toUrlPatternRegExpSource(pattern: string): string {
  if (pattern === '<all_urls>') {
    return '^(?:https?|file)://.*$';
  }

  const match = /^(\*|https?|file):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!match) {
    return `^${escapeRegExp(pattern)}$`;
  }

  const scheme = match[1] === '*' ? 'https?' : escapeRegExp(match[1] ?? '');
  return `^${scheme}://${toHostRegExpSource(match[2] ?? '')}${toPathRegExpSource(match[3] ?? '')}$`;
}

function toHostRegExpSource(host: string): string {
  if (host === '*') {
    return '[^/]*';
  }

  const hasPort = /:\d+$/.test(host);
  const subdomainPrefix = host.startsWith('*.') ? '(?:[^/:]+\\.)?' : '';
  const hostBody = (subdomainPrefix ? host.slice(2) : host)
    .split('*')
    .map(escapeRegExp)
    .join('[^/:]*');

  // Like browser match patterns, a host without an explicit port matches any port.
  return `${subdomainPrefix}${hostBody}${hasPort ? '' : '(?::\\d+)?'}`;
}

function toPathRegExpSource(path: string): string {
  const toWildcardSource = (value: string) => value.split('*').map(escapeRegExp).join('.*');

  // 'https://host/api/*' covers '/api' itself (with or without a query string) and everything below
  // it, but not '/apiX'.
  if (path.endsWith('/*')) {
    return `${toWildcardSource(path.slice(0, -2))}(?:[/?].*)?`;
  }

  return toWildcardSource(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getPatternHost(pattern: string): string | null {
  const match = /^(?:\*|https?):\/\/([^/]+)\//.exec(pattern);
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/:\d+$/, '');
}

function normalizeUrlLikePattern(value: string): string | null {
  try {
    const url = new URL(value);

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return null;
    }

    const path = url.pathname === '/' && !value.endsWith('/')
      ? '/*'
      : url.pathname.endsWith('/*')
        ? url.pathname
        : `${url.pathname.replace(/\/$/, '')}/*`;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

function normalizeBrowserMatchPattern(value: string): string | null {
  const match = /^(\*|https?|file):\/\/([^/]+|\*)\/(.*)$/.exec(value);

  if (!match) {
    return null;
  }

  const scheme = match[1];
  const host = match[2];
  const path = match[3]
    ? match[3].endsWith('*') ? match[3] : `${match[3]}/*`
    : '*';

  if (!scheme || !host || !path) {
    return null;
  }

  if (scheme === 'file') {
    return `file:///${path}`;
  }

  return `${scheme}://${host}/${path}`;
}
