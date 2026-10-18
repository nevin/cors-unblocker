import { clearPersistedRequestLog, loadSettings, onSettingsChanged, recordDiscoveredRequest } from '../shared/browserApi';
import { buildDynamicRules } from '../shared/dnrRules';
import { ExtensionSettings } from '../shared/settings';

let ruleUpdateQueue = Promise.resolve();
// Null until settings load after the service worker wakes; requests seen before then are not recorded.
let currentSettings: ExtensionSettings | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void refreshRules();
  void clearPersistedRequestLog();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshRules();
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (currentSettings?.enabled) {
      void recordDiscoveredRequest(details.url, details.initiator, details.tabId);
    }
  },
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'ping']
  }
);

onSettingsChanged((settings) => {
  currentSettings = settings;
  queueApplyRules(settings);
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
