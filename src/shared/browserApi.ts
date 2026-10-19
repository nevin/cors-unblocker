import { RequestCategory, isRequestCategory } from './requestTypes.js';
import { DEFAULT_SETTINGS, ExtensionSettings, SETTINGS_KEY, mergeSettings } from './settings.js';

type StorageChangeHandler = (settings: ExtensionSettings) => void;
export type SettingsListener = (settings: ExtensionSettings) => void;

export const runtimeApi = globalThis.browser ?? globalThis.chrome;
const SETTINGS_FIELDS = ['enabled', 'mode', 'whitelist', 'skiplist', 'allowMethods', 'methodOverrides', 'theme', 'allowAllHeaders', 'allowCredentials', 'domainRules', 'anyOriginTargets', 'respectServerCors', 'detectCorsIssues', 'exposeAllHeaders', 'pausedUntil', 'callRules'] as const satisfies ReadonlyArray<keyof ExtensionSettings>;

type StoredSettings = Partial<ExtensionSettings> & {
  [SETTINGS_KEY]?: Partial<ExtensionSettings>;
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await runtimeApi.storage.local.get([SETTINGS_KEY, ...SETTINGS_FIELDS]) as StoredSettings;
  // Individual field keys win over the combined object, which older versions wrote on its own.
  const fieldSettings = Object.fromEntries(SETTINGS_FIELDS.filter((field) => stored[field] !== undefined).map((field) => [field, stored[field]]));
  return mergeSettings({ ...stored[SETTINGS_KEY], ...fieldSettings });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = mergeSettings(settings);
  await runtimeApi.storage.local.set({
    [SETTINGS_KEY]: normalized,
    ...Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, normalized[field]]))
  });
}

export async function updateSettings(next: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const settings = mergeSettings({ ...(await loadSettings()), ...next });
  // Rule edits can drop opt-ins for removed patterns, and switching on ends a pause, so persist those
  // derived fields whenever what they depend on changes.
  const changed = SETTINGS_FIELDS.filter((field) => next[field] !== undefined
    || (field === 'anyOriginTargets' && (next.whitelist !== undefined || next.domainRules !== undefined))
    || (field === 'pausedUntil' && next.enabled !== undefined));

  await runtimeApi.storage.local.set({
    [SETTINGS_KEY]: settings,
    ...Object.fromEntries(changed.map((field) => [field, settings[field]]))
  });
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
  // Requests logged before types were recorded count as 'other'.
  type: RequestCategory;
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
    lastSeen: request.lastSeen ?? Date.now(),
    type: isRequestCategory(request.type) ? request.type : 'other'
  }));
}

export async function recordDiscoveredRequest(requestUrl: string, initiator: string | undefined, tabId: number | undefined, type: RequestCategory = 'other'): Promise<void> {
  const url = toLoggedUrl(requestUrl);
  if (!url || tabId === undefined || tabId < 0) {
    return;
  }

  const normalizedInitiator = initiator ? toLoggedUrl(initiator) : null;
  const requests = await loadDiscoveredRequests();
  const existing = requests.find((request) => request.url === url && request.initiator === normalizedInitiator && request.tabId === tabId);
  const nextRequest: DiscoveredRequest = existing
    ? { ...existing, count: existing.count + 1, lastSeen: Date.now(), type: type === 'other' ? existing.type : type }
    : { url, initiator: normalizedInitiator, tabId, count: 1, lastSeen: Date.now(), type };
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
