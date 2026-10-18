import { SettingsController } from '../shared/browserApi';
import { CorsMode, ExtensionSettings, isCorsEnabledForRequest, isCorsSkippedForRequest, normalizePattern } from '../shared/settings';
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

let settings: ExtensionSettings;
let currentUrl: string | null = null;
let currentPattern: string | null = null;
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
    const runtimeApi = globalThis.browser ?? globalThis.chrome;
    void runtimeApi.runtime.openOptionsPage();
  });

  allowCurrentButton?.addEventListener('click', () => {
    void allowCurrentSite();
  });

  themeSelect?.addEventListener('change', () => {
    void updateSettings({ theme: themeSelect.value as ExtensionSettings['theme'] });
  });
}

async function allowCurrentSite(): Promise<void> {
  if (!currentPattern || (settings.whitelist.includes(currentPattern) && !settings.skiplist.includes(currentPattern))) {
    return;
  }

  await updateSettings({
    whitelist: [...new Set([...settings.whitelist, currentPattern])],
    skiplist: settings.skiplist.filter((pattern) => pattern !== currentPattern)
  });
  showNotice('URL added to active rules.', false);
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
    const currentAllowed = Boolean(currentPattern && settings.whitelist.includes(currentPattern) && !currentSkipped);
    allowCurrentButton.hidden = !currentPattern || currentAllowed;
    allowCurrentButton.disabled = !currentPattern || currentAllowed;
    allowCurrentButton.textContent = currentSkipped ? 'Move to active' : 'Allow this page';
  }

  if (modeWarning) {
    modeWarning.hidden = settings.mode !== 'global';
  }
  if (themeSelect) {
    themeSelect.value = settings.theme;
  }
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
  [enabledInput, manageButton, allowCurrentButton, themeSelect, ...modeInputs].forEach((control) => {
    if (control) {
      control.disabled = isBusy;
    }
  });
}

async function getCurrentSite(): Promise<{ url: string | null; pattern: string | null }> {
  try {
    const runtimeApi = globalThis.browser ?? globalThis.chrome;
    const [tab] = await runtimeApi.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? null;

    if (!url || !/^https?:\/\//.test(url)) {
      return { url, pattern: null };
    }

    return { url, pattern: normalizePattern(url) };
  } catch {
    return { url: null, pattern: null };
  }
}
