import { clearPersistedRequestLog, loadSettings, onSettingsChanged, recordDiscoveredRequest } from '../shared/browserApi';
import { ExtensionSettings, getAllowedMethodsForRequest, isCorsEnabledForRequest, isCredentialsSupported } from '../shared/settings';

interface FirefoxHeader {
  name: string;
  value?: string | undefined;
}

interface HeadersReceivedDetails {
  url: string;
  originUrl?: string | undefined;
  documentUrl?: string | undefined;
  responseHeaders?: FirefoxHeader[] | undefined;
}

interface BlockingResponse {
  responseHeaders?: FirefoxHeader[] | undefined;
}

let currentSettings: ExtensionSettings | null = null;

browser.runtime.onInstalled.addListener(() => {
  void refreshSettings();
  void clearPersistedRequestLog();
});

browser.runtime.onStartup.addListener(() => {
  void refreshSettings();
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
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

onSettingsChanged((settings) => {
  currentSettings = settings;
});

browser.webRequest.onHeadersReceived.addListener(
  handleHeadersReceived,
  { urls: ['<all_urls>'] },
  ['blocking', 'responseHeaders']
);

void refreshSettings();

async function refreshSettings(): Promise<void> {
  currentSettings = await loadSettings();
}

function handleHeadersReceived(details: HeadersReceivedDetails): BlockingResponse {
  const settings = currentSettings;

  if (!settings || !isCorsEnabledForRequest(details.url, details.originUrl ?? details.documentUrl, settings)) {
    return {};
  }

  const initiatorUrl = details.originUrl ?? details.documentUrl;
  const credentialsActive = settings.allowCredentials && isCredentialsSupported(settings);
  if (credentialsActive && !initiatorUrl) {
    return {};
  }

  const responseHeaders = upsertCorsHeaders(details.responseHeaders ?? [], getAllowedMethodsForRequest(details.url, initiatorUrl, settings), settings.allowAllHeaders, credentialsActive, initiatorUrl);
  return { responseHeaders };
}

function upsertCorsHeaders(headers: FirefoxHeader[], allowMethods: string[], allowAllHeaders: boolean, allowCredentials: boolean, initiatorUrl: string | undefined): FirefoxHeader[] {
  const next = headers.filter((header) => {
    const name = header.name.toLowerCase();
    return !['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-credentials'].includes(name)
      && !(allowAllHeaders && name === 'access-control-allow-headers');
  });

  next.push(
    { name: 'Access-Control-Allow-Origin', value: allowCredentials && initiatorUrl ? new URL(initiatorUrl).origin : '*' },
    { name: 'Access-Control-Allow-Methods', value: allowMethods.join(', ') }
  );

  if (allowAllHeaders) {
    next.push({ name: 'Access-Control-Allow-Headers', value: '*' });
  }

  if (allowCredentials) {
    next.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
  }

  return next;
}

