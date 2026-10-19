import { ExtensionSettings, formatPatternForPeople, getAllowedMethodsForRequest, getCallRuleForRequest, getExplicitPatternOrigin, getTrustPatternForRequest, matchesCallRule, isCorsEnabledForRequest, isCorsSkippedForRequest, mergeSettings } from './settings.js';

export interface HttpHeader {
  name: string;
  value?: string | undefined;
}

// What the browser sent: enough to tell a CORS request from any other, and what a preflight asked for.
export interface CorsRequest {
  url: string;
  method: string;
  origin: string | null;
  fetchMode: string | null;
  requestedMethod: string | null;
  requestedHeaders: string[];
  // Browsers attach cookies to a cross-origin CORS request only in credentials mode, so a Cookie
  // header marks a credentialed call. Credentialed calls without cookies cannot be told apart.
  credentialed: boolean;
}

export type CorsProblemReason = 'missing-allow-origin' | 'origin-mismatch' | 'credentials-wildcard' | 'credentials-not-allowed' | 'preflight-status' | 'method-not-allowed' | 'headers-not-allowed';

export interface CorsProblem {
  reason: CorsProblemReason;
  detail: string | null;
}

export type CorsFix =
  | { kind: 'enable' }
  | { kind: 'trust-page'; pattern: string }
  | { kind: 'allow-call'; target: string; from: string }
  | { kind: 'allow-method'; method: string }
  | { kind: 'allow-headers' }
  | { kind: 'allow-credentials' }
  | { kind: 'whitelist-mode' }
  | { kind: 'override-server' };

export type CorsIssueState = 'fixed' | 'blocked' | 'skipped' | 'unfixable';

export interface CorsFixPlan {
  state: CorsIssueState;
  fixes: CorsFix[];
}

// One cross-origin call that needed CORS help. Only calls with a CORS problem are kept, without
// query strings, per tab, in session storage, and cleared when the tab navigates or closes.
export interface CorsIssue {
  key: string;
  url: string;
  pageOrigin: string;
  // The method the page used; for a failed preflight, the method it asked permission for.
  method: string;
  preflight: boolean;
  requestedHeaders: string[];
  credentialed?: boolean;
  problem: CorsProblem;
  serverSentAllowOrigin: boolean;
  count: number;
  lastSeen: number;
}

export type CorsIssuesByTab = Record<string, CorsIssue[]>;

export function toCorsRequest(issue: CorsIssue): CorsRequest {
  return {
    url: issue.url,
    method: issue.preflight ? 'OPTIONS' : issue.method,
    origin: issue.pageOrigin,
    fetchMode: 'cors',
    requestedMethod: issue.preflight ? issue.method : null,
    requestedHeaders: issue.requestedHeaders,
    credentialed: issue.credentialed === true
  };
}

export function planIssueFix(issue: CorsIssue, settings: ExtensionSettings): CorsFixPlan {
  return planCorsFix(toCorsRequest(issue), issue.problem, issue.serverSentAllowOrigin, settings);
}

export function countOpenIssues(issues: CorsIssue[], settings: ExtensionSettings): number {
  return issues.filter((issue) => isOpenCorsIssue(planIssueFix(issue, settings))).length;
}

// Methods and request headers a preflight never has to list (CORS-safelisted).
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);

export function headerValue(headers: HttpHeader[], name: string): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

export function readCorsRequest(url: string, method: string, requestHeaders: HttpHeader[]): CorsRequest {
  return {
    url,
    method: method.toUpperCase(),
    origin: headerValue(requestHeaders, 'origin'),
    fetchMode: headerValue(requestHeaders, 'sec-fetch-mode'),
    requestedMethod: headerValue(requestHeaders, 'access-control-request-method')?.toUpperCase() ?? null,
    requestedHeaders: splitList(headerValue(requestHeaders, 'access-control-request-headers')).map((header) => header.toLowerCase()),
    credentialed: headerValue(requestHeaders, 'cookie') !== null
  };
}

export function isPreflight(request: CorsRequest): boolean {
  return request.method === 'OPTIONS' && Boolean(request.requestedMethod);
}

// The browser only enforces CORS on cross-origin requests in cors mode. Sec-Fetch-Mode says so directly;
// browsers omit it for non-secure origins, where an Origin header from another origin is the signal.
export function isCorsRequest(request: CorsRequest): boolean {
  if (!request.origin || (request.fetchMode && request.fetchMode !== 'cors')) {
    return false;
  }

  try {
    return new URL(request.url).origin !== request.origin;
  } catch {
    return false;
  }
}

// Runs the browser's CORS checks against the server's own response headers. Returns null when the
// browser would let the page read the response without any help.
export function findCorsProblem(request: CorsRequest, statusCode: number, responseHeaders: HttpHeader[]): CorsProblem | null {
  const preflight = isPreflight(request);
  if (preflight && (statusCode < 200 || statusCode > 299)) {
    return { reason: 'preflight-status', detail: String(statusCode) };
  }

  const allowOrigin = headerValue(responseHeaders, 'access-control-allow-origin')?.trim();
  if (!allowOrigin) {
    return { reason: 'missing-allow-origin', detail: null };
  }
  if (allowOrigin !== '*' && allowOrigin !== request.origin) {
    return { reason: 'origin-mismatch', detail: allowOrigin };
  }

  if (request.credentialed && !preflight) {
    if (allowOrigin === '*') {
      return { reason: 'credentials-wildcard', detail: null };
    }
    if (headerValue(responseHeaders, 'access-control-allow-credentials')?.trim() !== 'true') {
      return { reason: 'credentials-not-allowed', detail: null };
    }
  }

  if (preflight && request.requestedMethod) {
    const allowedMethods = splitList(headerValue(responseHeaders, 'access-control-allow-methods')).map((method) => method.toUpperCase());
    if (!SIMPLE_METHODS.has(request.requestedMethod) && !allowedMethods.includes(request.requestedMethod) && !allowedMethods.includes('*')) {
      return { reason: 'method-not-allowed', detail: request.requestedMethod };
    }

    const allowedHeaders = splitList(headerValue(responseHeaders, 'access-control-allow-headers')).map((header) => header.toLowerCase());
    // A '*' wildcard never covers Authorization, which has to be listed by name.
    const missingHeaders = request.requestedHeaders.filter((header) => !allowedHeaders.includes(header)
      && !(allowedHeaders.includes('*') && header !== 'authorization'));
    if (missingHeaders.length > 0) {
      return { reason: 'headers-not-allowed', detail: missingHeaders.join(', ') };
    }
  }

  return null;
}

// Decides whether the current settings make the extension fix this problem and, if not, which
// settings changes would. A non-2xx preflight cannot be fixed by adding headers.
export function planCorsFix(request: CorsRequest, problem: CorsProblem, serverSentAllowOrigin: boolean, settings: ExtensionSettings): CorsFixPlan {
  if (problem.reason === 'preflight-status') {
    return { state: 'unfixable', fixes: [] };
  }

  const initiator = request.origin ?? undefined;
  if (isCorsSkippedForRequest(request.url, initiator, settings)) {
    return { state: 'skipped', fixes: [] };
  }

  const fixes: CorsFix[] = [];
  if (!settings.enabled) {
    fixes.push({ kind: 'enable' });
  }

  // Unblock just this call from this page; the page's other calls keep their normal CORS behaviour.
  if (!isCorsEnabledForRequest(request.url, initiator, { ...settings, enabled: true })) {
    const callRule = getCallRuleForRequest(request.url, request.origin);
    const pattern = getTrustPatternForRequest(request.url, request.origin);
    if (callRule) {
      fixes.push({ kind: 'allow-call', ...callRule });
    } else if (pattern) {
      fixes.push({ kind: 'trust-page', pattern });
    }
  }

  if (serverSentAllowOrigin && settings.respectServerCors) {
    fixes.push({ kind: 'override-server' });
  }

  // Credentialed calls need the page's exact origin echoed back with Allow-Credentials, which only
  // whitelist mode does, and only for pages trusted by their exact origin.
  if (request.credentialed && request.origin) {
    if (settings.mode === 'global') {
      fixes.push({ kind: 'whitelist-mode' });
    }
    if (!settings.allowCredentials) {
      fixes.push({ kind: 'allow-credentials' });
    }
    const callRule = getCallRuleForRequest(request.url, request.origin);
    const trustedExactly = settings.whitelist.some((pattern) => getExplicitPatternOrigin(pattern) === request.origin)
      || settings.callRules.some((rule) => getExplicitPatternOrigin(rule.from) === request.origin && matchesCallRule(request.url, initiator, rule));
    if (callRule && !trustedExactly && !fixes.some((fix) => fix.kind === 'trust-page' || fix.kind === 'allow-call')) {
      fixes.push({ kind: 'allow-call', ...callRule });
    }
  }

  if (isPreflight(request) && request.requestedMethod && !SIMPLE_METHODS.has(request.requestedMethod)) {
    const fixed = mergeSettings({ ...settings, ...applyCorsFixes(settings, fixes) });
    if (!getAllowedMethodsForRequest(request.url, initiator, fixed).includes(request.requestedMethod)) {
      fixes.push({ kind: 'allow-method', method: request.requestedMethod });
    }
  }

  if (isPreflight(request) && request.requestedHeaders.length > 0 && !settings.allowAllHeaders) {
    fixes.push({ kind: 'allow-headers' });
  }

  return { state: fixes.length > 0 ? 'blocked' : 'fixed', fixes };
}

// The settings change that applies the given fixes, ready for SettingsController.update().
export function applyCorsFixes(settings: ExtensionSettings, fixes: CorsFix[]): Partial<ExtensionSettings> {
  const next: Partial<ExtensionSettings> = {};
  fixes.forEach((fix) => {
    switch (fix.kind) {
      case 'enable':
        next.enabled = true;
        break;
      case 'trust-page':
        next.whitelist = [...new Set([...(next.whitelist ?? settings.whitelist), fix.pattern])];
        next.skiplist = (next.skiplist ?? settings.skiplist).filter((pattern) => pattern !== fix.pattern);
        break;
      case 'allow-call': {
        const callRules = [...(next.callRules ?? settings.callRules), { target: fix.target, from: fix.from }];
        next.callRules = [...new Map(callRules.map((rule) => [`${rule.from} ${rule.target}`, rule])).values()];
        break;
      }
      case 'allow-method':
        next.allowMethods = [...new Set([...(next.allowMethods ?? settings.allowMethods), fix.method])];
        break;
      case 'allow-headers':
        next.allowAllHeaders = true;
        break;
      case 'allow-credentials':
        next.allowCredentials = true;
        break;
      case 'whitelist-mode':
        next.mode = 'whitelist';
        break;
      case 'override-server':
        next.respectServerCors = false;
        break;
    }
  });
  return next;
}

export interface PlannedCorsIssue extends CorsFixPlan {
  issue: CorsIssue;
}

export function planCorsIssues(issues: CorsIssue[], settings: ExtensionSettings): PlannedCorsIssue[] {
  return issues.map((issue) => ({ issue, ...planIssueFix(issue, settings) }));
}

export function isOpenCorsIssue({ state }: CorsFixPlan): boolean {
  return state === 'blocked' || state === 'unfixable';
}

// The deduplicated fixes for every blocked call. Server-header overrides are left out unless asked for,
// because they change behavior on every trusted page and deserve their own confirmation.
export function collectCorsFixes(planned: PlannedCorsIssue[], { includeOverride = false } = {}): CorsFix[] {
  const fixes = new Map<string, CorsFix>();
  planned
    .filter(({ state }) => state === 'blocked')
    .flatMap(({ fixes: issueFixes }) => issueFixes)
    .filter((fix) => includeOverride || fix.kind !== 'override-server')
    .forEach((fix) => fixes.set(JSON.stringify(fix), fix));
  return [...fixes.values()];
}

export function describeCorsCall(issue: CorsIssue): string {
  let path = issue.url;
  try {
    path = new URL(issue.url).pathname;
  } catch {
    // Keep the full URL.
  }
  return `${issue.preflight ? 'Preflight for ' : ''}${issue.method} ${path}`;
}

// A few words for tight spaces such as the popup; describeCorsProblem() gives the full explanation.
export function summarizeCorsProblem(problem: CorsProblem): string {
  switch (problem.reason) {
    case 'missing-allow-origin':
      return 'No Access-Control-Allow-Origin header';
    case 'origin-mismatch':
      return `Server only allows ${problem.detail ?? 'another origin'}`;
    case 'credentials-wildcard':
      return 'Sends cookies, but the server allows *';
    case 'credentials-not-allowed':
      return 'Sends cookies, but no Allow-Credentials';
    case 'preflight-status':
      return `Server answered ${problem.detail ?? 'with an error'}`;
    case 'method-not-allowed':
      return `Preflight rejects ${problem.detail ?? 'the method'}`;
    case 'headers-not-allowed':
      return `Preflight rejects header ${problem.detail ?? ''}`.trim();
  }
}

export function describeCorsProblem(problem: CorsProblem, request: Pick<CorsRequest, 'origin'>): string {
  switch (problem.reason) {
    case 'missing-allow-origin':
      return 'The response has no Access-Control-Allow-Origin header.';
    case 'origin-mismatch':
      return `The server allows ${problem.detail ?? 'another origin'}, not ${request.origin ?? 'this page'}.`;
    case 'credentials-wildcard':
      return 'The call sends cookies, but the server answers Access-Control-Allow-Origin: *, which browsers reject for credentialed calls.';
    case 'credentials-not-allowed':
      return 'The call sends cookies, but the response lacks Access-Control-Allow-Credentials: true.';
    case 'preflight-status':
      return `The server answered the preflight (OPTIONS) request with ${problem.detail ?? 'an error'}. It must return a 2xx status; the extension cannot change status codes.`;
    case 'method-not-allowed':
      return `The preflight does not allow the ${problem.detail ?? 'requested'} method.`;
    case 'headers-not-allowed':
      return `The preflight does not allow these request headers: ${problem.detail ?? 'unknown'}.`;
  }
}

export function describeCorsFix(fix: CorsFix): string {
  switch (fix.kind) {
    case 'enable':
      return 'Turn CORS Unblocker on';
    case 'trust-page':
      return `Trust ${formatPatternForPeople(fix.pattern)}`;
    case 'allow-call':
      return `Unblock ${formatPatternForPeople(fix.target)} for ${formatPatternForPeople(fix.from)}`;
    case 'allow-method':
      return `Allow the ${fix.method} method`;
    case 'allow-headers':
      return 'Allow all request headers';
    case 'allow-credentials':
      return 'Allow credentials (send this page\'s origin instead of *)';
    case 'whitelist-mode':
      return 'Switch to whitelist mode (credentials do not work in global mode)';
    case 'override-server':
      return 'Override CORS headers the server already sends (affects every trusted page)';
  }
}

function splitList(value: string | null): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}
