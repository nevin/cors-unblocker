import { runtimeApi, toLoggedUrl } from './browserApi.js';
import { CorsIssue, CorsIssuesByTab, HttpHeader, countOpenIssues, findCorsProblem, headerValue, isCorsRequest, isPreflight, readCorsRequest } from './corsDiagnosis.js';
import { ExtensionSettings } from './settings.js';

export type { CorsIssue } from './corsDiagnosis.js';

export const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';
const MAX_ISSUES_PER_TAB = 50;
const MAX_PENDING_REQUESTS = 1_000;

export async function loadTabCorsIssues(tabId: number): Promise<CorsIssue[]> {
  const stored = await runtimeApi.storage.session.get(CORS_ISSUES_KEY);
  return (stored[CORS_ISSUES_KEY] as CorsIssuesByTab | undefined)?.[String(tabId)] ?? [];
}

export function onTabCorsIssuesChanged(tabId: number, handler: (issues: CorsIssue[]) => void): void {
  runtimeApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes[CORS_ISSUES_KEY]) {
      handler((changes[CORS_ISSUES_KEY].newValue as CorsIssuesByTab | undefined)?.[String(tabId)] ?? []);
    }
  });
}

interface RequestHeadersDetails {
  requestId: string;
  tabId: number;
  requestHeaders?: HttpHeader[] | undefined;
}

interface ResponseDetails {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  statusCode: number;
  responseHeaders?: HttpHeader[] | undefined;
}

// Runs in the background. Pairs each response with the request headers seen just before it, checks the
// server's own headers the way the browser will, and keeps a per-tab list of calls that needed CORS help.
export class CorsMonitor {
  private issues: CorsIssuesByTab | null = null;
  private loading: Promise<CorsIssuesByTab> | null = null;
  private readonly pendingRequests = new Map<string, HttpHeader[]>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly getSettings: () => ExtensionSettings | null,
    private readonly setBadge: (tabId: number, text: string) => void
  ) {}

  onSendHeaders(details: RequestHeadersDetails): void {
    const requestHeaders = details.requestHeaders ?? [];
    if (details.tabId < 0 || !this.getSettings()?.detectCorsIssues || !headerValue(requestHeaders, 'origin')) {
      return;
    }

    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pendingRequests.keys().next().value;
      if (oldest !== undefined) {
        this.pendingRequests.delete(oldest);
      }
    }
    this.pendingRequests.set(details.requestId, requestHeaders);
  }

  onHeadersReceived(details: ResponseDetails): void {
    const requestHeaders = this.pendingRequests.get(details.requestId);
    this.pendingRequests.delete(details.requestId);
    if (!requestHeaders || !this.getSettings()?.detectCorsIssues) {
      return;
    }

    const request = readCorsRequest(details.url, details.method, requestHeaders);
    if (!isCorsRequest(request)) {
      return;
    }

    const responseHeaders = details.responseHeaders ?? [];
    const problem = findCorsProblem(request, details.statusCode, responseHeaders);
    const url = toLoggedUrl(details.url);
    if (!problem || !url || !request.origin) {
      return;
    }

    const preflight = isPreflight(request);
    const method = preflight ? request.requestedMethod ?? request.method : request.method;
    void this.record(details.tabId, {
      key: `${request.origin} ${preflight ? 'preflight ' : ''}${method} ${url}`,
      url,
      pageOrigin: request.origin,
      method,
      preflight,
      requestedHeaders: request.requestedHeaders,
      problem,
      serverSentAllowOrigin: headerValue(responseHeaders, 'access-control-allow-origin') !== null,
      count: 1,
      lastSeen: Date.now()
    });
  }

  onRequestEnded(requestId: string): void {
    this.pendingRequests.delete(requestId);
  }

  async clearTab(tabId: number): Promise<void> {
    const issues = await this.load();
    if (issues[String(tabId)]) {
      delete issues[String(tabId)];
      this.scheduleFlush();
    }
    this.setBadge(tabId, '');
  }

  // Fixes change which issues are still open, so badges follow every settings change.
  async refreshBadges(): Promise<void> {
    const issues = await this.load();
    Object.keys(issues).forEach((tabId) => this.updateBadge(Number(tabId)));
  }

  private async record(tabId: number, issue: CorsIssue): Promise<void> {
    const issues = await this.load();
    const tabIssues = issues[String(tabId)] ?? [];
    const existing = tabIssues.find((item) => item.key === issue.key);
    const next = existing ? { ...issue, count: existing.count + 1 } : issue;
    issues[String(tabId)] = [next, ...tabIssues.filter((item) => item !== existing)].slice(0, MAX_ISSUES_PER_TAB);
    this.updateBadge(tabId);
    this.scheduleFlush();
  }

  private updateBadge(tabId: number): void {
    const settings = this.getSettings();
    const open = settings ? countOpenIssues(this.issues?.[String(tabId)] ?? [], settings) : 0;
    this.setBadge(tabId, open > 0 ? String(open) : '');
  }

  private load(): Promise<CorsIssuesByTab> {
    if (this.issues) {
      return Promise.resolve(this.issues);
    }
    this.loading ??= runtimeApi.storage.session.get(CORS_ISSUES_KEY).then((stored) => {
      this.issues = (stored[CORS_ISSUES_KEY] as CorsIssuesByTab | undefined) ?? {};
      return this.issues;
    });
    return this.loading;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void runtimeApi.storage.session.set({ [CORS_ISSUES_KEY]: this.issues ?? {} });
    }, 250);
  }
}
