import {
  DiscoveredRequest,
  SettingsController,
  collapseDiscoveredRequests,
  loadDiscoveredRequests,
  onDiscoveredRequestsChanged,
  resetSettings
} from '../shared/browserApi';
import { DEFAULT_ALLOW_METHODS, CorsMode, ExtensionSettings, exportRules, importRules, isCredentialsSupported, normalizeMethodOverridePattern, normalizePattern } from '../shared/settings';
import { applyTheme } from '../shared/theme';

const form = document.querySelector<HTMLFormElement>('#form');
const input = document.querySelector<HTMLInputElement>('#pattern');
const message = document.querySelector<HTMLElement>('#message');
const countElement = document.querySelector<HTMLElement>('#count');
const list = document.querySelector<HTMLUListElement>('#list');
const discoveredList = document.querySelector<HTMLUListElement>('#discovered-list');
const skipList = document.querySelector<HTMLUListElement>('#skip-list');
const methodInputs = [...document.querySelectorAll<HTMLInputElement>('.allow-method')];
const selectAllMethodsButton = document.querySelector<HTMLButtonElement>('#select-all-methods');
const selectDefaultMethodsButton = document.querySelector<HTMLButtonElement>('#select-default-methods');
const allowAllHeadersInput = document.querySelector<HTMLInputElement>('#allow-all-headers');
const allowCredentialsInput = document.querySelector<HTMLInputElement>('#allow-credentials');
const credentialsHint = document.querySelector<HTMLElement>('#credentials-hint');
const headersWarning = document.querySelector<HTMLElement>('#headers-warning');
const themeSelect = document.querySelector<HTMLSelectElement>('#theme');
const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const settingsStatus = document.querySelector<HTMLElement>('#settings-status');
const globalModeWarning = document.querySelector<HTMLElement>('#global-mode-warning');
const resetButton = document.querySelector<HTMLButtonElement>('#reset');
const exportRulesButton = document.querySelector<HTMLButtonElement>('#export-rules');
const importRulesButton = document.querySelector<HTMLButtonElement>('#import-rules');
const importRulesFile = document.querySelector<HTMLInputElement>('#import-rules-file');
const importPreview = document.querySelector<HTMLElement>('#import-preview');
const importPreviewSummary = document.querySelector<HTMLElement>('#import-preview-summary');
const confirmImportRulesButton = document.querySelector<HTMLButtonElement>('#confirm-import-rules');
const cancelImportRulesButton = document.querySelector<HTMLButtonElement>('#cancel-import-rules');

let settings: ExtensionSettings;
let discoveredRequests: DiscoveredRequest[] = [];
let messageTimer: ReturnType<typeof setTimeout> | undefined;
let pendingImportedSettings: Partial<ExtensionSettings> | null = null;
const settingsController = new SettingsController();

void initialize();

async function initialize(): Promise<void> {
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
  allowCredentialsInput?.addEventListener('change', () => {
    void updateSettings({ allowCredentials: allowCredentialsInput.checked });
  });

  themeSelect?.addEventListener('change', () => {
    void updateTheme(themeSelect.value as ExtensionSettings['theme']);
  });

  enabledInput?.addEventListener('change', () => {
    void updateSettings({ enabled: enabledInput.checked });
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

async function addPattern(): Promise<void> {
  const rawPattern = input?.value.trim() ?? '';
  const normalized = normalizePattern(rawPattern);

  if (!normalized) {
    setMessage(`Could not add "${rawPattern || 'empty value'}". Use an http(s) URL, hostname, wildcard host, or browser match pattern.`, true);
    return;
  }

  if (settings.whitelist.includes(normalized)) {
    setMessage('That pattern is already listed.', true);
    return;
  }

  setBusy(true);
  setMessage('Saving...', false);

  try {
    settings = await settingsController.update({
      whitelist: [...settings.whitelist, normalized]
    });
    if (input) {
      input.value = '';
    }
    setMessage('Rule added to active rules.', false);
    render();
  } catch {
    setMessage('Unable to save pattern.', true);
  } finally {
    setBusy(false);
  }
}

async function removePattern(pattern: string, kind: 'enabled' | 'skip', feedbackTarget?: HTMLElement): Promise<void> {
  setBusy(true);

  try {
    settings = await settingsController.update(kind === 'enabled'
      ? { whitelist: settings.whitelist.filter((item) => item !== pattern) }
      : { skiplist: settings.skiplist.filter((item) => item !== pattern) });
    setMessage('Pattern removed.', false);
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

function editPattern(pattern: string): void {
  if (!input) {
    return;
  }

  input.value = pattern;
  input.focus();
  setMessage('Pattern loaded for editing.', false);
}

function render(): void {
  applyTheme(settings.theme);
  if (enabledInput) {
    enabledInput.checked = settings.enabled;
  }
  modeInputs.forEach((input) => {
    input.checked = input.value === settings.mode;
  });
  if (settingsStatus) {
    const activeCount = settings.whitelist.length + settings.domainRules.length;
    settingsStatus.textContent = settings.enabled
      ? settings.mode === 'global' ? 'Enabled' : activeCount === 0 ? 'Enabled, but no active rules' : 'Enabled'
      : 'Disabled';
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
  renderPatternList(list, settings.whitelist, 'enabled');
  renderPatternList(skipList, settings.skiplist, 'skip');
  renderDiscoveredRequests();

  if (countElement) {
    countElement.textContent = `${settings.whitelist.length} ${settings.whitelist.length === 1 ? 'rule' : 'rules'}`;
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

function renderPatternList(target: HTMLUListElement | null, patterns: string[], kind: 'enabled' | 'skip'): void {
  if (!target) {
    return;
  }

  target.textContent = '';
  if (patterns.length === 0) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    const description = document.createElement('span');
    item.className = 'empty';
    title.textContent = kind === 'enabled' ? 'No active rules yet.' : 'No skip rules yet.';
    description.textContent = kind === 'enabled'
      ? 'Add a URL or pattern above so this extension relaxes CORS headers for it.'
      : 'Patterns added here keep their original CORS headers even when the rest of the site is active.';
    item.append(title, description);
    if (kind === 'enabled') {
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.textContent = 'Add a rule';
      addButton.addEventListener('click', () => input?.focus());
      item.append(addButton);
    }
    target.append(item);
    return;
  }

  patterns.forEach((pattern) => {
    const item = document.createElement('li');
    const code = document.createElement('code');
    const feedback = document.createElement('span');
    const actions = document.createElement('span');
    const editButton = document.createElement('button');
    const removeButton = document.createElement('button');

    code.textContent = pattern;
    feedback.className = 'row-feedback';
    feedback.setAttribute('aria-live', 'polite');
    editButton.type = 'button';
    editButton.className = 'icon-button';
    editButton.textContent = '✎';
    editButton.setAttribute('aria-label', `Edit ${pattern}`);
    editButton.title = 'Edit pattern';
    editButton.addEventListener('click', () => editPattern(pattern));
    removeButton.type = 'button';
    removeButton.className = 'icon-button danger-button';
    removeButton.textContent = '×';
    removeButton.setAttribute('aria-label', `Remove ${pattern}`);
    removeButton.addEventListener('click', () => void removePattern(pattern, kind, feedback));
    actions.className = 'item-actions';
    actions.append(editButton, removeButton);

    item.append(code, createMethodEditor(pattern), feedback, actions);
    target.append(item);
  });
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
    const editButton = document.createElement('button');
    const enableButton = document.createElement('button');
    const skipButton = document.createElement('button');

    code.textContent = request.url;
    source.textContent = `Called by ${request.initiator ?? 'unknown site'} (${request.count} time${request.count === 1 ? '' : 's'})`;
    source.className = 'request-source';
    feedback.className = 'row-feedback';
    feedback.setAttribute('aria-live', 'polite');
    details.append(code, source);
    const methodEditor = createMethodEditor(request.url);

    editButton.type = 'button';
    editButton.className = 'icon-button';
    editButton.textContent = '✎';
    editButton.setAttribute('aria-label', `Edit ${request.url}`);
    editButton.title = 'Edit pattern';
    editButton.addEventListener('click', () => editPattern(request.url));
    enableButton.type = 'button';
    enableButton.className = 'icon-button';
    enableButton.textContent = '✓';
    enableButton.setAttribute('aria-label', `Enable ${request.url}`);
    enableButton.title = 'Add to active rules';
    enableButton.addEventListener('click', () => void addDiscoveredPattern(request.url, 'enabled', feedback));
    skipButton.type = 'button';
    skipButton.className = 'icon-button danger-button';
    skipButton.textContent = '−';
    skipButton.setAttribute('aria-label', `Skip ${request.url}`);
    skipButton.title = 'Add to skip rules';
    skipButton.addEventListener('click', () => void addDiscoveredPattern(request.url, 'skip', feedback));
    actions.className = 'item-actions';
    actions.append(editButton, enableButton, skipButton);

    item.append(details, methodEditor, feedback, actions);
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

function setMessage(text: string, isError: boolean): void {
  if (!message) {
    return;
  }

  message.textContent = text;
  message.dataset.error = String(isError);
  if (messageTimer) {
    clearTimeout(messageTimer);
  }
  messageTimer = setTimeout(() => {
    message.textContent = '';
    message.dataset.error = 'false';
  }, 20_000);
}

function setBusy(isBusy: boolean): void {
  form?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
    control.disabled = isBusy;
  });
  document.querySelectorAll<HTMLButtonElement>('.item-actions button').forEach((button) => {
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
  [enabledInput, resetButton, ...modeInputs].forEach((control) => {
    if (control) {
      control.disabled = isBusy;
    }
  });
}
