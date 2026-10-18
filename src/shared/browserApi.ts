import { DEFAULT_SETTINGS, ExtensionSettings, SETTINGS_KEY, mergeSettings } from './settings.js';

type StorageChangeHandler = (settings: ExtensionSettings) => void;
export type SettingsListener = (settings: ExtensionSettings) => void;

const runtimeApi = globalThis.browser ?? globalThis.chrome;
const SETTINGS_FIELDS = ['enabled', 'mode', 'whitelist', 'skiplist', 'allowMethods', 'methodOverrides', 'theme', 'allowAllHeaders', 'allowCredentials', 'domainRules'] as const;

type StoredSettings = Partial<ExtensionSettings> & {
  [SETTINGS_KEY]?: Partial<ExtensionSettings>;
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await runtimeApi.storage.local.get([SETTINGS_KEY, ...SETTINGS_FIELDS]) as StoredSettings;
  const legacySettings = stored[SETTINGS_KEY];
  const fieldSettings: Partial<ExtensionSettings> = {};

  if (stored.enabled !== undefined) {
    fieldSettings.enabled = stored.enabled;
  }
  if (stored.mode !== undefined) {
    fieldSettings.mode = stored.mode;
  }
  if (stored.whitelist !== undefined) {
    fieldSettings.whitelist = stored.whitelist;
  }
  if (stored.skiplist !== undefined) {
    fieldSettings.skiplist = stored.skiplist;
  }
  if (stored.allowMethods !== undefined) {
    fieldSettings.allowMethods = stored.allowMethods;
  }
  if (stored.methodOverrides !== undefined) {
    fieldSettings.methodOverrides = stored.methodOverrides;
  }
  if (stored.theme !== undefined) {
    fieldSettings.theme = stored.theme;
  }
  if (stored.allowAllHeaders !== undefined) {
    fieldSettings.allowAllHeaders = stored.allowAllHeaders;
  }
  if (stored.allowCredentials !== undefined) {
    fieldSettings.allowCredentials = stored.allowCredentials;
  }
  if (stored.domainRules !== undefined) {
    fieldSettings.domainRules = stored.domainRules;
  }

  return mergeSettings({ ...legacySettings, ...fieldSettings });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = mergeSettings(settings);
  await runtimeApi.storage.local.set({
    [SETTINGS_KEY]: normalized,
    enabled: normalized.enabled,
    mode: normalized.mode,
    whitelist: normalized.whitelist,
    skiplist: normalized.skiplist,
    allowMethods: normalized.allowMethods,
    methodOverrides: normalized.methodOverrides
    ,theme: normalized.theme
    ,allowAllHeaders: normalized.allowAllHeaders
    ,allowCredentials: normalized.allowCredentials
    ,domainRules: normalized.domainRules
  });
}

export async function updateSettings(next: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const settings = mergeSettings({ ...(await loadSettings()), ...next });
  const changedFields: Record<string, unknown> = { [SETTINGS_KEY]: settings };

  if (next.enabled !== undefined) {
    changedFields.enabled = settings.enabled;
  }
  if (next.mode !== undefined) {
    changedFields.mode = settings.mode;
  }
  if (next.whitelist !== undefined) {
    changedFields.whitelist = settings.whitelist;
  }
  if (next.skiplist !== undefined) {
    changedFields.skiplist = settings.skiplist;
  }
  if (next.allowMethods !== undefined) {
    changedFields.allowMethods = settings.allowMethods;
  }
  if (next.methodOverrides !== undefined) {
    changedFields.methodOverrides = settings.methodOverrides;
  }
  if (next.theme !== undefined) {
    changedFields.theme = settings.theme;
  }
  if (next.allowAllHeaders !== undefined) {
    changedFields.allowAllHeaders = settings.allowAllHeaders;
  }
  if (next.allowCredentials !== undefined) {
    changedFields.allowCredentials = settings.allowCredentials;
  }
  if (next.domainRules !== undefined) {
    changedFields.domainRules = settings.domainRules;
  }

  await runtimeApi.storage.local.set(changedFields);
  return settings;
}

export class SettingsController {
  private currentSettings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<SettingsListener>();
  private listening = false;
  private suppressNextStorageChange = false;
  private suppressTimer: ReturnType<typeof setTimeout> | undefined;

  async initialize(): Promise<ExtensionSettings> {
    this.currentSettings = await loadSettings();
    this.startListening();
    return this.currentSettings;
  }

  get settings(): ExtensionSettings {
    return this.currentSettings;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(next: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    this.suppressNextStorageChange = true;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
    }
    this.suppressTimer = setTimeout(() => {
      this.suppressNextStorageChange = false;
    }, 1_000);
    this.currentSettings = await updateSettings(next);
    this.notify();
    return this.currentSettings;
  }

  private startListening(): void {
    if (this.listening) {
      return;
    }

    this.listening = true;
    onSettingsChanged((settings) => {
      if (this.suppressNextStorageChange) {
        this.suppressNextStorageChange = false;
        if (this.suppressTimer) {
          clearTimeout(this.suppressTimer);
          this.suppressTimer = undefined;
        }
        return;
      }
      this.currentSettings = settings;
      this.notify();
    });
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.currentSettings));
  }
}

export async function resetSettings(): Promise<void> {
  await saveSettings(DEFAULT_SETTINGS);
}

export interface DiscoveredRequest {
  url: string;
  initiator: string | null;
  tabId: number;
  count: number;
  lastSeen: number;
}

export function collapseDiscoveredRequests(requests: DiscoveredRequest[]): DiscoveredRequest[] {
  const byUrl = new Map<string, DiscoveredRequest>();

  requests.forEach((request) => {
    const previous = byUrl.get(request.url);
    if (!previous) {
      byUrl.set(request.url, request);
      return;
    }

    const latest = request.lastSeen >= previous.lastSeen ? request : previous;
    byUrl.set(request.url, {
      ...latest,
      count: previous.count + request.count,
      lastSeen: Math.max(previous.lastSeen, request.lastSeen)
    });
  });

  return [...byUrl.values()].sort((left, right) => right.lastSeen - left.lastSeen);
}

export const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
// The log is kept in session storage so browsing history never reaches disk and is cleared when the browser closes.
const requestLogStorage = runtimeApi.storage.session;
let requestCache: DiscoveredRequest[] | null = null;
let requestCacheLoad: Promise<DiscoveredRequest[]> | null = null;
let requestFlushTimer: ReturnType<typeof setTimeout> | undefined;
let requestFlushResolvers: Array<() => void> = [];
let requestLogWrite = Promise.resolve();

export async function loadDiscoveredRequests(): Promise<DiscoveredRequest[]> {
  if (requestCache) {
    return requestCache;
  }
  if (requestCacheLoad) {
    return requestCacheLoad;
  }

  requestCacheLoad = requestLogStorage.get(REQUEST_LOG_KEY).then((stored) => {
    requestCache = normalizeRequestList(stored[REQUEST_LOG_KEY]);
    requestCacheLoad = null;
    return requestCache;
  });
  return requestCacheLoad;
}

function normalizeRequestList(value: unknown): DiscoveredRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as Partial<DiscoveredRequest>[]).map((request) => ({
    url: request.url ?? '',
    initiator: request.initiator ?? null,
    tabId: request.tabId ?? -1,
    count: request.count ?? 1,
    lastSeen: request.lastSeen ?? Date.now()
  }));
}

export async function recordDiscoveredRequest(requestUrl: string, initiator: string | undefined, tabId: number | undefined): Promise<void> {
  const url = toLoggedUrl(requestUrl);
  if (!url || tabId === undefined || tabId < 0) {
    return;
  }

  const normalizedInitiator = initiator ? toLoggedUrl(initiator) : null;
  const requests = await loadDiscoveredRequests();
  const existing = requests.find((request) => request.url === url && request.initiator === normalizedInitiator && request.tabId === tabId);
  const nextRequest: DiscoveredRequest = existing
    ? { ...existing, count: existing.count + 1, lastSeen: Date.now() }
    : { url, initiator: normalizedInitiator, tabId, count: 1, lastSeen: Date.now() };
  requestCache = [nextRequest, ...requests.filter((request) => request !== existing)].slice(0, 500);

  await scheduleRequestFlush();
}

// Drops the query string and fragment, which often carry tokens or personal data.
export function toLoggedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// Earlier versions persisted the log in storage.local; remove any copy left on disk.
export async function clearPersistedRequestLog(): Promise<void> {
  await runtimeApi.storage.local.remove(REQUEST_LOG_KEY);
}

function scheduleRequestFlush(): Promise<void> {
  const completion = new Promise<void>((resolve) => {
    requestFlushResolvers.push(resolve);
  });

  if (!requestFlushTimer) {
    requestFlushTimer = setTimeout(() => {
      requestFlushTimer = undefined;
      void flushRequestLog();
    }, 250);
  }

  return completion;
}

async function flushRequestLog(): Promise<void> {
  const requests = requestCache ?? [];
  requestLogWrite = requestLogWrite.then(() => requestLogStorage.set({ [REQUEST_LOG_KEY]: requests }));
  await requestLogWrite;
  const resolvers = requestFlushResolvers;
  requestFlushResolvers = [];
  resolvers.forEach((resolve) => resolve());
}

export function onDiscoveredRequestsChanged(handler: (requests: DiscoveredRequest[]) => void): void {
  runtimeApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes[REQUEST_LOG_KEY]) {
      return;
    }

    requestCache = normalizeRequestList(changes[REQUEST_LOG_KEY].newValue);
    handler(requestCache);
  });
}

export function onSettingsChanged(handler: StorageChangeHandler): void {
  runtimeApi.storage.onChanged.addListener((changes, areaName) => {
    const hasSettingsChange = Boolean(changes[SETTINGS_KEY]) || SETTINGS_FIELDS.some((field) => Boolean(changes[field]));

    if (areaName !== 'local' || !hasSettingsChange) {
      return;
    }

    void loadSettings().then(handler);
  });
}
