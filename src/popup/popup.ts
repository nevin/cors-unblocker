import { SettingsController, runtimeApi } from '../shared/browserApi';
import { CorsFix, CorsIssue, CorsIssueState, applyCorsFixes, collectCorsFixes, describeCorsCall, describeCorsFix, describeCorsProblem, isOpenCorsIssue, planCorsIssues } from '../shared/corsDiagnosis';
import { loadTabCorsIssues, onTabCorsIssuesChanged } from '../shared/corsMonitor';
import { CorsMode, ExtensionSettings, getTrustPatternForRequest, isCorsEnabledForRequest, isCorsSkippedForRequest } from '../shared/settings';
import { applyTheme } from '../shared/theme';

const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const statusElement = document.querySelector<HTMLElement>('#status');
const noticeElement = document.querySelector<HTMLElement>('#notice');
const manageButton = document.querySelector<HTMLButtonElement>('#manage');
const allowCurrentButton = document.querySelector<HTMLButtonElement>('#allow-current');
const currentSiteElement = document.querySelector<HTMLElement>('#current-site');
const currentCoverageElement = document.querySelector<HTMLElement>('#current-coverage');
const modeWarning = document.querySelector<HTMLElement>('#mode-warning');
const themeSelect = document.querySelector<HTMLSelectElement>('#theme');
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const corsIssuesSection = document.querySelector<HTMLElement>('#cors-issues');
const corsIssuesSummary = document.querySelector<HTMLElement>('#cors-issues-summary');
const corsIssuesList = document.querySelector<HTMLUListElement>('#cors-issues-list');
const corsFixPlan = document.querySelector<HTMLElement>('#cors-fix-plan');
const fixCorsButton = document.querySelector<HTMLButtonElement>('#fix-cors');
const reloadTabButton = document.querySelector<HTMLButtonElement>('#reload-tab');
const overrideServerButton = document.querySelector<HTMLButtonElement>('#override-server');
const MAX_VISIBLE_ISSUE_GROUPS = 5;

let settings: ExtensionSettings;
let currentUrl: string | null = null;
let currentPattern: string | null = null;
let currentTabId: number | null = null;
let corsIssues: CorsIssue[] = [];
// Calls that failed while this popup was open and that the current settings now fix; they need a reload to retry.
const fixedSinceOpen = new Set<string>();
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const settingsController = new SettingsController();

void initialize();

async function initialize(): Promise<void> {
  try {
    const [loadedSettings, currentSite] = await Promise.all([
      settingsController.initialize(),
      getCurrentSite()
    ]);
    settings = loadedSettings;
    currentUrl = currentSite.url;
    currentPattern = currentSite.pattern;
    currentTabId = currentSite.tabId;
    if (currentTabId !== null) {
      const tabId = currentTabId;
      corsIssues = await loadTabCorsIssues(tabId);
      onTabCorsIssuesChanged(tabId, (issues) => {
        corsIssues = issues;
        renderCorsIssues();
      });
    }
    render();
    settingsController.subscribe((nextSettings) => {
      settings = nextSettings;
      render();
    });
  } catch {
    setStatus('Unable to load settings', true);
  }

  enabledInput?.addEventListener('change', () => {
    void updateSettings({ enabled: Boolean(enabledInput.checked) });
  });

  modeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) {
        if (input.value === 'global' && !globalThis.confirm('Enable CORS overrides for every website?')) {
          render();
          return;
        }
        void updateSettings({ mode: input.value as CorsMode });
      }
    });
  });

  manageButton?.addEventListener('click', () => {
    void runtimeApi.runtime.openOptionsPage();
  });

  allowCurrentButton?.addEventListener('click', () => {
    void allowCurrentSite();
  });

  fixCorsButton?.addEventListener('click', () => {
    void fixBlockedCalls();
  });

  overrideServerButton?.addEventListener('click', () => {
    if (globalThis.confirm('Override CORS headers that servers already send? This applies to every trusted page and can break APIs that rely on credentials.')) {
      void applyFixes([{ kind: 'override-server' }], 'Server CORS headers will be overridden.');
    }
  });

  reloadTabButton?.addEventListener('click', () => {
    if (currentTabId !== null) {
      void runtimeApi.tabs.reload(currentTabId);
      globalThis.close();
    }
  });

  themeSelect?.addEventListener('change', () => {
    void updateSettings({ theme: themeSelect.value as ExtensionSettings['theme'] });
  });
}

// Trusts the page's origin and turns overrides on, so one click is enough to make the page work.
async function allowCurrentSite(): Promise<void> {
  if (!currentPattern) {
    return;
  }

  await updateSettings(applyCorsFixes(settings, [
    ...(settings.enabled ? [] : [{ kind: 'enable' } as const]),
    { kind: 'trust-page', pattern: currentPattern }
  ]));
  showNotice(`${currentPattern} is trusted. Reload the page to retry blocked calls.`, false);
}

// Fixes every blocked call on this page except server-header overrides, which affect other pages too
// and get their own confirmed button.
async function fixBlockedCalls(): Promise<void> {
  await applyFixes(getBulkFixes(), 'Fixed. Reload the page to retry the blocked calls.');
}

async function applyFixes(fixes: CorsFix[], message: string): Promise<void> {
  if (fixes.length === 0) {
    return;
  }

  const before = blockedIssueKeys();
  await updateSettings(applyCorsFixes(settings, fixes));
  const stillBlocked = blockedIssueKeys();
  before.forEach((key) => {
    if (!stillBlocked.has(key)) {
      fixedSinceOpen.add(key);
    }
  });
  renderCorsIssues();
  showNotice(message, false);
}

function getIssueStates(): ReturnType<typeof planCorsIssues> {
  return planCorsIssues(corsIssues, settings);
}

function blockedIssueKeys(): Set<string> {
  return new Set(getIssueStates().filter(({ state }) => state === 'blocked').map(({ issue }) => issue.key));
}

function getBulkFixes(): CorsFix[] {
  return collectCorsFixes(getIssueStates());
}

function renderCorsIssues(): void {
  if (!corsIssuesSection || !corsIssuesSummary || !corsIssuesList) {
    return;
  }

  corsIssuesSection.hidden = !settings.detectCorsIssues || currentTabId === null;
  const states = getIssueStates();
  const blocked = states.filter(isOpenCorsIssue);
  const handled = states.filter(({ state }) => state === 'fixed');
  corsIssuesSection.dataset.state = blocked.length > 0 ? 'blocked' : 'clear';
  corsIssuesSummary.textContent = blocked.length > 0
    ? `${pluralize(blocked.length, 'call')} blocked by CORS`
    : handled.length > 0
      ? `${pluralize(handled.length, 'call')} fixed by CORS Unblocker`
      : 'No blocked calls detected. Calls that fail CORS will show up here.';

  // One row per API and state, worst first.
  const groups = new Map<string, { target: string; state: CorsIssueState; issues: CorsIssue[] }>();
  [...blocked, ...states.filter(({ state }) => state === 'skipped'), ...handled].forEach(({ issue, state }) => {
    const target = getOrigin(issue.url);
    const key = `${state} ${target}`;
    const group = groups.get(key) ?? { target, state, issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  });

  corsIssuesList.textContent = '';
  [...groups.values()].slice(0, MAX_VISIBLE_ISSUE_GROUPS).forEach((group) => {
    const item = document.createElement('li');
    const target = document.createElement('span');
    const detail = document.createElement('small');
    const [first] = group.issues;
    const more = group.issues.length > 1 ? ` (+${group.issues.length - 1} more)` : '';
    item.dataset.state = group.state;
    target.className = 'cors-issues__target';
    target.textContent = `${group.target} · ${pluralize(group.issues.length, 'call')}`;
    detail.textContent = first ? `${describeIssueGroup(group.state, first, group.issues.some((issue) => fixedSinceOpen.has(issue.key)))}${more}` : '';
    item.append(target, detail);
    corsIssuesList.append(item);
  });
  if (groups.size > MAX_VISIBLE_ISSUE_GROUPS) {
    const more = document.createElement('li');
    more.textContent = `…and ${groups.size - MAX_VISIBLE_ISSUE_GROUPS} more APIs. Open DevTools > CORS for the full list.`;
    corsIssuesList.append(more);
  }

  const bulkFixes = getBulkFixes();
  if (corsFixPlan) {
    corsFixPlan.hidden = bulkFixes.length === 0;
    corsFixPlan.textContent = `Fixing will: ${bulkFixes.map(describeCorsFix).join('; ')}.`;
  }
  if (fixCorsButton) {
    fixCorsButton.hidden = bulkFixes.length === 0;
  }
  if (overrideServerButton) {
    overrideServerButton.hidden = !states.some(({ state, fixes }) => state === 'blocked' && fixes.some((fix) => fix.kind === 'override-server'));
  }
  if (reloadTabButton) {
    reloadTabButton.hidden = fixedSinceOpen.size === 0;
  }
}

function describeIssueGroup(state: CorsIssueState, issue: CorsIssue, fixedSinceOpened: boolean): string {
  const call = describeCorsCall(issue);
  switch (state) {
    case 'fixed':
      return fixedSinceOpened ? `${call}: fixed. Reload the page to retry.` : `${call}: CORS headers added by CORS Unblocker.`;
    case 'skipped':
      return `${call}: blocked, but your skip rules exclude it.`;
    default:
      return `${call}: ${describeCorsProblem(issue.problem, { origin: issue.pageOrigin })}`;
  }
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function getOrigin(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}


async function updateSettings(next: Partial<ExtensionSettings>): Promise<void> {
  setBusy(true);
  setStatus('Saving...', false);

  try {
    settings = await settingsController.update(next);
    render();
  } catch {
    setStatus('Unable to save settings', true);
  } finally {
    setBusy(false);
  }
}

function render(): void {
  applyTheme(settings.theme);
  if (enabledInput) {
    enabledInput.checked = settings.enabled;
  }

  modeInputs.forEach((input) => {
    input.checked = input.value === settings.mode;
  });

  if (statusElement) {
    const activeCount = settings.whitelist.length + settings.domainRules.length;
    statusElement.textContent = settings.enabled ? activeCount === 0 && settings.mode !== 'global' ? 'Enabled, but no active patterns' : 'Enabled' : 'Disabled';
    statusElement.dataset.enabled = String(settings.enabled);
    statusElement.dataset.warning = String(settings.enabled && activeCount === 0 && settings.mode !== 'global');
  }

  if (currentSiteElement) {
    currentSiteElement.textContent = currentPattern ?? 'Unavailable on this page';
  }

  const isCovered = Boolean(currentUrl && isCorsEnabledForRequest(currentUrl, currentUrl, settings));
  if (currentCoverageElement) {
    currentCoverageElement.textContent = isCovered ? 'CORS overrides are active here.' : 'CORS overrides are not active here.';
    currentCoverageElement.dataset.covered = String(isCovered);
  }

  if (allowCurrentButton) {
    const currentSkipped = Boolean(currentUrl && isCorsSkippedForRequest(currentUrl, currentUrl, settings));
    allowCurrentButton.hidden = !currentPattern || isCovered;
    allowCurrentButton.disabled = !currentPattern || isCovered;
    allowCurrentButton.textContent = currentSkipped ? 'Move to active' : 'Allow this page';
  }

  if (modeWarning) {
    modeWarning.hidden = settings.mode !== 'global';
  }
  if (themeSelect) {
    themeSelect.value = settings.theme;
  }
  renderCorsIssues();
}

function setStatus(text: string, isError: boolean): void {
  if (!statusElement) {
    if (isError) {
      showNotice(text, true);
    }
    return;
  }

  if (isError) {
    showNotice(text, true);
    return;
  }

  statusElement.textContent = text;
  statusElement.dataset.enabled = String(!isError && settings?.enabled);
  statusElement.dataset.error = String(isError);
}

function showNotice(text: string, isError: boolean): void {
  if (!noticeElement) {
    return;
  }
  if (noticeTimer) {
    clearTimeout(noticeTimer);
  }
  noticeElement.textContent = text;
  noticeElement.dataset.error = String(isError);
  noticeTimer = setTimeout(() => {
    noticeElement.textContent = '';
    noticeElement.dataset.error = 'false';
  }, 20_000);
}

function setBusy(isBusy: boolean): void {
  [enabledInput, manageButton, allowCurrentButton, themeSelect, fixCorsButton, overrideServerButton, ...modeInputs].forEach((control) => {
    if (control) {
      control.disabled = isBusy;
    }
  });
}

async function getCurrentSite(): Promise<{ url: string | null; pattern: string | null; tabId: number | null }> {
  try {
    const [tab] = await runtimeApi.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? null;
    const tabId = tab?.id ?? null;

    if (!url || !/^https?:\/\//.test(url)) {
      return { url, pattern: null, tabId };
    }

    // Trust the whole origin: a single-page app changes paths without reloading.
    return { url, pattern: getTrustPatternForRequest(url, url), tabId };
  } catch {
    return { url: null, pattern: null, tabId: null };
  }
}
