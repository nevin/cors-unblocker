export type CorsMode = 'global' | 'whitelist';
export type ThemeMode = 'light' | 'dark' | 'system';
export type DomainRuleType = 'first_party' | 'third_party' | 'both';

export interface DomainRule {
  pattern: string;
  type: DomainRuleType;
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
}

export type EffectiveCorsRule =
  | { state: 'active'; source: 'global'; pattern: '<all_urls>' }
  | { state: 'active'; source: 'pattern'; pattern: string }
  | { state: 'active'; source: 'domain'; pattern: string; domainType: DomainRuleType }
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
    allowCredentials: settings.allowCredentials
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
    allowCredentials: rules.allowCredentials === true
  };
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
  };
}

export function getActivePatterns(settings: ExtensionSettings): string[] {
  if (!settings.enabled) {
    return [];
  }

  if (settings.mode === 'global') {
    return ['<all_urls>', ...settings.domainRules.map((rule) => rule.pattern)];
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

  return settings.whitelist.some((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))
    || settings.domainRules.some((rule) => matchesDomainRule(url, initiatorUrl, rule));
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

  const activePattern = findMostSpecificPattern(settings.whitelist, url, initiatorUrl);
  if (activePattern) {
    return { state: 'active', source: 'pattern', pattern: activePattern };
  }

  const domainRule = settings.domainRules
    .filter((rule) => matchesDomainRule(url, initiatorUrl, rule))
    .sort((left, right) => right.pattern.length - left.pattern.length)[0];
  if (domainRule) {
    return { state: 'active', source: 'domain', pattern: domainRule.pattern, domainType: domainRule.type };
  }

  return { state: 'inactive', source: 'none' };
}

export function getAllowedMethodsForRequest(url: string, initiatorUrl: string | undefined, settings: ExtensionSettings): string[] {
  const individualPatterns = [...settings.whitelist, ...Object.keys(settings.methodOverrides)];
  const individualCandidates = individualPatterns
    .filter((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))
    .sort((left, right) => right.length - left.length);
  const domainCandidates = settings.domainRules
    .map((rule) => rule.pattern)
    .filter((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))
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

export function isCredentialsSupported(settings: ExtensionSettings): boolean {
  if (settings.mode === 'global') {
    return false;
  }

  return [...settings.whitelist, ...settings.domainRules.map((rule) => rule.pattern)]
    .some((pattern) => /^(https?):\/\/[^/*]+\//.test(pattern));
}

function matchesRequestPattern(url: string, initiatorUrl: string | undefined, pattern: string): boolean {
  return matchesUrlPattern(url, pattern) || Boolean(initiatorUrl && matchesUrlPattern(initiatorUrl, pattern));
}

function findMostSpecificPattern(patterns: string[], url: string, initiatorUrl: string | undefined): string | undefined {
  return patterns
    .filter((pattern) => matchesRequestPattern(url, initiatorUrl, pattern))
    .sort((left, right) => right.length - left.length)[0];
}

function matchesDomainRule(url: string, initiatorUrl: string | undefined, rule: DomainRule): boolean {
  const destinationMatches = matchesUrlPattern(url, rule.pattern);
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

function matchesUrlPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith('/*') && url === pattern.slice(0, -2)) {
    return true;
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
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
