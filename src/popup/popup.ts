import { SettingsController, runtimeApi } from '../shared/browserApi';
import { CorsFix, CorsIssue, PlannedCorsIssue, applyCorsFixes, collectCorsFixes, describeCorsCall, describeCorsFix, describeCorsProblem, isOpenCorsIssue, summarizeCorsProblem, planCorsIssues, planIssueFix } from '../shared/corsDiagnosis';
import { loadTabCorsIssues, onTabCorsIssuesChanged } from '../shared/corsMonitor';
import { PAUSE_DURATION_MS } from '../shared/pause';
import { ExtensionSettings, formatPatternForPeople, getEffectiveCorsRuleForRequest, getTrustPatternForRequest, isCorsEnabledForRequest, mergeSettings } from '../shared/settings';
import { formatTime, getStatusText } from '../shared/statusText';
import { applyTheme } from '../shared/theme';

const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const powerLabel = document.querySelector<HTMLElement>('#power-label');
const statusLine = document.querySelector<HTMLElement>('#status-line');
const globalWarning = document.querySelector<HTMLElement>('#global-warning');
const leaveGlobalButton = document.querySelector<HTMLButtonElement>('#leave-global');
const card = document.querySelector<HTMLElement>('#page-card');
const cardTitle = document.querySelector<HTMLElement>('#card-title');
const cardText = document.querySelector<HTMLElement>('#card-text');
const issueList = document.querySelector<HTMLUListElement>('#issue-list');
const fixDetails = document.querySelector<HTMLDetailsElement>('#fix-details');
const fixList = document.querySelector<HTMLUListElement>('#fix-list');
const primaryButton = document.querySelector<HTMLButtonElement>('#primary-action');
const secondaryButton = document.querySelector<HTMLButtonElement>('#secondary-action');
const noticeElement = document.querySelector<HTMLElement>('#notice');
const pauseButton = document.querySelector<HTMLButtonElement>('#pause');
const settingsButton = document.querySelector<HTMLButtonElement>('#open-settings');

const MAX_ISSUE_ROWS = 3;

interface CardAction {
  label: string;
  run: () => Promise<void> | void;
  tone?: 'danger';
}

// Everything the page card shows for one state. Each state has at most one primary action.
interface CardView {
  tone: 'alert' | 'success' | 'neutral';
  title: string;
  text: string;
  issues?: PlannedCorsIssue[];
  fixes?: CorsFix[];
  primary?: CardAction;
  secondary?: CardAction;
}

let settings: ExtensionSettings = mergeSettings({});
let tabId: number | null = null;
let pageUrl: string | null = null;
let pagePattern: string | null = null;
let corsIssues: CorsIssue[] = [];
let currentView: CardView | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
// Calls that failed and that the current settings now fix; they need a page reload to retry.
const fixedSinceOpen = new Set<string>();
const settingsController = new SettingsController();

void initialize();

async function initialize(): Promise<void> {
  try {
    const [loadedSettings, tab] = await Promise.all([settingsController.initialize(), getActiveTab()]);
    settings = loadedSettings;
    tabId = tab.id;
    pageUrl = tab.url && /^https?:\/\//.test(tab.url) ? tab.url : null;
    pagePattern = pageUrl ? getTrustPatternForRequest(pageUrl, pageUrl) : null;
    if (tabId !== null) {
      const id = tabId;
      corsIssues = await loadTabCorsIssues(id);
      onTabCorsIssuesChanged(id, (issues) => {
        corsIssues = issues;
        render();
      });
    }
    settingsController.subscribe((nextSettings) => {
      settings = nextSettings;
      render();
    });
    render();
  } catch {
    showNotice('Unable to load settings.', true);
  }

  enabledInput?.addEventListener('change', () => {
    // Switching off by hand ends any pause too: off means off.
    void save(enabledInput.checked ? { enabled: true } : { enabled: false, pausedUntil: null });
  });
  pauseButton?.addEventListener('click', () => {
    void save({ enabled: false, pausedUntil: Date.now() + PAUSE_DURATION_MS }, 'Paused for 1 hour.');
  });
  leaveGlobalButton?.addEventListener('click', () => {
    void save({ mode: 'whitelist' }, 'Only trusted pages get relaxed CORS now.');
  });
  settingsButton?.addEventListener('click', () => {
    void runtimeApi.runtime.openOptionsPage();
    globalThis.close();
  });
  primaryButton?.addEventListener('click', () => void runAction(currentView?.primary));
  secondaryButton?.addEventListener('click', () => void runAction(currentView?.secondary));
}

function render(): void {
  applyTheme(settings.theme);
  renderHeader();
  currentView = getCardView();
  renderCard(currentView);
  if (pauseButton) {
    pauseButton.hidden = !settings.enabled;
  }
}

function renderHeader(): void {
  if (statusLine) {
    statusLine.textContent = getStatusText(settings);
    statusLine.dataset.state = settings.enabled ? 'on' : 'off';
  }
  if (enabledInput) {
    enabledInput.checked = settings.enabled;
  }
  if (powerLabel) {
    powerLabel.textContent = settings.enabled ? 'On' : 'Off';
  }
  if (globalWarning) {
    globalWarning.hidden = !(settings.enabled && settings.mode === 'global');
  }
}

function getCardView(): CardView {
  if (!pageUrl || !pagePattern) {
    return {
      tone: 'neutral',
      title: 'Open a website to check its calls',
      text: 'CORS Unblocker works on http and https pages.'
    };
  }

  const page = pagePattern;
  const host = formatPatternForPeople(page);
  const planned = settings.detectCorsIssues ? planCorsIssues(corsIssues, settings) : [];
  const open = planned.filter(isOpenCorsIssue);
  const recentlyFixed = planned.filter(({ issue, state }) => state === 'fixed' && fixedSinceOpen.has(issue.key));

  if (open.length > 0) {
    return getBlockedView(planned, open, recentlyFixed.length);
  }

  if (recentlyFixed.length > 0) {
    return {
      tone: 'success',
      title: 'Fixed. Reload to retry',
      text: `${pluralize(recentlyFixed.length, 'call')} that failed will work after the page reloads.`,
      primary: { label: 'Reload page', run: reloadPage }
    };
  }

  if (settings.pausedUntil !== null) {
    return {
      tone: 'neutral',
      title: 'Overrides are paused',
      text: `They turn back on by themselves at ${formatTime(settings.pausedUntil)}.`,
      primary: { label: 'Resume now', run: () => save({ enabled: true }, 'Overrides are back on.') }
    };
  }

  const detectionNote = settings.detectCorsIssues ? ' No blocked calls detected so far.' : '';
  if (isCorsEnabledForRequest(pageUrl, pageUrl, settings)) {
    const trustedDirectly = settings.whitelist.includes(page);
    const rule = getEffectiveCorsRuleForRequest(pageUrl, pageUrl, settings);
    const coveredBy = !trustedDirectly && rule.state === 'active'
      ? ` Covered by ${rule.source === 'global' ? 'global mode' : formatPatternForPeople(rule.pattern)}.`
      : '';
    return {
      tone: 'success',
      title: `${host} is trusted`,
      text: `Calls it makes to other sites get relaxed CORS headers.${coveredBy}${detectionNote}`,
      ...(trustedDirectly ? {
        secondary: {
          label: `Stop trusting ${host}`,
          run: () => save({ whitelist: settings.whitelist.filter((pattern) => pattern !== page) }, `${host} is no longer trusted.`)
        }
      } : {})
    };
  }

  const trustFixes: CorsFix[] = [...(settings.enabled ? [] : [{ kind: 'enable' } as const]), { kind: 'trust-page', pattern: page }];
  return {
    tone: 'neutral',
    title: `${host} isn't trusted`,
    text: `Its calls to other sites keep their normal CORS behavior.${settings.detectCorsIssues ? ' Blocked calls will show up here.' : ''}`,
    primary: { label: `Trust ${host}`, run: () => applyFixes(trustFixes, `${host} is trusted. Reload the page to retry blocked calls.`) }
  };
}

// Calls fixed a moment ago only work after a reload, so when nothing else is fixable here,
// reloading becomes the primary action.
function getBlockedView(planned: PlannedCorsIssue[], open: PlannedCorsIssue[], recentlyFixed: number): CardView {
  const fixes = collectCorsFixes(planned);
  const fixable = countFixedBy(open, fixes);
  const needsOverride = open.some(({ state, fixes: issueFixes }) => state === 'blocked' && issueFixes.some((fix) => fix.kind === 'override-server'));
  const serverOnly = open.filter(({ state }) => state === 'unfixable').length;

  const notes: string[] = [];
  if (recentlyFixed > 0) {
    notes.push(`${pluralize(recentlyFixed, 'call')} fixed; reload to retry.`);
  }
  if (fixable === 0 && serverOnly === open.length) {
    notes.push('These need a fix on the server; headers alone cannot help.');
  } else if (fixable === 0 && needsOverride) {
    notes.push('The server sends its own CORS headers for these calls.');
  }
  const text = notes.join(' ');

  const view: CardView = { tone: 'alert', title: `${pluralize(open.length, 'call')} blocked by CORS`, text, issues: open, fixes };
  if (fixable > 0) {
    view.primary = { label: `Fix ${pluralize(fixable, 'call')}`, run: () => applyFixes(fixes, 'Fixed. Reload the page to retry.') };
  } else if (recentlyFixed > 0) {
    view.primary = { label: 'Reload page', run: reloadPage };
  }
  if (needsOverride) {
    view.secondary = {
      label: 'Override the server’s CORS headers…',
      tone: 'danger',
      run: () => {
        if (globalThis.confirm('Override CORS headers that servers already send? This applies to every trusted page and can break APIs that rely on credentials.')) {
          return applyFixes([...fixes, { kind: 'override-server' }], 'Server CORS headers will be overridden. Reload the page to retry.');
        }
        return undefined;
      }
    };
  }
  return view;
}

function renderCard(view: CardView): void {
  if (!card || !cardTitle || !cardText || !issueList || !fixDetails || !fixList || !primaryButton || !secondaryButton) {
    return;
  }

  card.dataset.tone = view.tone;
  cardTitle.textContent = view.title;
  cardText.textContent = view.text;

  issueList.textContent = '';
  issueList.hidden = !view.issues?.length;
  const groups = groupByHost(view.issues ?? []);
  groups.slice(0, MAX_ISSUE_ROWS).forEach((group) => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    const [first] = group.entries;
    item.dataset.state = group.entries.every(({ state }) => state === 'unfixable') ? 'unfixable' : 'blocked';
    title.textContent = `${group.host} · ${pluralize(group.entries.length, 'call')}`;
    detail.textContent = first ? `${describeCorsCall(first.issue)} · ${summarizeCorsProblem(first.issue.problem)}` : '';
    item.title = first ? describeCorsProblem(first.issue.problem, { origin: first.issue.pageOrigin }) : '';
    item.append(title, detail);
    issueList.append(item);
  });
  if (groups.length > MAX_ISSUE_ROWS) {
    const more = document.createElement('li');
    more.textContent = `…and ${groups.length - MAX_ISSUE_ROWS} more. See DevTools › CORS › Requests.`;
    issueList.append(more);
  }

  fixList.textContent = '';
  fixDetails.hidden = !view.primary || !view.fixes?.length;
  (view.fixes ?? []).forEach((fix) => {
    const item = document.createElement('li');
    item.textContent = describeCorsFix(fix);
    fixList.append(item);
  });

  primaryButton.hidden = !view.primary;
  primaryButton.textContent = view.primary?.label ?? '';
  secondaryButton.hidden = !view.secondary;
  secondaryButton.textContent = view.secondary?.label ?? '';
  if (view.secondary?.tone) {
    secondaryButton.dataset.tone = view.secondary.tone;
  } else {
    delete secondaryButton.dataset.tone;
  }
}

async function runAction(action: CardAction | undefined): Promise<void> {
  if (!action) {
    return;
  }
  setBusy(true);
  try {
    await action.run();
  } finally {
    setBusy(false);
  }
}

async function applyFixes(fixes: CorsFix[], message: string): Promise<void> {
  const openBefore = planCorsIssues(corsIssues, settings).filter(isOpenCorsIssue).map(({ issue }) => issue.key);
  await save(applyCorsFixes(settings, fixes), message);
  const stillOpen = new Set(planCorsIssues(corsIssues, settings).filter(isOpenCorsIssue).map(({ issue }) => issue.key));
  openBefore.filter((key) => !stillOpen.has(key)).forEach((key) => fixedSinceOpen.add(key));
  render();
}

// How many of the open calls the given fixes would turn into fixed ones.
function countFixedBy(open: PlannedCorsIssue[], fixes: CorsFix[]): number {
  if (fixes.length === 0) {
    return 0;
  }
  const after = mergeSettings({ ...settings, ...applyCorsFixes(settings, fixes) });
  return open.filter(({ issue }) => !isOpenCorsIssue(planIssueFix(issue, after))).length;
}

async function save(next: Partial<ExtensionSettings>, message?: string): Promise<void> {
  try {
    settings = await settingsController.update(next);
    render();
    if (message) {
      showNotice(message, false);
    }
  } catch {
    showNotice('Unable to save settings.', true);
  }
}

function reloadPage(): void {
  if (tabId !== null) {
    void runtimeApi.tabs.reload(tabId);
    globalThis.close();
  }
}

function groupByHost(entries: PlannedCorsIssue[]): Array<{ host: string; entries: PlannedCorsIssue[] }> {
  const groups = new Map<string, PlannedCorsIssue[]>();
  entries.forEach((entry) => {
    const host = getHost(entry.issue.url);
    groups.set(host, [...(groups.get(host) ?? []), entry]);
  });
  return [...groups.entries()].map(([host, grouped]) => ({ host, entries: grouped }));
}

function getHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
  }, 8_000);
}

function setBusy(isBusy: boolean): void {
  [enabledInput, primaryButton, secondaryButton, pauseButton, leaveGlobalButton].forEach((control) => {
    if (control) {
      control.disabled = isBusy;
    }
  });
}

async function getActiveTab(): Promise<{ id: number | null; url: string | null }> {
  try {
    const [tab] = await runtimeApi.tabs.query({ active: true, currentWindow: true });
    return { id: tab?.id ?? null, url: tab?.url ?? null };
  } catch {
    return { id: null, url: null };
  }
}
