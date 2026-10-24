import { ExtensionSettings } from './settings.js';

// One wording for "is it on?" everywhere: the popup header and the DevTools panel header.
export function getStatusText(settings: ExtensionSettings): string {
  if (settings.pausedUntil !== null) {
    return `Paused until ${formatTime(settings.pausedUntil)}`;
  }
  if (settings.policy.overridesOff) {
    return 'Off · set by your organization';
  }
  if (!settings.enabled) {
    return 'Off';
  }
  if (settings.mode === 'global') {
    return 'On · every website';
  }
  const ruleCount = settings.whitelist.length + settings.domainRules.length;
  const callCount = settings.callRules.length;
  const pages = `${ruleCount} trusted page${ruleCount === 1 ? '' : 's'}`;
  const calls = `${callCount} unblocked call${callCount === 1 ? '' : 's'}`;
  if (callCount === 0) {
    return `On · ${pages}`;
  }
  return ruleCount === 0 ? `On · ${calls}` : `On · ${pages}, ${calls}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
