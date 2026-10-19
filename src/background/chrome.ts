import { clearPersistedRequestLog, loadSettings, onSettingsChanged, recordDiscoveredRequest } from '../shared/browserApi';
import { CorsMonitor } from '../shared/corsMonitor';
import { buildDynamicRules } from '../shared/dnrRules';
import { ExtensionSettings } from '../shared/settings';

let ruleUpdateQueue = Promise.resolve();
// Null until settings load after the service worker wakes; requests seen before then are not recorded.
let currentSettings: ExtensionSettings | null = null;

const corsMonitor = new CorsMonitor(() => currentSettings, (tabId, text) => {
  // The tab may already be gone; a stale badge update is harmless.
  chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
});
void chrome.action.setBadgeBackgroundColor({ color: '#b34b4b' });

chrome.runtime.onInstalled.addListener(() => {
  void refreshRules();
  void clearPersistedRequestLog();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshRules();
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame') {
      void corsMonitor.clearTab(details.tabId);
    }
    if (currentSettings?.enabled) {
      void recordDiscoveredRequest(details.url, details.initiator, details.tabId);
    }
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'ping']
  }
);

// CORS detection reads the server's original headers; extraHeaders exposes Origin and preflight requests.
const API_REQUESTS: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'], types: ['xmlhttprequest'] };
chrome.webRequest.onSendHeaders.addListener((details) => corsMonitor.onSendHeaders(details), API_REQUESTS, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener((details) => {
  corsMonitor.onHeadersReceived(details);
}, API_REQUESTS, ['responseHeaders', 'extraHeaders']);
chrome.webRequest.onCompleted.addListener((details) => corsMonitor.onRequestEnded(details.requestId), API_REQUESTS);
chrome.webRequest.onErrorOccurred.addListener((details) => corsMonitor.onRequestEnded(details.requestId), API_REQUESTS);
chrome.tabs.onRemoved.addListener((tabId) => void corsMonitor.clearTab(tabId));

onSettingsChanged((settings) => {
  currentSettings = settings;
  queueApplyRules(settings);
  void corsMonitor.refreshBadges();
});

void refreshRules();

async function refreshRules(): Promise<void> {
  currentSettings = await loadSettings();
  await queueApplyRules(currentSettings);
}

function queueApplyRules(settings: ExtensionSettings): Promise<void> {
  ruleUpdateQueue = ruleUpdateQueue
    .then(() => applyRules(settings))
    .catch((error: unknown) => {
      console.error('Unable to update CORS rules', error);
    });

  return ruleUpdateQueue;
}

async function applyRules(settings: ExtensionSettings): Promise<void> {
  // This extension owns every dynamic rule, so replace them all with the current set.
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    // The shared builder uses string literals that match Chrome's enum values.
    addRules: buildDynamicRules(settings) as unknown as chrome.declarativeNetRequest.Rule[]
  });
}
