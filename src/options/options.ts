import {
  DiscoveredRequest,
  SettingsController,
  collapseDiscoveredRequests,
  loadDiscoveredRequests,
  onDiscoveredRequestsChanged,
  resetSettings
} from '../shared/browserApi';
import { CallRule, DEFAULT_ALLOW_METHODS, CorsMode, DomainRuleType, ExtensionSettings, exportRules, formatPatternForPeople, getCallRuleForRequest, getTrustPatternForRequest, importRules, isCredentialsSupported, normalizeMethodOverridePattern, normalizePattern } from '../shared/settings';
import { applyTheme } from '../shared/theme';
import { WELCOME_HASH } from '../shared/welcome';

const form = document.querySelector<HTMLFormElement>('#form');
const input = document.querySelector<HTMLInputElement>('#pattern');
const message = document.querySelector<HTMLElement>('#message');
const countElement = document.querySelector<HTMLElement>('#count');
const list = document.querySelector<HTMLUListElement>('#list');
const discoveredList = document.querySelector<HTMLUListElement>('#discovered-list');
const ruleKindSelect = document.querySelector<HTMLSelectElement>('#rule-kind');
const patternLabel = document.querySelector<HTMLElement>('#pattern-label');
const patternNote = document.querySelector<HTMLElement>('#pattern-note');
const callFromField = document.querySelector<HTMLElement>('#call-from-field');
const callFromInput = document.querySelector<HTMLInputElement>('#call-from');
const ruleFilterInput = document.querySelector<HTMLInputElement>('#rule-filter');
const toastElement = document.querySelector<HTMLElement>('#toast');
const sectionNavLinks = [...document.querySelectorAll<HTMLAnchorElement>('.section-nav a')];
const methodInputs = [...document.querySelectorAll<HTMLInputElement>('.allow-method')];
const selectAllMethodsButton = document.querySelector<HTMLButtonElement>('#select-all-methods');
const selectDefaultMethodsButton = document.querySelector<HTMLButtonElement>('#select-default-methods');
const allowAllHeadersInput = document.querySelector<HTMLInputElement>('#allow-all-headers');
const allowCredentialsInput = document.querySelector<HTMLInputElement>('#allow-credentials');
const respectServerCorsInput = document.querySelector<HTMLInputElement>('#respect-server-cors');
const exposeAllHeadersInput = document.querySelector<HTMLInputElement>('#expose-all-headers');
const detectCorsIssuesInput = document.querySelector<HTMLInputElement>('#detect-cors-issues');
const credentialsHint = document.querySelector<HTMLElement>('#credentials-hint');
const headersWarning = document.querySelector<HTMLElement>('#headers-warning');
const themeSelect = document.querySelector<HTMLSelectElement>('#theme');
const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const settingsStatus = document.querySelector<HTMLElement>('#settings-status');
const policyNotice = document.querySelector<HTMLElement>('#policy-notice');
const globalModeWarning = document.querySelector<HTMLElement>('#global-mode-warning');
const resetButton = document.querySelector<HTMLButtonElement>('#reset');
const exportRulesButton = document.querySelector<HTMLButtonElement>('#export-rules');
const importRulesButton = document.querySelector<HTMLButtonElement>('#import-rules');
const importRulesFile = document.querySelector<HTMLInputElement>('#import-rules-file');
const importPreview = document.querySelector<HTMLElement>('#import-preview');
const importPreviewSummary = document.querySelector<HTMLElement>('#import-preview-summary');
const confirmImportRulesButton = document.querySelector<HTMLButtonElement>('#confirm-import-rules');
const cancelImportRulesButton = document.querySelector<HTMLButtonElement>('#cancel-import-rules');
const welcomeSection = document.querySelector<HTMLElement>('#welcome');
const dismissWelcomeButton = document.querySelector<HTMLButtonElement>('#dismiss-welcome');

let settings: ExtensionSettings;
let discoveredRequests: DiscoveredRequest[] = [];
let messageTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let ruleFilter = '';
// The rule being edited in place, and its draft values, so a re-render keeps the edit open.
let editing: { key: string; pattern: string; from: string } | null = null;
const openRuleOptions = new Set<string>();
let pendingImportedSettings: Partial<ExtensionSettings> | null = null;
const settingsController = new SettingsController();

void initialize();

async function initialize(): Promise<void> {
  showWelcomeIfRequested();
  try {
    const [loadedSettings, loadedRequests] = await Promise.all([
      settingsController.initialize(),
      loadDiscoveredRequests()
    ]);
    settings = loadedSettings;
    discoveredRequests = loadedRequests;
    render();
    settingsController.subscribe((nextSettings) => {
      settings = nextSettings;
      render();
    });
    onDiscoveredRequestsChanged((requests) => {
      discoveredRequests = requests;
      render();
    });
  } catch {
    setMessage('Unable to load settings.', true);
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void addPattern();
  });
  ruleKindSelect?.addEventListener('change', updateFormForKind);
  updateFormForKind();
  ruleFilterInput?.addEventListener('input', () => {
    ruleFilter = ruleFilterInput.value.trim().toLowerCase();
    renderRules();
  });
  // Collapsed sections open when their menu link is used.
  sectionNavLinks.forEach((link) => link.addEventListener('click', () => {
    const target = document.querySelector(link.hash);
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
    }
  }));

  methodInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const allowMethods = methodInputs.filter((methodInput) => methodInput.checked).map((methodInput) => methodInput.value);
      if (allowMethods.length === 0) {
        input.checked = true;
        return;
      }
      void updateMethods(allowMethods);
    });
  });

  selectAllMethodsButton?.addEventListener('click', () => {
    void updateMethods(methodInputs.map((methodInput) => methodInput.value));
  });

  selectDefaultMethodsButton?.addEventListener('click', () => {
    void updateMethods([...DEFAULT_ALLOW_METHODS]);
  });

  allowAllHeadersInput?.addEventListener('change', () => {
    void updateSettings({ allowAllHeaders: allowAllHeadersInput.checked });
  });
  exposeAllHeadersInput?.addEventListener('change', () => {
    void updateSettings({ exposeAllHeaders: exposeAllHeadersInput.checked });
  });
  respectServerCorsInput?.addEventListener('change', () => {
    void updateSettings({ respectServerCors: respectServerCorsInput.checked });
  });
  detectCorsIssuesInput?.addEventListener('change', () => {
    void updateSettings({ detectCorsIssues: detectCorsIssuesInput.checked });
  });
  allowCredentialsInput?.addEventListener('change', () => {
    void updateSettings({ allowCredentials: allowCredentialsInput.checked });
  });

  themeSelect?.addEventListener('change', () => {
    void updateTheme(themeSelect.value as ExtensionSettings['theme']);
  });

  enabledInput?.addEventListener('change', () => {
    // Switching off by hand ends any pause too: off means off, as in the popup and panel.
    void updateSettings(enabledInput.checked ? { enabled: true } : { enabled: false, pausedUntil: null });
  });
  modeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) {
        return;
      }
      if (input.value === 'global' && !globalThis.confirm('Enable CORS overrides for every website?')) {
        render();
        return;
      }
      void updateSettings({ mode: input.value as CorsMode });
    });
  });
  resetButton?.addEventListener('click', () => {
    if (globalThis.confirm('Reset all CORS settings and lists?')) {
      void resetAllSettings();
    }
  });
  exportRulesButton?.addEventListener('click', exportCurrentRules);
  importRulesButton?.addEventListener('click', () => importRulesFile?.click());
  importRulesFile?.addEventListener('change', () => void importRulesFromFile());
  confirmImportRulesButton?.addEventListener('click', () => void confirmRulesImport());
  cancelImportRulesButton?.addEventListener('click', clearImportPreview);
}

const FORM_KINDS = {
  enabled: { label: 'Page', placeholder: 'localhost:3000 or *.example.dev', note: 'Every call this page makes gets relaxed CORS headers. Hosts, full URLs, wildcard subdomains (*.example.dev) and paths ending in /* all work.' },
  call: { label: 'API URL', placeholder: 'https://api.staging.dev/v1/users', note: 'Only requests to this URL (with any query string or sub-path), made by that page, are relaxed. The page\'s other calls keep normal CORS.' },
  skip: { label: 'URL', placeholder: 'api.staging.dev/admin', note: 'Matching requests always keep their original CORS headers, whatever other rules say.' }
} as const;

function getFormKind(): keyof typeof FORM_KINDS {
  const value = ruleKindSelect?.value;
  return value === 'call' || value === 'skip' ? value : 'enabled';
}

function updateFormForKind(): void {
  const kind = FORM_KINDS[getFormKind()];
  if (patternLabel) {
    patternLabel.textContent = kind.label;
  }
  if (input) {
    input.placeholder = kind.placeholder;
  }
  if (patternNote) {
    patternNote.textContent = kind.note;
  }
  if (callFromField) {
    callFromField.hidden = getFormKind() !== 'call';
  }
  setFormError('');
}

async function addPattern(): Promise<void> {
  const rawPattern = input?.value.trim() ?? '';
  const normalized = normalizePattern(rawPattern);
  const kind = getFormKind();

  if (!normalized) {
    setFormError(`Could not add "${rawPattern || 'empty value'}". Use a hostname, a full http(s) URL, or a wildcard such as *.example.dev.`);
    input?.focus();
    return;
  }

  if (kind === 'call') {
    const rawFrom = callFromInput?.value.trim() ?? '';
    const from = normalizePattern(rawFrom);
    if (!from) {
      setFormError('Enter the page that makes the call, such as localhost:3000.');
      callFromInput?.focus();
      return;
    }
    if (settings.callRules.some((rule) => rule.target === normalized && rule.from === from)) {
      setFormError(`${formatPatternForPeople(normalized)} is already unblocked for ${formatPatternForPeople(from)}.`);
      return;
    }
    setFormError('');
    await addCallRule({ target: normalized, from });
    if (input) {
      input.value = '';
    }
    return;
  }

  const existing = kind === 'enabled' ? settings.whitelist : settings.skiplist;
  if (existing.includes(normalized)) {
    setFormError(`${formatPatternForPeople(normalized)} is already ${kind === 'enabled' ? 'trusted' : 'skipped'}.`);
    return;
  }

  setBusy(true);
  try {
    // A pattern is either trusted or skipped, never both.
    settings = await settingsController.update(kind === 'enabled'
      ? { whitelist: [...settings.whitelist, normalized], skiplist: settings.skiplist.filter((item) => item !== normalized) }
      : { skiplist: [...settings.skiplist, normalized], whitelist: settings.whitelist.filter((item) => item !== normalized) });
    if (input) {
      input.value = '';
    }
    setFormError('');
    setMessage(kind === 'enabled' ? `${formatPatternForPeople(normalized)} is trusted.` : `${formatPatternForPeople(normalized)} is skipped.`, false);
    render();
  } catch {
    setMessage('Unable to save the rule.', true);
  } finally {
    setBusy(false);
  }
}

async function removePattern(pattern: string, kind: RuleKind, feedbackTarget?: HTMLElement): Promise<void> {
  setBusy(true);

  try {
    const { [pattern]: _removedMethods, ...methodOverrides } = settings.methodOverrides;
    settings = await settingsController.update(kind === 'enabled'
      ? { whitelist: settings.whitelist.filter((item) => item !== pattern), methodOverrides }
      : kind === 'domain'
        ? { domainRules: settings.domainRules.filter((rule) => rule.pattern !== pattern), methodOverrides }
        : { skiplist: settings.skiplist.filter((item) => item !== pattern) });
    setMessage(`${formatPatternForPeople(pattern)} removed.`, false);
    if (feedbackTarget) {
      showRowFeedback(feedbackTarget, 'Removed', () => render());
    } else {
      render();
    }
  } catch {
    setMessage('Unable to remove pattern.', true);
  } finally {
    setBusy(false);
  }
}

async function addDiscoveredPattern(pattern: string, kind: 'enabled' | 'skip', feedbackTarget?: HTMLElement): Promise<void> {
  const normalized = normalizePattern(pattern);
  if (!normalized) {
    setMessage('That request cannot be converted into a browser pattern.', true);
    return;
  }

  const nextWhitelist = kind === 'enabled'
    ? [...new Set([...settings.whitelist, normalized])]
    : settings.whitelist.filter((item) => item !== normalized);
  const nextSkiplist = kind === 'skip'
    ? [...new Set([...settings.skiplist, normalized])]
    : settings.skiplist;

  setBusy(true);
  try {
    settings = await settingsController.update({ whitelist: nextWhitelist, skiplist: nextSkiplist });
    setMessage(kind === 'enabled' ? 'Added to active rules.' : 'Added to skip rules.', false);
    if (feedbackTarget) {
      showRowFeedback(feedbackTarget, kind === 'enabled' ? 'Added' : 'Skipped', () => render());
    } else {
      render();
    }
  } catch {
    setMessage('Unable to update pattern lists.', true);
  } finally {
    setBusy(false);
  }
}

async function addCallRule(callRule: CallRule, feedbackTarget?: HTMLElement): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update({ callRules: [...settings.callRules, callRule] });
    setMessage(`${formatPatternForPeople(callRule.target)} is unblocked for ${formatPatternForPeople(callRule.from)}. Its other calls are unchanged.`, false);
    if (feedbackTarget) {
      showRowFeedback(feedbackTarget, 'Unblocked', () => render());
    } else {
      render();
    }
  } catch {
    setMessage('Unable to unblock that call.', true);
  } finally {
    setBusy(false);
  }
}

async function removeCallRule(callRule: CallRule, feedbackTarget?: HTMLElement): Promise<void> {
  setBusy(true);
  try {
    const stillUsed = settings.callRules.some((rule) => rule.target === callRule.target && rule.from !== callRule.from);
    const { [callRule.target]: _removedMethods, ...methodOverrides } = settings.methodOverrides;
    settings = await settingsController.update({
      callRules: settings.callRules.filter((rule) => rule.target !== callRule.target || rule.from !== callRule.from),
      ...(stillUsed ? {} : { methodOverrides })
    });
    setMessage(`${formatPatternForPeople(callRule.target)} is no longer unblocked for ${formatPatternForPeople(callRule.from)}.`, false);
    if (feedbackTarget) {
      showRowFeedback(feedbackTarget, 'Removed', () => render());
    } else {
      render();
    }
  } catch {
    setMessage('Unable to remove that call.', true);
  } finally {
    setBusy(false);
  }
}

// Shown when the background opens Settings after a fresh install; dismissing it removes the marker
// from the address, so a reload does not bring it back.
function showWelcomeIfRequested(): void {
  if (!welcomeSection || location.hash !== WELCOME_HASH) {
    return;
  }
  welcomeSection.hidden = false;
  dismissWelcomeButton?.addEventListener('click', () => {
    welcomeSection.hidden = true;
    history.replaceState(null, '', location.pathname);
    input?.focus();
  });
}

function render(): void {
  applyTheme(settings.theme);
  if (enabledInput) {
    enabledInput.checked = settings.enabled;
  }
  modeInputs.forEach((input) => {
    input.checked = input.value === settings.mode;
  });
  renderPolicyNotice();
  lockPolicyControls(false);
  if (settingsStatus) {
    const activeCount = settings.whitelist.length + settings.domainRules.length;
    settingsStatus.textContent = settings.enabled
      ? settings.mode === 'global' ? 'Enabled' : activeCount === 0 ? 'Enabled, but no active rules' : 'Enabled'
      : settings.policy.overridesOff ? 'Disabled by your organization' : 'Disabled';
    settingsStatus.dataset.enabled = String(settings.enabled);
    settingsStatus.dataset.warning = String(settings.enabled && activeCount === 0 && settings.mode !== 'global');
  }
  if (globalModeWarning) {
    globalModeWarning.hidden = !(settings.enabled && settings.mode === 'global');
  }
  methodInputs.forEach((input) => {
    input.checked = settings.allowMethods.includes(input.value);
  });
  if (allowAllHeadersInput) {
    allowAllHeadersInput.checked = settings.allowAllHeaders;
  }
  if (respectServerCorsInput) {
    respectServerCorsInput.checked = settings.respectServerCors;
  }
  if (exposeAllHeadersInput) {
    exposeAllHeadersInput.checked = settings.exposeAllHeaders;
  }
  if (detectCorsIssuesInput) {
    detectCorsIssuesInput.checked = settings.detectCorsIssues;
  }
  if (allowCredentialsInput) {
    allowCredentialsInput.checked = settings.allowCredentials;
    allowCredentialsInput.disabled = !isCredentialsSupported(settings);
  }
  if (credentialsHint) {
    credentialsHint.textContent = isCredentialsSupported(settings)
      ? 'Reload open tabs after changing this option.'
      : 'Unavailable in Global mode. Add an explicit http(s) origin pattern first.';
  }
  if (headersWarning) {
    headersWarning.hidden = !(settings.allowCredentials && settings.allowAllHeaders);
  }
  if (themeSelect) {
    themeSelect.value = settings.theme;
  }
  renderRules();
  renderDiscoveredRequests();

  if (countElement) {
    // Each group heading shows its own count; this is the total.
    const total = settings.whitelist.length + settings.domainRules.length + settings.callRules.length + settings.skiplist.length;
    countElement.textContent = `${total} ${total === 1 ? 'rule' : 'rules'}`;
  }
}

async function updateTheme(theme: ExtensionSettings['theme']): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update({ theme });
    setMessage('Appearance updated.', false);
  } catch {
    setMessage('Unable to update appearance.', true);
  } finally {
    setBusy(false);
  }
}

async function updateSettings(next: Partial<ExtensionSettings>): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update(next);
    render();
  } catch {
    setMessage('Unable to update settings.', true);
  } finally {
    setBusy(false);
  }
}

async function resetAllSettings(): Promise<void> {
  setBusy(true);
  try {
    await resetSettings();
    settings = await settingsController.initialize();
    setMessage('Settings reset.', false);
    render();
  } catch {
    setMessage('Unable to reset settings.', true);
  } finally {
    setBusy(false);
  }
}

function exportCurrentRules(): void {
  const blob = new Blob([exportRules(settings)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'cors-dev-tool-rules.json';
  link.click();
  URL.revokeObjectURL(link.href);
  setMessage('Rules exported.', false);
}

async function importRulesFromFile(): Promise<void> {
  const file = importRulesFile?.files?.[0];
  if (!file) {
    return;
  }

  try {
    pendingImportedSettings = importRules(await file.text());
    renderImportPreview(file.name, pendingImportedSettings);
  } catch (error) {
    clearImportPreview();
    setMessage(error instanceof Error ? error.message : 'Unable to import rules.', true);
  } finally {
    if (importRulesFile) {
      importRulesFile.value = '';
    }
  }
}

function renderImportPreview(fileName: string, nextSettings: Partial<ExtensionSettings>): void {
  if (!importPreview || !importPreviewSummary) {
    return;
  }

  const whitelistCount = nextSettings.whitelist?.length ?? 0;
  const skiplistCount = nextSettings.skiplist?.length ?? 0;
  const domainCount = nextSettings.domainRules?.length ?? 0;
  const overrideCount = Object.keys(nextSettings.methodOverrides ?? {}).length;
  const file = document.createElement('p');
  const counts = document.createElement('p');
  const note = document.createElement('p');
  importPreviewSummary.textContent = '';
  file.className = 'section-help';
  counts.className = 'import-preview-counts';
  note.className = 'section-help';
  file.textContent = fileName;
  appendImportBadge(counts, `${whitelistCount} active`);
  appendImportBadge(counts, `${skiplistCount} skipped`);
  appendImportBadge(counts, `${domainCount} domain`);
  appendImportBadge(counts, `${overrideCount} custom method${overrideCount === 1 ? '' : 's'}`);
  note.textContent = 'Header and credential settings from the file will also be applied. Enabled state, scope, and theme stay unchanged.';
  importPreviewSummary.append(file, counts, note);
  importPreview.hidden = false;
}

function appendImportBadge(target: HTMLElement, text: string): void {
  const badge = document.createElement('span');
  badge.className = 'import-preview-badge';
  badge.textContent = text;
  target.append(badge);
}

async function confirmRulesImport(): Promise<void> {
  if (!pendingImportedSettings) {
    return;
  }

  setBusy(true);
  try {
    settings = await settingsController.update(pendingImportedSettings);
    clearImportPreview();
    setMessage('Rules imported.', false);
    render();
  } catch {
    setMessage('Unable to import rules.', true);
  } finally {
    setBusy(false);
  }
}

function clearImportPreview(): void {
  pendingImportedSettings = null;
  if (importPreview) {
    importPreview.hidden = true;
  }
  if (importPreviewSummary) {
    importPreviewSummary.textContent = '';
  }
}

async function updateMethods(allowMethods: string[]): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update({ allowMethods });
    setMessage('Allowed methods updated.', false);
  } catch {
    setMessage('Unable to update allowed methods.', true);
  } finally {
    setBusy(false);
  }
}

type RuleKind = 'enabled' | 'skip' | 'domain' | 'call';

interface RuleRow {
  key: string;
  pattern: string;
  kind: RuleKind;
  label?: string;
  from?: string;
}

const DOMAIN_LABELS: Record<DomainRuleType, string> = {
  both: 'This site, as a page and as an API',
  first_party: 'This site as an API, for any page',
  third_party: 'This site\'s pages, calling any API'
};

// Every rule, grouped by what it does, compact, filterable, and editable in place.
function renderRules(): void {
  if (!list) {
    return;
  }

  const skipped = new Set(settings.skiplist);
  const groups: Array<{ title: string; help: string; rows: RuleRow[] }> = [
    {
      title: 'Unblocked calls',
      help: 'One URL, only from one page.',
      rows: settings.callRules.map((rule) => ({ key: `call ${rule.from} ${rule.target}`, pattern: rule.target, kind: 'call' as const, from: rule.from }))
    },
    {
      title: 'Trusted pages',
      help: 'Every call these pages make.',
      rows: settings.whitelist.map((pattern) => ({ key: `enabled ${pattern}`, pattern, kind: 'enabled' as const }))
    },
    {
      title: 'Domain rules',
      help: 'Set from the DevTools panel.',
      rows: settings.domainRules.filter((rule) => !skipped.has(rule.pattern)).map((rule) => ({ key: `domain ${rule.pattern}`, pattern: rule.pattern, kind: 'domain' as const, label: DOMAIN_LABELS[rule.type] }))
    },
    {
      title: 'Skipped',
      help: 'Always keep their original headers.',
      rows: settings.skiplist.map((pattern) => ({ key: `skip ${pattern}`, pattern, kind: 'skip' as const }))
    }
  ];
  const matches = (row: RuleRow) => !ruleFilter || [row.pattern, formatPatternForPeople(row.pattern), row.from ?? '', row.from ? formatPatternForPeople(row.from) : '', row.label ?? '']
    .some((text) => text.toLowerCase().includes(ruleFilter));

  list.textContent = '';
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'rule-empty';
    empty.textContent = 'No rules yet. Unblock a call from the popup or the list of requests below, or add one above.';
    list.append(empty);
    return;
  }

  let shown = 0;
  groups.forEach((group) => {
    const rows = group.rows.filter(matches);
    if (rows.length === 0) {
      return;
    }
    shown += rows.length;
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    const help = document.createElement('span');
    const items = document.createElement('ul');
    section.className = 'rule-group';
    heading.textContent = `${group.title} (${rows.length})`;
    help.className = 'rule-group__help';
    help.textContent = group.help;
    heading.append(' ', help);
    items.className = 'rule-lines';
    rows.forEach((row) => items.append(editing?.key === row.key ? createEditRow(row) : createRuleRow(row)));
    section.append(heading, items);
    list.append(section);
  });

  if (shown === 0) {
    const empty = document.createElement('p');
    empty.className = 'rule-empty';
    empty.textContent = `No rules match "${ruleFilter}".`;
    list.append(empty);
  }
}

function createRuleRow(row: RuleRow): HTMLLIElement {
  const { key, pattern, kind, from, label } = row;
  const item = document.createElement('li');
  const main = document.createElement('div');
  const name = document.createElement('span');
  const chips = document.createElement('span');
  const actions = document.createElement('span');
  const anyOrigin = settings.anyOriginTargets.includes(pattern);
  const customMethods = settings.methodOverrides[pattern];
  const setByPolicy = kind === 'enabled' && settings.policy.trustedPages.includes(pattern);
  const hasOptions = kind !== 'skip' && !setByPolicy;

  item.className = 'rule-line';
  item.dataset.kind = kind;
  main.className = 'rule-line__main';
  name.className = 'rule-line__name';
  name.textContent = formatPatternForPeople(pattern);
  // The exact pattern is syntax; it shows on hover and while editing.
  name.title = from ? `${pattern} from ${from}` : pattern;
  chips.className = 'rule-line__chips';
  if (from) {
    appendChip(chips, `from ${formatPatternForPeople(from)}`);
  }
  if (label) {
    appendChip(chips, label);
  }
  if (anyOrigin) {
    appendChip(chips, 'Any site may read', 'warning');
  }
  if (customMethods && hasOptions) {
    appendChip(chips, customMethods.join(', '));
  }
  if (setByPolicy) {
    appendChip(chips, 'Set by your organization');
  }
  main.append(name, chips);

  actions.className = 'rule-line__actions';
  if (setByPolicy) {
    item.append(main, actions);
    return item;
  }
  if (kind !== 'domain') {
    actions.append(createRowButton('Edit', `Edit ${formatPatternForPeople(pattern)}`, () => {
      editing = { key, pattern, from: from ?? '' };
      renderRules();
      list?.querySelector<HTMLInputElement>('.rule-edit input')?.focus();
    }));
  }
  if (hasOptions) {
    const optionsButton = createRowButton('Options', `Options for ${formatPatternForPeople(pattern)}`, () => {
      if (openRuleOptions.has(key)) {
        openRuleOptions.delete(key);
      } else {
        openRuleOptions.add(key);
      }
      renderRules();
    });
    optionsButton.setAttribute('aria-expanded', String(openRuleOptions.has(key)));
    actions.append(optionsButton);
  }
  const removeButton = createRowButton('Remove', `Remove ${formatPatternForPeople(pattern)}`, () => void (kind === 'call' && from
    ? removeCallRule({ target: pattern, from })
    : removePattern(pattern, kind === 'call' ? 'enabled' : kind)));
  removeButton.classList.add('danger-button');
  actions.append(removeButton);

  item.append(main, actions);
  if (hasOptions && openRuleOptions.has(key)) {
    const options = document.createElement('div');
    options.className = 'rule-line__options';
    // An unblocked call is already scoped to one page, so "Any site may read" does not apply to it.
    options.append(...(kind === 'call' ? [] : [createAnyOriginToggle(pattern)]), createMethodEditor(pattern));
    options.querySelector('details')?.setAttribute('open', '');
    item.append(options);
  }
  return item;
}

function createRowButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button rule-line__button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

// The row in edit mode: the exact pattern (and page, for a call) in inputs. Enter saves, Escape cancels.
function createEditRow(row: RuleRow): HTMLLIElement {
  const item = document.createElement('li');
  const editForm = document.createElement('form');
  const patternInput = document.createElement('input');
  const save = document.createElement('button');
  const cancel = createRowButton('Cancel', 'Cancel editing', () => {
    editing = null;
    renderRules();
  });

  item.className = 'rule-line rule-line--editing';
  item.dataset.kind = row.kind;
  editForm.className = 'rule-edit';
  editForm.noValidate = true;
  patternInput.value = editing?.pattern ?? row.pattern;
  patternInput.setAttribute('aria-label', row.kind === 'call' ? 'API URL' : 'Pattern');
  patternInput.addEventListener('input', () => {
    if (editing) {
      editing.pattern = patternInput.value;
    }
  });
  editForm.append(patternInput);
  if (row.kind === 'call') {
    const fromInput = document.createElement('input');
    fromInput.value = editing?.from ?? row.from ?? '';
    fromInput.setAttribute('aria-label', 'Only from page');
    fromInput.addEventListener('input', () => {
      if (editing) {
        editing.from = fromInput.value;
      }
    });
    editForm.append(fromInput);
  }
  save.type = 'submit';
  save.textContent = 'Save';
  editForm.append(save, cancel);
  editForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveEdit(row);
  });
  editForm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      editing = null;
      renderRules();
    }
  });
  item.append(editForm);
  return item;
}

// Replaces a rule's pattern (and page, for a call), carrying over its custom methods and opt-ins.
async function saveEdit(row: RuleRow): Promise<void> {
  if (!editing) {
    return;
  }
  const next = normalizePattern(editing.pattern);
  const nextFrom = row.kind === 'call' ? normalizePattern(editing.from) : null;
  if (!next || (row.kind === 'call' && !nextFrom)) {
    setMessage(row.kind === 'call' && !nextFrom ? 'Enter the page that makes the call, such as localhost:3000.' : `"${editing.pattern}" is not a valid pattern.`, true);
    return;
  }

  const rename = <T>(values: T[], from: T, to: T) => [...new Set(values.map((value) => (value === from ? to : value)))];
  const methodOverrides = { ...settings.methodOverrides };
  if (next !== row.pattern && methodOverrides[row.pattern]) {
    methodOverrides[next] = methodOverrides[row.pattern] ?? [];
    delete methodOverrides[row.pattern];
  }
  let change: Partial<ExtensionSettings>;
  if (row.kind === 'call' && nextFrom) {
    const callRules = settings.callRules.map((rule) => (rule.target === row.pattern && rule.from === row.from ? { target: next, from: nextFrom } : rule));
    change = { callRules, methodOverrides };
  } else if (row.kind === 'skip') {
    change = { skiplist: rename(settings.skiplist, row.pattern, next), whitelist: settings.whitelist.filter((item) => item !== next) };
  } else {
    change = {
      whitelist: rename(settings.whitelist, row.pattern, next),
      skiplist: settings.skiplist.filter((item) => item !== next),
      anyOriginTargets: rename(settings.anyOriginTargets, row.pattern, next),
      methodOverrides
    };
  }

  setBusy(true);
  try {
    settings = await settingsController.update(change);
    editing = null;
    setMessage(`Saved ${formatPatternForPeople(next)}.`, false);
    render();
  } catch {
    setMessage('Unable to save the rule.', true);
  } finally {
    setBusy(false);
  }
}

function appendChip(target: HTMLElement, text: string, tone?: string): void {
  const chip = document.createElement('span');
  chip.className = 'rule-chip';
  if (tone) {
    chip.dataset.tone = tone;
  }
  chip.textContent = text;
  target.append(chip);
}

function renderDiscoveredRequests(): void {
  if (!discoveredList) {
    return;
  }

  discoveredList.textContent = '';
  const visibleRequests = collapseDiscoveredRequests(discoveredRequests);
  if (visibleRequests.length === 0) {
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = 'No requests discovered yet. Keep this page open while using your app.';
    discoveredList.append(item);
    return;
  }

  visibleRequests.forEach((request) => {
    const item = document.createElement('li');
    const details = document.createElement('div');
    const code = document.createElement('code');
    const source = document.createElement('small');
    const feedback = document.createElement('span');
    const actions = document.createElement('span');

    code.textContent = request.url;
    source.textContent = `Called by ${request.initiator ? formatPatternForPeople(getTrustPatternForRequest(request.initiator, request.initiator) ?? request.initiator) : 'an unknown page'} · ${request.count} time${request.count === 1 ? '' : 's'}`;
    source.className = 'request-source';
    feedback.className = 'row-feedback';
    feedback.setAttribute('aria-live', 'polite');
    details.append(code, source);

    // Unblock just this call from the page that made it; the page's other calls are unaffected.
    const callRule = getCallRuleForRequest(request.url, request.initiator);
    const unblock = createRowButton('Unblock', callRule
      ? `Unblock ${formatPatternForPeople(callRule.target)} from ${formatPatternForPeople(callRule.from)}`
      : `Trust ${formatPatternForPeople(getTrustPatternForRequest(request.url, request.initiator) ?? request.url)}`, () => void (callRule
      ? addCallRule(callRule, feedback)
      : addDiscoveredPattern(getTrustPatternForRequest(request.url, request.initiator) ?? request.url, 'enabled', feedback)));
    unblock.title = callRule ? `Only this URL, only from ${formatPatternForPeople(callRule.from)}` : '';
    const skip = createRowButton('Skip', `Skip ${request.url}`, () => void addDiscoveredPattern(request.url, 'skip', feedback));
    actions.className = 'item-actions';
    actions.append(unblock, skip);

    item.append(details, feedback, actions);
    discoveredList.append(item);
  });
}

function showRowFeedback(target: HTMLElement, text: string, afterHide?: () => void): void {
  target.textContent = text;
  target.dataset.visible = 'true';
  setTimeout(() => {
    if (target.textContent === text) {
      target.textContent = '';
      target.dataset.visible = 'false';
      afterHide?.();
    }
  }, 800);
}

function createMethodEditor(patternInput: string): HTMLDetailsElement {
  const pattern = normalizeMethodOverridePattern(patternInput) ?? patternInput;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const options = document.createElement('span');
  const selectedMethods = settings.methodOverrides[pattern] ?? settings.allowMethods;

  details.className = 'method-editor';
  summary.textContent = `Methods (${selectedMethods.length})`;
  summary.title = selectedMethods.join(', ');
  options.className = 'method-options';

  DEFAULT_ALLOW_METHODS.forEach((method) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    label.className = 'method-chip';
    checkbox.type = 'checkbox';
    checkbox.value = method;
    checkbox.checked = selectedMethods.includes(method);
    checkbox.addEventListener('change', () => {
      const methods = [...options.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
      if (methods.length === 0) {
        checkbox.checked = true;
        return;
      }
      void updatePatternMethods(pattern, methods);
    });
    label.append(checkbox, method);
    options.append(label);
  });

  details.append(summary, options);
  return details;
}

function createAnyOriginToggle(pattern: string): HTMLLabelElement {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  const text = document.createElement('span');
  const enabled = settings.anyOriginTargets.includes(pattern);

  label.className = 'any-origin-toggle';
  label.dataset.enabled = String(enabled);
  label.title = 'Off: only requests made by this page are relaxed. On: any website can also read responses from this pattern.';
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.addEventListener('change', () => void updateAnyOriginTarget(pattern, checkbox.checked));
  text.textContent = enabled ? 'Any site may read (⚠ every website can read these responses)' : 'Any site may read';
  label.append(checkbox, text);
  return label;
}

async function updateAnyOriginTarget(pattern: string, enabled: boolean): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update({
      anyOriginTargets: enabled
        ? [...new Set([...settings.anyOriginTargets, pattern])]
        : settings.anyOriginTargets.filter((target) => target !== pattern)
    });
    setMessage(enabled ? 'Any website can now read responses from this pattern.' : 'Only requests made by this page are relaxed.', false);
    render();
  } catch {
    setMessage('Unable to update who may read this pattern.', true);
  } finally {
    setBusy(false);
  }
}

async function updatePatternMethods(pattern: string, methods: string[]): Promise<void> {
  setBusy(true);
  try {
    settings = await settingsController.update({
      methodOverrides: { ...settings.methodOverrides, [pattern]: methods }
    });
    setMessage('Allowed methods updated for this link.', false);
    render();
  } catch {
    setMessage('Unable to update methods for this link.', true);
  } finally {
    setBusy(false);
  }
}

// Confirmations and errors appear as a short toast, so they are visible wherever the page is scrolled.
function setMessage(text: string, isError: boolean): void {
  if (!toastElement) {
    return;
  }
  toastElement.textContent = text;
  toastElement.dataset.error = String(isError);
  toastElement.setAttribute('role', isError ? 'alert' : 'status');
  toastElement.hidden = false;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
  }, isError ? 8_000 : 4_000);
}

// Mistakes in the add form stay next to the form.
function setFormError(text: string): void {
  if (!message) {
    return;
  }
  message.textContent = text;
  message.dataset.error = String(Boolean(text));
  if (messageTimer) {
    clearTimeout(messageTimer);
  }
}

// What the organization enforces, in one sentence at the top of Settings.
function renderPolicyNotice(): void {
  if (!policyNotice) {
    return;
  }
  const { overridesOff, trustedPages, everyWebsiteBlocked } = settings.policy;
  const parts = [
    ...(overridesOff ? ['keeps CORS overrides off'] : []),
    ...(trustedPages.length > 0 ? [`trusts ${trustedPages.length === 1 ? '1 page' : `${trustedPages.length} pages`} for you`] : []),
    ...(everyWebsiteBlocked ? ['doesn\u2019t allow "Every website"'] : [])
  ];
  policyNotice.hidden = parts.length === 0;
  policyNotice.textContent = parts.length === 0 ? '' : `Managed by your organization: it ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`;
}

// Controls the policy decides stay disabled, busy or not.
function lockPolicyControls(isBusy: boolean): void {
  if (enabledInput) {
    enabledInput.disabled = isBusy || settings.policy.overridesOff;
  }
  modeInputs.forEach((input) => {
    input.disabled = isBusy || (input.value === 'global' && settings.policy.everyWebsiteBlocked);
  });
}

function setBusy(isBusy: boolean): void {
  form?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
    control.disabled = isBusy;
  });
  document.querySelectorAll<HTMLButtonElement>('.item-actions button, .rule-line__actions button').forEach((button) => {
    button.disabled = isBusy;
  });
  document.querySelectorAll<HTMLInputElement>('.method-options input').forEach((input) => {
    input.disabled = isBusy;
  });
  [allowAllHeadersInput, ...methodInputs].forEach((input) => {
    if (input) {
      input.disabled = isBusy;
    }
  });
  [selectAllMethodsButton, selectDefaultMethodsButton].forEach((button) => {
    if (button) {
      button.disabled = isBusy;
    }
  });
  if (allowCredentialsInput) {
    allowCredentialsInput.disabled = isBusy || !isCredentialsSupported(settings);
  }
  if (themeSelect) {
    themeSelect.disabled = isBusy;
  }
  if (resetButton) {
    resetButton.disabled = isBusy;
  }
  lockPolicyControls(isBusy);
}
