import {
  DiscoveredRequest,
  SettingsController,
  collapseDiscoveredRequests,
  loadDiscoveredRequests,
  onDiscoveredRequestsChanged,
  toLoggedUrl
} from '../shared/browserApi';
import { CorsFix, CorsIssue, PlannedCorsIssue, applyCorsFixes, collectCorsFixes, describeCorsCall, describeCorsFix, describeCorsProblem, isOpenCorsIssue, planCorsIssues, planIssueFix } from '../shared/corsDiagnosis';
import { loadTabCorsIssues, onTabCorsIssuesChanged } from '../shared/corsMonitor';
import { DEFAULT_ALLOW_METHODS, DomainRuleType, EffectiveCorsRule, ExtensionSettings, exportRules, formatPatternForPeople, getAllowedMethodsForRequest, getEffectiveCorsRuleForRequest, getTrustPatternForRequest, importRules, isCorsEnabledForRequest, isCorsSkippedForRequest, normalizeMethodOverridePattern, normalizePattern } from '../shared/settings';
import { getStatusText } from '../shared/statusText';
import { applyTheme } from '../shared/theme';

type RuleEntry = { pattern: string; kind: 'url' | 'domain'; list: 'active' | 'skip'; domainType?: DomainRuleType };

const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const noticeElement = document.querySelector<HTMLElement>('#notice');
const pageUrlElement = document.querySelector<HTMLElement>('#page-url');
const coverageElement = document.querySelector<HTMLElement>('#coverage');
const effectiveRuleElement = document.querySelector<HTMLElement>('#effective-rule');
const effectiveMethodsElement = document.querySelector<HTMLElement>('#effective-methods');
const addDomainRuleButton = document.querySelector<HTMLButtonElement>('#add-domain-rule');
const allowPageButton = document.querySelector<HTMLButtonElement>('#allow-page');
const powerLabel = document.querySelector<HTMLElement>('#power-label');
const panelStatus = document.querySelector<HTMLElement>('#panel-status');
const globalWarning = document.querySelector<HTMLElement>('#global-warning');
const leaveGlobalButton = document.querySelector<HTMLButtonElement>('#leave-global');
const currentLinks = document.querySelector<HTMLUListElement>('#current-links');
const copyCurrentLinksButton = document.querySelector<HTMLButtonElement>('#copy-current-links');
const rulesList = document.querySelector<HTMLUListElement>('#rules-list');
const rulesStatus = document.querySelector<HTMLElement>('#rules-status');
const addActiveRuleButton = document.querySelector<HTMLButtonElement>('#add-active-rule');
const addSkipRuleButton = document.querySelector<HTMLButtonElement>('#add-skip-rule');
const ruleFilterButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-rule-filter]')];
const rulesError = document.querySelector<HTMLElement>('#rules-error');
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
const tabPanels = [...document.querySelectorAll<HTMLElement>('.tab-panel')];
const currentLinkFilterInput = document.querySelector<HTMLInputElement>('#current-link-filter-input');
const rulesFilterInput = document.querySelector<HTMLInputElement>('#rules-filter-input');
const clearCurrentLinkFilterButton = document.querySelector<HTMLButtonElement>('#clear-current-link-filter');
const clearRulesFilterButton = document.querySelector<HTMLButtonElement>('#clear-rules-filter');
const requestScopeHelp = document.querySelector<HTMLElement>('#request-scope-help');
const requestScopeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-request-scope]')];
const exportRulesButton = document.querySelector<HTMLButtonElement>('#export-rules');
const importRulesButton = document.querySelector<HTMLButtonElement>('#import-rules');
const importRulesFile = document.querySelector<HTMLInputElement>('#import-rules-file');
const importPreview = document.querySelector<HTMLElement>('#import-preview');
const importPreviewSummary = document.querySelector<HTMLElement>('#import-preview-summary');
const confirmImportRulesButton = document.querySelector<HTMLButtonElement>('#confirm-import-rules');
const cancelImportRulesButton = document.querySelector<HTMLButtonElement>('#cancel-import-rules');
const currentCount = document.querySelector<HTMLElement>('#current-count');
const currentRequestCount = document.querySelector<HTMLElement>('#current-request-count');
const otherCount = document.querySelector<HTMLElement>('#other-count');
const rulesCount = document.querySelector<HTMLElement>('#rules-count');
const blockedTabCount = document.querySelector<HTMLElement>('#blocked-tab-count');
const corsBlockedSection = document.querySelector<HTMLElement>('#cors-blocked');
const corsBlockedSummary = document.querySelector<HTMLElement>('#cors-blocked-summary');
const corsBlockedList = document.querySelector<HTMLUListElement>('#cors-blocked-list');
const fixAllCorsButton = document.querySelector<HTMLButtonElement>('#fix-all-cors');
const reloadInspectedButton = document.querySelector<HTMLButtonElement>('#reload-inspected');

let settings: ExtensionSettings;
let inspectedUrl: string | null = null;
let inspectedPattern: string | null = null;
let inspectedTabId = -1;
let discoveredRequests: DiscoveredRequest[] = [];
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let ruleListFilter: 'all' | 'active' | 'skip' = 'all';
let openMethodPatterns = new Set<string>();
let collapsedRequestGroups = new Set<string>();
let suppressNextSettingsRender = false;
let pendingImportedSettings: Partial<ExtensionSettings> | null = null;
let requestScope: 'current' | 'other' = 'current';
let corsIssues: CorsIssue[] = [];
// Once someone picks a tab, the panel stops switching tabs on its own.
let userPickedTab = false;
// Calls that failed and that the current settings now fix; they need a page reload to retry.
const fixedSinceOpen = new Set<string>();
const settingsController = new SettingsController();

void initialize();

async function initialize(): Promise<void> {
  try {
    settings = await settingsController.initialize();
    inspectedUrl = await getInspectedUrl();
    inspectedTabId = chrome.devtools.inspectedWindow.tabId;
    // Trust the whole origin: a single-page app changes paths without reloading.
    inspectedPattern = inspectedUrl ? getTrustPatternForRequest(inspectedUrl, inspectedUrl) : null;
    discoveredRequests = await loadDiscoveredRequests();
    corsIssues = await loadTabCorsIssues(inspectedTabId);
    onTabCorsIssuesChanged(inspectedTabId, (issues) => {
      corsIssues = issues;
      // A reload or navigation starts over, so earlier fixes no longer need a retry.
      if (issues.length === 0) {
        fixedSinceOpen.clear();
      }
      renderCorsBlocked();
      syncLinkStatuses();
    });
    render();
    settingsController.subscribe((nextSettings) => {
      settings = nextSettings;
      if (suppressNextSettingsRender) {
        suppressNextSettingsRender = false;
        renderRules();
        return;
      }
      render();
    });
    onDiscoveredRequestsChanged((requests) => {
      discoveredRequests = mergeRequests(discoveredRequests, requests);
      scheduleRenderLinks();
    });
    chrome.devtools.network.onRequestFinished.addListener((request) => {
      const url = request.request.url;
      if (!/^https?:\/\//.test(url)) {
        return;
      }

      observeRequest(url);
    });
  } catch {
    setStatus('Unable to load settings', true);
  }

  enabledInput?.addEventListener('change', () => {
    // Switching off by hand ends any pause too: off means off.
    void updateSettings(enabledInput.checked ? { enabled: true } : { enabled: false, pausedUntil: null });
  });
  leaveGlobalButton?.addEventListener('click', () => {
    void updateSettings({ mode: 'whitelist' });
    showNotice('Only trusted pages get relaxed CORS now.', false);
  });

  // Trusts the page's origin and turns overrides on, like the popup, so one click makes the page work.
  allowPageButton?.addEventListener('click', () => {
    if (inspectedPattern) {
      void applyCorsFixesFromPanel([
        ...(settings.enabled ? [] : [{ kind: 'enable' } as const]),
        { kind: 'trust-page', pattern: inspectedPattern }
      ], `${formatPatternForPeople(inspectedPattern)} is trusted. Reload the page to retry blocked calls.`);
    }
  });

  addDomainRuleButton?.addEventListener('click', addNewDomainRule);
  fixAllCorsButton?.addEventListener('click', () => {
    void applyCorsFixesFromPanel(collectCorsFixes(planCorsIssues(corsIssues, settings)), 'Fixed. Reload the page to retry the blocked calls.');
  });
  reloadInspectedButton?.addEventListener('click', () => {
    chrome.devtools.inspectedWindow.reload({});
  });

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      userPickedTab = true;
      activateTab(button);
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        return;
      }

      event.preventDefault();
      userPickedTab = true;
      const currentIndex = tabButtons.indexOf(button);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabButtons.length - 1
          : (currentIndex + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + tabButtons.length) % tabButtons.length;
      tabButtons[nextIndex]?.focus();
      if (tabButtons[nextIndex]) {
        activateTab(tabButtons[nextIndex]);
      }
    });
  });
  currentLinkFilterInput?.addEventListener('input', scheduleRenderLinks);
  rulesFilterInput?.addEventListener('input', renderRules);
  copyCurrentLinksButton?.addEventListener('click', () => {
    void copyCurrentRequestUrls();
  });
  clearCurrentLinkFilterButton?.addEventListener('click', () => {
    if (currentLinkFilterInput) {
      currentLinkFilterInput.value = '';
      currentLinkFilterInput.focus();
      renderLinks();
    }
  });
  requestScopeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      requestScope = button.dataset.requestScope === 'other' ? 'other' : 'current';
      requestScopeButtons.forEach((scopeButton) => scopeButton.classList.toggle('is-active', scopeButton === button));
      renderLinks();
    });
  });
  clearRulesFilterButton?.addEventListener('click', () => {
    if (rulesFilterInput) {
      rulesFilterInput.value = '';
      rulesFilterInput.focus();
      renderRules();
    }
  });
  exportRulesButton?.addEventListener('click', exportCurrentRules);
  importRulesButton?.addEventListener('click', () => importRulesFile?.click());
  importRulesFile?.addEventListener('change', () => void importRulesFromFile());
  confirmImportRulesButton?.addEventListener('click', () => void confirmRulesImport());
  cancelImportRulesButton?.addEventListener('click', clearImportPreview);
  addActiveRuleButton?.addEventListener('click', () => addNewRule('active'));
  addSkipRuleButton?.addEventListener('click', () => addNewRule('skip'));
  ruleFilterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextFilter = button.dataset.ruleFilter as 'all' | 'active' | 'skip';
      ruleListFilter = nextFilter;
      ruleFilterButtons.forEach((filterButton) => filterButton.classList.toggle('is-active', filterButton === button));
      renderRules();
    });
  });
}

function observeRequest(requestUrl: string): void {
  const url = toLoggedUrl(requestUrl);
  if (!url) {
    return;
  }

  const existing = discoveredRequests.find((request) => request.url === url && request.tabId === inspectedTabId);
  const observed: DiscoveredRequest = existing
    ? { ...existing, count: existing.count + 1, lastSeen: Date.now() }
    : { url, initiator: inspectedUrl, tabId: inspectedTabId, count: 1, lastSeen: Date.now() };

  discoveredRequests = mergeRequests(discoveredRequests, [observed]);
  scheduleRenderLinks();
}

function scheduleRenderLinks(): void {
  if (renderTimer) {
    return;
  }

  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    renderLinks();
  }, 100);
}

function renderRules(): void {
  if (!rulesList || !rulesStatus) {
    return;
  }

  rulesStatus.textContent = settings.enabled
    ? settings.mode === 'global' ? 'CORS is enabled globally.' : 'CORS is enabled for active patterns only.'
    : 'CORS is currently disabled.';
  const filter = rulesFilterInput?.value.trim().toLowerCase() ?? '';
  const domainPatternSet = new Set(settings.domainRules.map((rule) => rule.pattern));
  const activeEntries: RuleEntry[] = [
    ...(settings.mode === 'global' ? [{ pattern: '<all_urls>', kind: 'url' as const, list: 'active' as const }] : settings.whitelist.filter((pattern) => !domainPatternSet.has(pattern)).map((pattern) => ({ pattern, kind: 'url' as const, list: 'active' as const }))),
    ...settings.domainRules.filter((rule) => !settings.skiplist.includes(rule.pattern)).map((rule) => ({ pattern: rule.pattern, kind: 'domain' as const, list: 'active' as const, domainType: rule.type }))
  ];
  const skippedEntries: RuleEntry[] = [
    ...settings.skiplist.filter((pattern) => !domainPatternSet.has(pattern)).map((pattern) => ({ pattern, kind: 'url' as const, list: 'skip' as const })),
    ...settings.domainRules.filter((rule) => settings.skiplist.includes(rule.pattern)).map((rule) => ({ pattern: rule.pattern, kind: 'domain' as const, list: 'skip' as const, domainType: rule.type }))
  ];
  const visibleEntries = [...activeEntries, ...skippedEntries]
    .filter((entry) => ruleListFilter === 'all' || entry.list === ruleListFilter)
    .filter((entry) => !filter || entry.pattern.toLowerCase().includes(filter));
  renderRuleList(rulesList, visibleEntries, Boolean(filter));
  if (rulesCount) {
    rulesCount.textContent = String(new Set(visibleEntries.map((entry) => entry.pattern)).size);
  }
}

function renderRuleList(target: HTMLUListElement, entries: RuleEntry[], isFiltered: boolean): void {
  target.textContent = '';
  if (entries.length === 0) {
    const item = document.createElement('li');
    const message = document.createElement('span');
    item.className = 'empty-rule';
    message.textContent = isFiltered ? 'No matching rules.' : 'No rules configured yet.';
    item.append(message);
    if (!isFiltered) {
      const addButton = document.createElement('button');
      const skipButton = document.createElement('button');
      const domainButton = document.createElement('button');
      addButton.type = 'button';
      addButton.textContent = 'Add active URL';
      addButton.addEventListener('click', () => addNewRule('active'));
      skipButton.type = 'button';
      skipButton.textContent = 'Add skip URL';
      skipButton.addEventListener('click', () => addNewRule('skip'));
      domainButton.type = 'button';
      domainButton.textContent = 'Add domain rule';
      domainButton.addEventListener('click', addNewDomainRule);
      item.append(addButton, skipButton, domainButton);
    }
    target.append(item);
    return;
  }

  const groups: Array<{ title: string; entries: RuleEntry[] }> = [
    { title: 'Active page and origin rules', entries: entries.filter((entry) => entry.list === 'active' && entry.kind === 'url') },
    { title: 'Active domain rules', entries: entries.filter((entry) => entry.list === 'active' && entry.kind === 'domain') },
    { title: 'Skipped page and origin rules', entries: entries.filter((entry) => entry.list === 'skip' && entry.kind === 'url') },
    { title: 'Skipped domain rules', entries: entries.filter((entry) => entry.list === 'skip' && entry.kind === 'domain') }
  ].filter((group) => ruleListFilter === 'all' || group.entries.every((entry) => entry.list === ruleListFilter));

  groups.filter((group) => group.entries.length > 0).forEach((group) => {
    const heading = document.createElement('li');
    heading.className = 'rule-group-heading';
    heading.textContent = `${group.title} (${group.entries.length})`;
    target.append(heading);
    group.entries.forEach((entry) => renderRuleItem(target, entry));
  });
}

function renderRuleItem(target: HTMLUListElement, entry: RuleEntry): void {
  const pattern = entry.pattern;
  const item = document.createElement('li');
  const code = document.createElement('code');
  const meta = document.createElement('small');
  const listStatus = document.createElement('span');
  const actions = document.createElement('span');
  const controls = document.createElement('span');
  const override = settings.methodOverrides[pattern];

  code.textContent = pattern;
  listStatus.textContent = entry.list === 'active' ? 'Active' : 'Skipped';
  listStatus.className = 'rule-status';
  listStatus.dataset.state = entry.list;
  meta.className = 'rule-meta';
  appendRuleBadge(meta, getRuleSourceLabel(entry));
  if (entry.kind === 'domain' && entry.domainType) {
    appendRuleBadge(meta, entry.domainType.replace('_', '-'));
  }
  const anyOrigin = settings.anyOriginTargets.includes(pattern);
  if (anyOrigin) {
    appendRuleBadge(meta, 'Any site may read', 'warning');
  } else if (entry.kind === 'domain' && entry.domainType === 'first_party') {
    appendRuleBadge(meta, 'No effect until any site may read', 'warning');
  }
  appendRuleBadge(meta, override ? 'Custom methods' : 'Default methods', override ? 'custom' : undefined);
  meta.append(document.createTextNode((override ?? settings.allowMethods).join(', ')));
  if (entry.list === 'active' && pattern !== '<all_urls>') {
    meta.append(createAnyOriginToggle(pattern, anyOrigin));
  }
  item.className = 'rule-item';
  controls.className = 'rule-controls';
  if (entry.kind === 'url' && pattern !== '<all_urls>') {
      const editButton = document.createElement('button');
      const removeButton = document.createElement('button');
      const moveButton = document.createElement('button');
      editButton.className = 'icon-button';
      removeButton.className = 'icon-button danger-button';
      moveButton.className = 'icon-button';
      editButton.type = 'button';
      editButton.textContent = '✎';
      editButton.setAttribute('aria-label', `Edit ${pattern}`);
      editButton.title = 'Edit pattern';
      editButton.addEventListener('click', () => beginRuleEdit(item, pattern, entry.list));
      item.addEventListener('dblclick', () => beginRuleEdit(item, pattern, entry.list));
      removeButton.type = 'button';
      removeButton.textContent = '×';
      removeButton.setAttribute('aria-label', `Remove ${pattern}`);
      removeButton.title = 'Remove pattern';
      removeButton.addEventListener('click', () => void removeRule(pattern, entry.list));
      moveButton.type = 'button';
      moveButton.textContent = entry.list === 'active' ? '→' : '←';
      moveButton.setAttribute('aria-label', entry.list === 'active' ? `Move ${pattern} to skip list` : `Move ${pattern} to active list`);
      moveButton.title = entry.list === 'active' ? 'Move to skip list' : 'Move to active list';
      moveButton.addEventListener('click', () => void moveRule(pattern, entry.list));
      actions.className = 'rule-actions';
      actions.append(editButton, removeButton, moveButton);
  } else if (entry.kind === 'domain') {
      const removeButton = document.createElement('button');
      const moveButton = document.createElement('button');
      removeButton.className = 'icon-button danger-button';
      removeButton.type = 'button';
      removeButton.textContent = '×';
      removeButton.setAttribute('aria-label', `Remove ${pattern} domain rule`);
      removeButton.title = 'Remove domain rule';
      removeButton.addEventListener('click', () => void removeDomainRule(pattern));
      moveButton.className = 'icon-button';
      moveButton.type = 'button';
      moveButton.textContent = entry.list === 'active' ? '→' : '←';
      moveButton.setAttribute('aria-label', entry.list === 'active' ? `Move ${pattern} to skip list` : `Move ${pattern} to active list`);
      moveButton.title = entry.list === 'active' ? 'Move to skip list' : 'Move to active list';
      moveButton.addEventListener('click', () => void moveDomainRule(pattern, entry.list));
      actions.className = 'rule-actions';
      actions.append(removeButton, moveButton);
  }
  controls.append(listStatus, actions);
  item.append(code, meta, controls);
  target.append(item);
}

function createAnyOriginToggle(pattern: string, enabled: boolean): HTMLLabelElement {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  label.className = 'any-origin-toggle';
  label.title = 'Off: only requests made by this page are relaxed. On: any website can also read responses from this pattern.';
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.setAttribute('aria-label', `Let any site read responses from ${pattern}`);
  checkbox.addEventListener('change', () => {
    void updateSettings({
      anyOriginTargets: checkbox.checked
        ? [...new Set([...settings.anyOriginTargets, pattern])]
        : settings.anyOriginTargets.filter((target) => target !== pattern)
    });
  });
  label.append(checkbox, 'Any site may read');
  return label;
}

function getRuleSourceLabel(entry: RuleEntry): string {
  if (entry.pattern === '<all_urls>') {
    return 'Global';
  }
  if (entry.kind === 'domain') {
    return 'Domain';
  }
  return entry.pattern.endsWith('/*') && /^https?:\/\/[^/]+\/\*$/.test(entry.pattern) ? 'Origin' : 'Page';
}

function appendRuleBadge(target: HTMLElement, text: string, state?: string): void {
  const badge = document.createElement('span');
  badge.className = 'rule-badge';
  if (state) {
    badge.dataset.state = state;
  }
  badge.textContent = text;
  target.append(badge);
}

function addNewRule(kind: 'active' | 'skip'): void {
  const target = rulesList;
  if (!target || target.querySelector('.rule-item--new')) {
    return;
  }

  const item = document.createElement('li');
  const editor = document.createElement('div');
  const input = document.createElement('input');
  const actions = document.createElement('span');
  const saveButton = document.createElement('button');
  const cancelButton = document.createElement('button');
  const methodOptions = createMethodOptions(settings.allowMethods);

  item.className = 'rule-item rule-item--new';
  editor.className = 'inline-rule-editor';
  input.type = 'text';
  input.placeholder = 'https://api.example.com or *.example.com';
  input.setAttribute('aria-label', 'New URL pattern');
  saveButton.type = 'button';
  saveButton.className = 'icon-button';
  saveButton.textContent = '✓';
  saveButton.setAttribute('aria-label', 'Save new pattern');
  saveButton.title = 'Save new pattern';
  cancelButton.type = 'button';
  cancelButton.className = 'icon-button';
    cancelButton.textContent = '×';
    cancelButton.className = 'icon-button danger-button';
  cancelButton.setAttribute('aria-label', 'Cancel new pattern');
  cancelButton.title = 'Cancel';
  actions.className = 'rule-actions';
  actions.append(saveButton, cancelButton);
  editor.append(input, actions);
  item.append(editor, methodOptions);
  target.prepend(item);
  input.focus();

  saveButton.addEventListener('click', () => void saveNewRule(input.value, kind, methodOptions));
  cancelButton.addEventListener('click', () => renderRules());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void saveNewRule(input.value, kind, methodOptions);
    }
    if (event.key === 'Escape') {
      renderRules();
    }
  });
}

function addNewDomainRule(): void {
  const target = rulesList;
  if (!target || target.querySelector('.rule-item--new')) {
    return;
  }

  const item = document.createElement('li');
  const editor = document.createElement('div');
  const input = document.createElement('input');
  const typeSelect = document.createElement('select');
  const actions = document.createElement('span');
  const saveButton = document.createElement('button');
  const cancelButton = document.createElement('button');

  item.className = 'rule-item rule-item--new';
  editor.className = 'inline-rule-editor';
  input.type = 'text';
  input.placeholder = 'https://app.example.com';
  input.setAttribute('aria-label', 'Domain or base URL');
  typeSelect.setAttribute('aria-label', 'Domain rule type');
  const domainTypeOptions: Array<[DomainRuleType, string]> = [['both', 'Both'], ['first_party', 'First-party'], ['third_party', 'Third-party']];
  domainTypeOptions.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.append(option);
  });
  saveButton.type = 'button';
  saveButton.className = 'icon-button';
  saveButton.textContent = '✓';
  saveButton.setAttribute('aria-label', 'Save domain rule');
  saveButton.title = 'Save domain rule';
  cancelButton.type = 'button';
  cancelButton.className = 'icon-button danger-button';
  cancelButton.textContent = '×';
  cancelButton.setAttribute('aria-label', 'Cancel new domain rule');
  cancelButton.title = 'Cancel';
  actions.className = 'rule-actions';
  actions.append(saveButton, cancelButton);
  editor.append(input, typeSelect, actions);
  item.append(editor);
  target.prepend(item);
  input.focus();

  saveButton.addEventListener('click', () => void saveNewDomainRule(input.value, typeSelect.value as DomainRuleType));
  cancelButton.addEventListener('click', () => renderRules());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void saveNewDomainRule(input.value, typeSelect.value as DomainRuleType);
    }
    if (event.key === 'Escape') {
      renderRules();
    }
  });
}

async function saveNewDomainRule(value: string, type: DomainRuleType): Promise<void> {
  const pattern = normalizePattern(value);
  if (!pattern) {
    setFieldError(rulesError, 'Enter a valid domain or base URL.');
    return;
  }

  await updateSettings({ domainRules: [...settings.domainRules, { pattern, type }] });
  showNotice('Domain added.', false);
}

async function saveNewRule(value: string, kind: 'active' | 'skip', methodOptions: HTMLElement): Promise<void> {
  const pattern = normalizePattern(value);
  const methods = [...methodOptions.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
  if (!pattern) {
    setFieldError(rulesError, 'Enter a valid URL pattern.');
    return;
  }
  if (methods.length === 0) {
    setFieldError(rulesError, 'Select at least one access method.');
    return;
  }

  const nextOverrides = { ...settings.methodOverrides, [pattern]: methods };
  await updateSettings(kind === 'active'
    ? { whitelist: [...new Set([...settings.whitelist, pattern])], methodOverrides: nextOverrides }
    : { whitelist: settings.whitelist.filter((item) => item !== pattern), skiplist: [...new Set([...settings.skiplist, pattern])], methodOverrides: nextOverrides });
  showNotice(kind === 'active' ? 'URL added to active rules.' : 'URL added to skipped rules.', false);
}

async function removeRule(pattern: string, kind: 'active' | 'skip'): Promise<void> {
  const nextOverrides = { ...settings.methodOverrides };
  delete nextOverrides[pattern];
  await updateSettings(kind === 'active'
    ? { whitelist: settings.whitelist.filter((item) => item !== pattern), methodOverrides: nextOverrides }
    : { skiplist: settings.skiplist.filter((item) => item !== pattern), methodOverrides: nextOverrides });
}

async function removeDomainRule(pattern: string): Promise<void> {
  await updateSettings({
    domainRules: settings.domainRules.filter((rule) => rule.pattern !== pattern),
    whitelist: settings.whitelist.filter((item) => item !== pattern),
    skiplist: settings.skiplist.filter((item) => item !== pattern)
  });
}

async function moveDomainRule(pattern: string, from: 'active' | 'skip'): Promise<void> {
  await updateSettings(from === 'active'
    ? { skiplist: [...new Set([...settings.skiplist, pattern])] }
    : { skiplist: settings.skiplist.filter((item) => item !== pattern) });
}

async function moveRule(pattern: string, from: 'active' | 'skip'): Promise<void> {
  await updateRuleLists(pattern, from === 'active' ? 'skip' : 'active');
}

async function updateRuleLists(pattern: string, target: 'active' | 'skip'): Promise<void> {
  await updateSettings(target === 'active'
    ? {
      whitelist: [...new Set([...settings.whitelist, pattern])],
      skiplist: settings.skiplist.filter((item) => item !== pattern)
    }
    : {
      whitelist: settings.whitelist.filter((item) => item !== pattern),
      skiplist: [...new Set([...settings.skiplist, pattern])]
    });
}

function beginRuleEdit(target: HTMLLIElement, pattern: string, kind: 'active' | 'skip'): void {
  if (target.dataset.editing === 'true') {
    return;
  }

  target.dataset.editing = 'true';
  target.textContent = '';
  const editor = document.createElement('div');
  const input = document.createElement('input');
  const actions = document.createElement('span');
  const saveButton = document.createElement('button');
  const cancelButton = document.createElement('button');
  const methodOptions = createMethodOptions(settings.methodOverrides[pattern] ?? settings.allowMethods);

  editor.className = 'inline-rule-editor';
  input.type = 'text';
  input.value = pattern;
  input.setAttribute('aria-label', 'Edit URL pattern');
  saveButton.type = 'button';
  saveButton.className = 'icon-button';
  saveButton.textContent = '✓';
  saveButton.setAttribute('aria-label', 'Save pattern');
  saveButton.title = 'Save pattern';
  cancelButton.type = 'button';
  cancelButton.className = 'icon-button';
  cancelButton.textContent = '×';
  cancelButton.setAttribute('aria-label', 'Cancel editing');
  cancelButton.title = 'Cancel editing';
  actions.className = 'rule-actions';
  actions.append(saveButton, cancelButton);
  editor.append(input, actions);
  target.append(editor);
  target.append(methodOptions);
  input.focus();
  input.select();

  saveButton.addEventListener('click', () => void saveRuleEdit(input.value, pattern, kind, methodOptions));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void saveRuleEdit(input.value, pattern, kind, methodOptions);
    }
    if (event.key === 'Escape') {
      renderRules();
    }
  });
  cancelButton.addEventListener('click', () => renderRules());
}

function createMethodOptions(selectedMethods: string[]): HTMLSpanElement {
  const methodOptions = document.createElement('span');
  methodOptions.className = 'inline-method-options';
  DEFAULT_ALLOW_METHODS.forEach((method) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = method;
    checkbox.checked = selectedMethods.includes(method);
    label.append(checkbox, method);
    methodOptions.append(label);
  });
  return methodOptions;
}

async function saveRuleEdit(value: string, pattern: string, kind: 'active' | 'skip', methodOptions: HTMLElement): Promise<void> {
  const normalized = normalizePattern(value);
  if (!normalized) {
    setFieldError(rulesError, 'Enter a valid URL pattern.');
    return;
  }

  const nextOverrides = { ...settings.methodOverrides };
  const methods = [...methodOptions.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
  if (methods.length === 0) {
    setFieldError(rulesError, 'Select at least one access method.');
    return;
  }

  nextOverrides[normalized] = methods;
  if (normalized !== pattern && nextOverrides[pattern]) {
    delete nextOverrides[pattern];
  }

  await updateSettings(kind === 'active'
    ? {
      whitelist: [...settings.whitelist.filter((item) => item !== pattern), normalized],
      methodOverrides: nextOverrides
    }
    : {
      skiplist: [...settings.skiplist.filter((item) => item !== pattern), normalized],
      methodOverrides: nextOverrides
    });
}

function mergeRequests(current: DiscoveredRequest[], incoming: DiscoveredRequest[]): DiscoveredRequest[] {
  const merged = new Map<string, DiscoveredRequest>();

  [...current, ...incoming].forEach((request) => {
    const key = `${request.tabId}|${request.url}|${request.initiator ?? ''}`;
    const previous = merged.get(key);
    merged.set(key, previous
      ? { ...previous, count: Math.max(previous.count, request.count), lastSeen: Math.max(previous.lastSeen, request.lastSeen) }
      : request);
  });

  return [...merged.values()].sort((left, right) => right.lastSeen - left.lastSeen).slice(0, 500);
}

function activateTab(activeButton: HTMLButtonElement): void {
  tabButtons.forEach((button) => {
    const isActive = button === activeButton;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.id === activeButton.getAttribute('aria-controls');
    panel.classList.toggle('is-visible', isActive);
    panel.hidden = !isActive;
  });
}

async function updateSettings(next: Partial<ExtensionSettings>): Promise<void> {
  try {
    suppressNextSettingsRender = true;
    settings = await settingsController.update(next);
    renderSettingsChange();
  } catch {
    suppressNextSettingsRender = false;
    setStatus('Unable to save settings', true);
  }
}

function renderSettingsChange(): void {
  applyTheme(settings.theme);
  syncSettingsControls();
  renderCoverage();
  renderRules();
  syncLinkStatuses();
  renderCorsBlocked();
}

async function applyCorsFixesFromPanel(fixes: CorsFix[], message: string): Promise<void> {
  if (fixes.length === 0) {
    return;
  }

  const openBefore = planCorsIssues(corsIssues, settings).filter(isOpenCorsIssue).map(({ issue }) => issue.key);
  await updateSettings(applyCorsFixes(settings, fixes));
  const stillOpen = new Set(planCorsIssues(corsIssues, settings).filter(isOpenCorsIssue).map(({ issue }) => issue.key));
  openBefore.filter((key) => !stillOpen.has(key)).forEach((key) => fixedSinceOpen.add(key));
  renderCorsBlocked();
  showNotice(message, false);
}

function renderCorsBlocked(): void {
  if (!corsBlockedSection || !corsBlockedSummary || !corsBlockedList) {
    return;
  }

  const planned = planCorsIssues(corsIssues, settings);
  const open = planned.filter(isOpenCorsIssue);
  const recentlyFixed = planned.filter(({ issue, state }) => state === 'fixed' && fixedSinceOpen.has(issue.key));
  const bulkFixes = collectCorsFixes(planned);

  corsBlockedSection.hidden = !settings.detectCorsIssues;
  // Blocked calls are why most people open this panel, so show them first.
  const requestsTab = tabButtons.find((button) => button.id === 'tab-current');
  if (open.length > 0 && !userPickedTab && requestsTab && !requestsTab.classList.contains('is-active')) {
    activateTab(requestsTab);
  }
  corsBlockedSection.dataset.state = open.length > 0 ? 'blocked' : 'clear';
  if (blockedTabCount) {
    blockedTabCount.hidden = open.length === 0;
    blockedTabCount.textContent = String(open.length);
  }
  corsBlockedSummary.textContent = open.length > 0
    ? `${open.length} call${open.length === 1 ? '' : 's'} blocked.${bulkFixes.length > 0 ? ` Fix all will: ${bulkFixes.map(describeCorsFix).join('; ')}.` : ''}`
    : recentlyFixed.length > 0
      ? 'Fixed. Reload the page to retry the calls that failed.'
      : 'No calls blocked by CORS. Calls that fail CORS on this page will show up here, with the reason and a fix.';
  if (fixAllCorsButton) {
    fixAllCorsButton.hidden = bulkFixes.length === 0;
  }
  if (reloadInspectedButton) {
    reloadInspectedButton.hidden = recentlyFixed.length === 0;
  }

  corsBlockedList.textContent = '';
  [...open, ...recentlyFixed].forEach((entry) => corsBlockedList.append(createCorsBlockedItem(entry)));
}

function createCorsBlockedItem({ issue, state, fixes }: PlannedCorsIssue): HTMLLIElement {
  const item = document.createElement('li');
  const call = document.createElement('div');
  const code = document.createElement('code');
  const host = document.createElement('span');
  const reason = document.createElement('small');
  const fixText = document.createElement('small');
  const actions = document.createElement('span');
  const settingsFixes = fixes.filter((fix) => fix.kind !== 'override-server');
  const needsOverride = fixes.some((fix) => fix.kind === 'override-server');

  item.dataset.state = state;
  call.className = 'cors-blocked__call';
  code.textContent = describeCorsCall(issue);
  host.className = 'cors-blocked__host';
  host.textContent = ` ${getRequestHostname(issue.url)}${issue.count > 1 ? ` · ${issue.count} times` : ''}`;
  call.append(code, host);
  reason.className = 'cors-blocked__reason';
  reason.textContent = state === 'fixed' ? 'Fixed by your current rules. Reload the page to retry.' : describeCorsProblem(issue.problem, { origin: issue.pageOrigin });
  fixText.className = 'cors-blocked__fix';
  fixText.textContent = state === 'unfixable'
    ? 'Fix this on the server: the extension cannot change status codes.'
    : fixes.length > 0 ? `Fix: ${fixes.map(describeCorsFix).join('; ')}` : '';
  actions.className = 'cors-blocked__row-actions';

  if (state === 'blocked' && settingsFixes.length > 0) {
    const fixButton = document.createElement('button');
    fixButton.type = 'button';
    fixButton.textContent = 'Fix';
    fixButton.title = settingsFixes.map(describeCorsFix).join('; ');
    fixButton.setAttribute('aria-label', `Fix ${describeCorsCall(issue)}`);
    fixButton.addEventListener('click', () => void applyCorsFixesFromPanel(settingsFixes, 'Fixed. Reload the page to retry this call.'));
    actions.append(fixButton);
  }
  if (state === 'blocked' && needsOverride) {
    const overrideButton = document.createElement('button');
    overrideButton.type = 'button';
    overrideButton.className = 'danger-button';
    overrideButton.textContent = 'Override server headers';
    overrideButton.addEventListener('click', () => {
      if (globalThis.confirm('Override CORS headers that servers already send? This applies to every trusted page and can break APIs that rely on credentials.')) {
        void applyCorsFixesFromPanel([...settingsFixes, { kind: 'override-server' }], 'Server CORS headers will be overridden. Reload the page to retry.');
      }
    });
    actions.append(overrideButton);
  }
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'icon-button';
  copyButton.textContent = '⧉';
  copyButton.title = 'Copy URL';
  copyButton.setAttribute('aria-label', `Copy ${issue.url}`);
  copyButton.addEventListener('click', () => void copyText(issue.url));
  actions.append(copyButton);

  item.append(call, reason, ...(fixText.textContent ? [fixText] : []), actions);
  return item;
}

// One status for a request row: a CORS failure seen on this page outranks what the rules say.
function getLinkStatus(url: string, initiator: string | undefined): { text: string; state: string } {
  const issue = corsIssues.find((candidate) => candidate.url === url);
  if (issue && settings.detectCorsIssues && isOpenCorsIssue(planIssueFix(issue, settings))) {
    return { text: 'Blocked by CORS', state: 'blocked' };
  }
  if (isCorsSkippedForRequest(url, initiator, settings)) {
    return { text: 'Skipped', state: 'skipped' };
  }
  return isCorsEnabledForRequest(url, initiator, settings)
    ? { text: 'CORS enabled', state: 'enabled' }
    : { text: 'Not enabled', state: 'inactive' };
}

async function addRequestPattern(url: string, kind: 'active' | 'skip'): Promise<void> {
  const pattern = normalizePattern(url);
  if (!pattern) {
    return;
  }

  if (kind === 'active') {
    await updateSettings({
      whitelist: [...new Set([...settings.whitelist, pattern])]
    });
    showNotice('URL added to active rules.', false);
  } else {
    await updateSettings({
      whitelist: settings.whitelist.filter((item) => item !== pattern),
      skiplist: [...new Set([...settings.skiplist, pattern])]
    });
    showNotice('URL added to skipped rules.', false);
  }
}

function render(): void {
  applyTheme(settings.theme);
  syncSettingsControls();
  renderCoverage();
  renderLinks();
  renderRules();
  renderCorsBlocked();
  restoreOpenMethodEditors();
}

function syncSettingsControls(): void {
  enabledInput!.checked = settings.enabled;
  if (powerLabel) {
    powerLabel.textContent = settings.enabled ? 'On' : 'Off';
  }
  if (panelStatus) {
    panelStatus.textContent = getStatusText(settings);
    panelStatus.dataset.state = settings.enabled ? 'on' : 'off';
  }
  if (globalWarning) {
    globalWarning.hidden = !(settings.enabled && settings.mode === 'global');
  }
}

function renderCoverage(): void {
  pageUrlElement!.textContent = inspectedUrl ?? 'Unavailable for this DevTools page';
  const hasInspectedPage = Boolean(inspectedUrl);
  const covered = Boolean(inspectedUrl && isCorsEnabledForRequest(inspectedUrl, inspectedUrl, settings));
  coverageElement!.textContent = covered ? 'Trusted' : hasInspectedPage ? 'Not trusted' : '';
  coverageElement!.dataset.covered = String(covered);
  coverageElement!.hidden = !hasInspectedPage;
  renderEffectiveRule();
  renderEffectiveMethods(covered);
  const inspectedPageSkipped = Boolean(inspectedUrl && isCorsSkippedForRequest(inspectedUrl, inspectedUrl, settings));
  allowPageButton!.hidden = !inspectedPattern || covered;
  allowPageButton!.disabled = !inspectedPattern || covered;
  allowPageButton!.textContent = inspectedPattern ? `Trust ${formatPatternForPeople(inspectedPattern)}` : 'Trust this page';
  allowPageButton!.title = inspectedPageSkipped ? 'Your skip rules exclude this page; trusting it removes the matching skip rule.' : '';
}

function renderEffectiveRule(): void {
  if (!effectiveRuleElement) {
    return;
  }

  if (!inspectedUrl) {
    effectiveRuleElement.hidden = true;
    effectiveRuleElement.textContent = '';
    return;
  }

  // "Off" and "not trusted" are already shown above; only say which rule covers or skips the page.
  const rule = getEffectiveCorsRuleForRequest(inspectedUrl, inspectedUrl, settings);
  effectiveRuleElement.textContent = getEffectiveRuleLabel(rule);
  effectiveRuleElement.dataset.state = rule.state;
  effectiveRuleElement.hidden = rule.state === 'inactive';
}

function renderEffectiveMethods(isCovered: boolean): void {
  if (!effectiveMethodsElement) {
    return;
  }

  if (!inspectedUrl || !isCovered) {
    effectiveMethodsElement.hidden = true;
    effectiveMethodsElement.textContent = '';
    return;
  }

  const methods = getAllowedMethodsForRequest(inspectedUrl, inspectedUrl, settings);
  effectiveMethodsElement.textContent = `Effective methods: ${methods.join(', ')}`;
  effectiveMethodsElement.dataset.state = 'active';
  effectiveMethodsElement.hidden = false;
}

function getEffectiveRuleLabel(rule: EffectiveCorsRule): string {
  if (rule.state === 'inactive') {
    return rule.source === 'disabled' ? 'Effective rule: extension disabled' : 'Effective rule: no matching active rule';
  }
  if (rule.state === 'skipped') {
    return `Effective rule: skipped by ${rule.pattern}. Skip rules override active rules.`;
  }
  if (rule.source === 'global') {
    return 'Effective rule: global mode';
  }
  if (rule.source === 'domain') {
    return `Effective rule: ${rule.domainType.replace('_', '-')} domain ${rule.pattern}`;
  }
  return `Effective rule: ${rule.pattern}`;
}

function restoreOpenMethodEditors(): void {
  if (openMethodPatterns.size === 0) {
    return;
  }

  document.querySelectorAll<HTMLDetailsElement>('.method-editor').forEach((editor) => {
    if (editor.dataset.pattern && openMethodPatterns.has(editor.dataset.pattern)) {
      editor.open = true;
    }
  });
}

function renderLinks(): void {
  const currentRequests = discoveredRequests.filter((request) => request.tabId === inspectedTabId);
  const otherRequests = discoveredRequests.filter((request) => request.tabId !== inspectedTabId && isCorsEnabledForRequest(request.url, request.initiator ?? undefined, settings));
  const visibleRequests = requestScope === 'current' ? currentRequests : otherRequests;
  renderLinkList(currentLinks, visibleRequests, requestScope === 'current', currentLinkFilterInput);
  if (currentCount) {
    currentCount.textContent = String(visibleRequests.length);
  }
  if (currentRequestCount) {
    currentRequestCount.textContent = String(currentRequests.length);
  }
  if (otherCount) {
    otherCount.textContent = String(otherRequests.length);
  }
  if (requestScopeHelp) {
    requestScopeHelp.textContent = requestScope === 'current'
      ? 'Direct and indirect requests observed from the inspected page.'
      : 'Observed requests from other tabs that match the active CORS rules.';
  }
  if (copyCurrentLinksButton) {
    copyCurrentLinksButton.hidden = requestScope !== 'current';
  }
}

function renderLinkList(target: HTMLUListElement | null, requests: DiscoveredRequest[], currentTab: boolean, filterInput: HTMLInputElement | null): void {
  if (!target) {
    return;
  }

  target.textContent = '';
  const filter = filterInput?.value.trim().toLowerCase() ?? '';
  requests = collapseDiscoveredRequests(requests).filter((request) => !filter || `${request.url} ${request.initiator ?? ''}`.toLowerCase().includes(filter));
  if (requests.length === 0) {
    const item = document.createElement('li');
    const icon = document.createElement('span');
    const title = document.createElement('strong');
    const description = document.createElement('span');

    item.className = 'empty-state';
    icon.className = 'empty-state__icon';
    icon.textContent = filter ? '⌕' : '↗';
    icon.setAttribute('aria-hidden', 'true');
    title.textContent = filter ? 'No matching requests' : currentTab ? 'No requests recorded for this page yet' : 'No controlled requests in other tabs';
    description.textContent = filter ? 'Try another URL, domain, or clear the filter.' : currentTab ? 'Reload the inspected page while this panel is open.' : 'Requests from other tabs will appear here when they match an active rule.';
    item.append(icon, title, description);

    if (filter) {
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'icon-button';
      clearButton.textContent = '×';
      clearButton.setAttribute('aria-label', 'Clear request filter');
      clearButton.title = 'Clear filter';
      clearButton.addEventListener('click', () => {
        if (filterInput) {
          filterInput.value = '';
          renderLinks();
          filterInput.focus();
        }
      });
      item.append(clearButton);
    } else if (currentTab && allowPageButton && !allowPageButton.disabled) {
      const allowButton = document.createElement('button');
      allowButton.type = 'button';
      allowButton.textContent = 'Allow this page';
      allowButton.addEventListener('click', () => allowPageButton.click());
      item.append(allowButton);
    }
    target.append(item);
    return;
  }

  const requestsByHostname = new Map<string, DiscoveredRequest[]>();
  requests.forEach((request) => {
    const hostname = getRequestHostname(request.url);
    const group = requestsByHostname.get(hostname) ?? [];
    group.push(request);
    requestsByHostname.set(hostname, group);
  });

  [...requestsByHostname.entries()].sort(([firstHostname], [secondHostname]) => firstHostname.localeCompare(secondHostname)).forEach(([hostname, groupedRequests]) => {
    const groupItem = document.createElement('li');
    const groupHeader = document.createElement('div');
    const details = document.createElement('details');
    const heading = document.createElement('summary');
    const originLabel = document.createElement('span');
    const countLabel = document.createElement('span');
    const requestList = document.createElement('ul');
    const requestTotal = groupedRequests.reduce((total, request) => total + request.count, 0);

    groupItem.className = 'request-group';
    groupHeader.className = 'request-group-header';
    details.open = !collapsedRequestGroups.has(hostname);
    details.addEventListener('toggle', () => {
      if (details.open) {
        collapsedRequestGroups.delete(hostname);
      } else {
        collapsedRequestGroups.add(hostname);
      }
    });
    heading.className = 'request-group-heading';
    originLabel.className = 'request-group-heading__origin';
    originLabel.textContent = hostname;
    countLabel.className = 'request-group-heading__count';
    countLabel.textContent = `${groupedRequests.length} URL${groupedRequests.length === 1 ? '' : 's'} · ${requestTotal} request${requestTotal === 1 ? '' : 's'}`;
    heading.append(originLabel, countLabel);
    requestList.className = 'request-group-list';
    details.append(heading, requestList);
    groupHeader.append(details);
    if (currentTab) {
      const copyGroupButton = document.createElement('button');
      copyGroupButton.type = 'button';
      copyGroupButton.className = 'icon-button';
      copyGroupButton.textContent = '⧉';
      copyGroupButton.setAttribute('aria-label', `Copy URLs for ${hostname}`);
      copyGroupButton.title = 'Copy group URLs';
      copyGroupButton.addEventListener('click', () => void copyText(groupedRequests.map((request) => request.url).join('\n')));
      groupHeader.append(copyGroupButton);
    }
    groupItem.append(groupHeader);
    target.append(groupItem);

    groupedRequests.forEach((request) => {
      const item = document.createElement('li');
      const url = document.createElement('code');
      const meta = document.createElement('span');
      const status = document.createElement('span');
      const feedback = document.createElement('span');
      const actions = document.createElement('span');
      const activeButton = document.createElement('button');
      const skipButton = document.createElement('button');

      item.dataset.url = request.url;
      if (request.initiator) {
        item.dataset.initiator = request.initiator;
      }
      url.textContent = request.url;
      meta.className = 'link-meta';
      const inspectedOrigin = inspectedUrl ? new URL(inspectedUrl).origin : null;
      const initiatorOrigin = request.initiator ? new URL(request.initiator).origin : null;
      meta.textContent = `${currentTab ? (initiatorOrigin === inspectedOrigin ? 'Direct' : 'Indirect') : `Tab ${request.tabId}`} | ${request.count} request${request.count === 1 ? '' : 's'}${request.initiator ? ` | ${request.initiator}` : ''}`;
      feedback.className = 'link-feedback';
      feedback.setAttribute('aria-live', 'polite');
      status.className = 'link-status';
      const linkStatus = getLinkStatus(request.url, request.initiator ?? undefined);
      status.textContent = linkStatus.text;
      status.dataset.state = linkStatus.state;
      activeButton.type = 'button';
      activeButton.className = 'icon-button';
      activeButton.textContent = '✓';
      const trustPattern = getTrustPatternForRequest(request.url, request.initiator);
      activeButton.setAttribute('aria-label', `Allow requests from ${trustPattern ?? request.url}`);
      activeButton.title = `Allow requests from ${trustPattern ?? request.url}`;
      activeButton.addEventListener('click', () => void addRequestPattern(trustPattern ?? request.url, 'active').then(() => showRowFeedback(feedback, 'Added')));
      skipButton.type = 'button';
      skipButton.className = 'icon-button';
      skipButton.textContent = '−';
      skipButton.setAttribute('aria-label', `Add ${request.url} to skip rules`);
      skipButton.title = 'Add to skip rules';
      skipButton.addEventListener('click', () => void addRequestPattern(request.url, 'skip').then(() => showRowFeedback(feedback, 'Skipped')));
      actions.className = 'link-actions';
      if (currentTab) {
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'icon-button';
        copyButton.textContent = '⧉';
        copyButton.setAttribute('aria-label', `Copy ${request.url}`);
        copyButton.title = 'Copy URL';
        copyButton.addEventListener('click', () => void copyText(request.url).then((copied) => {
          if (copied) {
            showRowFeedback(feedback, 'Copied');
          }
        }));
        actions.append(copyButton);
      }
      actions.append(activeButton, skipButton);
      item.append(url, meta, status, createMethodEditor(request.url), feedback, actions);
      requestList.append(item);
    });
  });
}

function getRequestHostname(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname || parsedUrl.protocol;
  } catch {
    return 'Unknown domain';
  }
}

function showRowFeedback(target: HTMLElement, text: string): void {
  target.textContent = text;
  target.dataset.visible = 'true';
  setTimeout(() => {
    if (target.textContent === text) {
      target.textContent = '';
      target.dataset.visible = 'false';
    }
  }, 2_000);
}

function syncLinkStatuses(): void {
  document.querySelectorAll<HTMLLIElement>('.link-list li[data-url]').forEach((item) => {
    const url = item.dataset.url;
    if (!url) {
      return;
    }

    const status = item.querySelector<HTMLElement>('.link-status');
    if (!status) {
      return;
    }

    const linkStatus = getLinkStatus(url, item.dataset.initiator);
    status.textContent = linkStatus.text;
    status.dataset.state = linkStatus.state;
  });
}

async function copyCurrentRequestUrls(): Promise<void> {
  const filter = currentLinkFilterInput?.value.trim().toLowerCase() ?? '';
  const requests = collapseDiscoveredRequests(discoveredRequests.filter((request) => request.tabId === inspectedTabId))
    .filter((request) => !filter || `${request.url} ${request.initiator ?? ''}`.toLowerCase().includes(filter));
  await copyText(requests.map((request) => request.url).join('\n'));
}

async function copyText(value: string): Promise<boolean> {
  if (!value) {
    setStatus('Nothing to copy', true);
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus(value.includes('\n') ? 'URLs copied' : 'URL copied', false);
    return true;
  } catch {
    setStatus('Unable to copy URL', true);
    return false;
  }
}

function createMethodEditor(patternInput: string): HTMLDetailsElement {
  const pattern = normalizeMethodOverridePattern(patternInput) ?? patternInput;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const options = document.createElement('span');
  const selectedMethods = settings.methodOverrides[pattern] ?? settings.allowMethods;

  details.className = 'method-editor';
  details.dataset.pattern = pattern;
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

async function updatePatternMethods(pattern: string, methods: string[]): Promise<void> {
  openMethodPatterns = new Set(
    [...document.querySelectorAll<HTMLDetailsElement>('.method-editor[open]')]
      .map((editor) => editor.dataset.pattern)
      .filter((value): value is string => Boolean(value))
  );
  setTimeout(() => openMethodPatterns.clear(), 1_000);
  try {
    suppressNextSettingsRender = true;
    settings = await settingsController.update({
      methodOverrides: { ...settings.methodOverrides, [pattern]: methods }
    });
  } catch {
    suppressNextSettingsRender = false;
    setStatus('Unable to update methods for this link', true);
  } finally {
  }
}

function setStatus(text: string, isError: boolean): void {
  if (isError) {
    showNotice(text, true);
  }
}

function setFieldError(target: HTMLElement | null, text: string): void {
  if (!target) {
    showNotice(text, true);
    return;
  }
  target.textContent = text;
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

function exportCurrentRules(): void {
  const blob = new Blob([exportRules(settings)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'cors-dev-tool-rules.json';
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus('Rules exported', false);
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
    setStatus(error instanceof Error ? error.message : 'Unable to import rules', true);
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
  importPreviewSummary.textContent = '';
  const file = document.createElement('p');
  const counts = document.createElement('p');
  const note = document.createElement('p');
  file.className = 'help';
  counts.className = 'import-preview-counts';
  note.className = 'help';
  file.textContent = fileName;
  appendRuleBadge(counts, `${whitelistCount} active`);
  appendRuleBadge(counts, `${skiplistCount} skipped`);
  appendRuleBadge(counts, `${domainCount} domain`);
  appendRuleBadge(counts, `${overrideCount} custom method${overrideCount === 1 ? '' : 's'}`);
  note.textContent = 'Header and credential settings from the file will also be applied.';
  importPreviewSummary.append(file, counts, note);
  importPreview.hidden = false;
}

async function confirmRulesImport(): Promise<void> {
  if (!pendingImportedSettings) {
    return;
  }

  try {
    settings = await settingsController.update(pendingImportedSettings);
    clearImportPreview();
    setStatus('Rules imported', false);
    render();
  } catch {
    setStatus('Unable to import rules', true);
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

async function getInspectedUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval('window.location.href', (result, exceptionInfo) => {
      resolve(exceptionInfo?.isException ? null : typeof result === 'string' ? result : null);
    });
  });
}
