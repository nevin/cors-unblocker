import { clearPersistedRequestLog, loadSettings, onSettingsChanged, recordDiscoveredRequest } from '../shared/browserApi';
import { CorsMonitor } from '../shared/corsMonitor';
import { ALLOW_ALL_HEADERS_VALUE } from '../shared/dnrRules';
import { listenForPauseEnd, syncPauseAlarm } from '../shared/pause';
import { showOverridesState } from '../shared/toolbarIcon';
import { ExtensionSettings, getAllowedMethodsForRequest, isCorsEnabledForRequest, isCredentialsSupported } from '../shared/settings';

interface FirefoxHeader {
  name: string;
  value?: string | undefined;
}

interface HeadersReceivedDetails {
  requestId: string;
  tabId: number;
  method: string;
  statusCode: number;
  type: string;
  url: string;
  originUrl?: string | undefined;
  documentUrl?: string | undefined;
  responseHeaders?: FirefoxHeader[] | undefined;
}

interface BlockingResponse {
  responseHeaders?: FirefoxHeader[] | undefined;
}

let currentSettings: ExtensionSettings | null = null;

const corsMonitor = new CorsMonitor(() => currentSettings, (tabId, text) => {
  // The tab may already be gone; a stale badge update is harmless.
  // Firefox returns a promise here, though the shared typings declare void.
  Promise.resolve(browser.browserAction.setBadgeText({ tabId, text }) as unknown as Promise<void>).catch(() => undefined);
});
void browser.browserAction.setBadgeBackgroundColor({ color: '#b34b4b' });

browser.runtime.onInstalled.addListener(() => {
  void refreshSettings();
  void clearPersistedRequestLog();
});

browser.runtime.onStartup.addListener(() => {
  void refreshSettings();
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame') {
      void corsMonitor.clearTab(details.tabId);
    }
    if (!currentSettings?.enabled) {
      return;
    }

    const requestContext = details as typeof details & { originUrl?: string; documentUrl?: string; type?: string };
    void recordDiscoveredRequest(details.url, requestContext.originUrl ?? requestContext.documentUrl, details.tabId);
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'ping']
  }
);

const API_REQUESTS = { urls: ['<all_urls>'], types: ['xmlhttprequest' as const] };
browser.webRequest.onSendHeaders.addListener((details) => corsMonitor.onSendHeaders(details), API_REQUESTS, ['requestHeaders']);
browser.webRequest.onCompleted.addListener((details) => corsMonitor.onRequestEnded(details.requestId), API_REQUESTS);
browser.webRequest.onErrorOccurred.addListener((details) => corsMonitor.onRequestEnded(details.requestId), API_REQUESTS);
browser.tabs.onRemoved.addListener((tabId) => void corsMonitor.clearTab(tabId));

listenForPauseEnd();

onSettingsChanged((settings) => {
  currentSettings = settings;
  void corsMonitor.refreshBadges();
  void syncPauseAlarm(settings);
  void showOverridesState(browser.browserAction, settings).catch((error: unknown) => console.error('Unable to update the toolbar icon', error));
});

browser.webRequest.onHeadersReceived.addListener(
  handleHeadersReceived,
  { urls: ['<all_urls>'] },
  ['blocking', 'responseHeaders']
);

void refreshSettings();

async function refreshSettings(): Promise<void> {
  currentSettings = await loadSettings();
  await syncPauseAlarm(currentSettings);
  await showOverridesState(browser.browserAction, currentSettings).catch((error: unknown) => console.error('Unable to update the toolbar icon', error));
}

function handleHeadersReceived(details: HeadersReceivedDetails): BlockingResponse {
  const settings = currentSettings;
  // Diagnose from the server's own headers, before this listener changes them.
  if (details.type === 'xmlhttprequest') {
    corsMonitor.onHeadersReceived(details);
  }

  if (!settings || !isCorsEnabledForRequest(details.url, details.originUrl ?? details.documentUrl, settings)) {
    return {};
  }

  // Servers that already send Allow-Origin handle CORS themselves; overriding them can break credentialed calls.
  if (settings.respectServerCors && (details.responseHeaders ?? []).some((header) => header.name.toLowerCase() === 'access-control-allow-origin')) {
    return {};
  }

  const initiatorUrl = details.originUrl ?? details.documentUrl;
  const credentialsActive = settings.allowCredentials && isCredentialsSupported(settings);
  if (credentialsActive && !initiatorUrl) {
    return {};
  }

  const responseHeaders = upsertCorsHeaders(details.responseHeaders ?? [], getAllowedMethodsForRequest(details.url, initiatorUrl, settings), settings, credentialsActive, initiatorUrl);
  return { responseHeaders };
}

// Response headers pages can always read; everything else needs Access-Control-Expose-Headers.
const SAFELISTED_RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

function upsertCorsHeaders(headers: FirefoxHeader[], allowMethods: string[], settings: ExtensionSettings, allowCredentials: boolean, initiatorUrl: string | undefined): FirefoxHeader[] {
  const allowAllHeaders = settings.allowAllHeaders;
  const echoOrigin = allowCredentials && initiatorUrl ? new URL(initiatorUrl).origin : null;
  const next = headers.filter((header) => {
    const name = header.name.toLowerCase();
    return !['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-credentials'].includes(name)
      && !(allowAllHeaders && name === 'access-control-allow-headers')
      && !(settings.exposeAllHeaders && name === 'access-control-expose-headers')
      && !(echoOrigin && name === 'vary');
  });

  next.push(
    { name: 'Access-Control-Allow-Origin', value: echoOrigin ?? '*' },
    { name: 'Access-Control-Allow-Methods', value: allowMethods.join(', ') }
  );

  // A response that names one origin differs per requesting page, so caches must key on Origin.
  if (echoOrigin) {
    const vary = headers.filter((header) => header.name.toLowerCase() === 'vary').flatMap((header) => (header.value ?? '').split(',')).map((value) => value.trim()).filter(Boolean);
    next.push({ name: 'Vary', value: [...new Set([...vary, 'Origin'])].join(', ') });
  }

  // Credentialed calls ignore a '*' wildcard, so list this response's own header names instead.
  if (settings.exposeAllHeaders) {
    const names = [...new Set(headers.map((header) => header.name.toLowerCase()))].filter((name) => !SAFELISTED_RESPONSE_HEADERS.has(name) && name !== 'set-cookie');
    next.push({ name: 'Access-Control-Expose-Headers', value: echoOrigin ? names.join(', ') : '*' });
  }

  if (allowAllHeaders) {
    next.push({ name: 'Access-Control-Allow-Headers', value: ALLOW_ALL_HEADERS_VALUE });
  }

  if (allowCredentials) {
    next.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
  }

  return next;
}

