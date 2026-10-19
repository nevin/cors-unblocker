import { ExtensionSettings } from './settings.js';

// One wording for "is it on?" everywhere: the popup header and the DevTools panel header.
export function getStatusText(settings: ExtensionSettings): string {
  if (settings.pausedUntil !== null) {
    return `Paused until ${formatTime(settings.pausedUntil)}`;
  }
  if (!settings.enabled) {
    return 'Off';
  }
  if (settings.mode === 'global') {
    return 'On · every website';
  }
  const ruleCount = settings.whitelist.length + settings.domainRules.length;
  return `On · ${ruleCount} trusted page${ruleCount === 1 ? '' : 's'}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
