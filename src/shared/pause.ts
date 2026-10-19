import { loadSettings, runtimeApi, updateSettings } from './browserApi.js';
import { ExtensionSettings } from './settings.js';

export const PAUSE_DURATION_MS = 60 * 60 * 1000;
const RESUME_ALARM = 'cors-unblocker-resume';

// Background only. Keeps one alarm matching the current pause; a pause whose time has passed while the
// browser or service worker was asleep ends right away.
export async function syncPauseAlarm(settings: ExtensionSettings): Promise<void> {
  if (settings.pausedUntil === null) {
    await runtimeApi.alarms.clear(RESUME_ALARM);
    return;
  }

  if (settings.pausedUntil <= Date.now()) {
    await updateSettings({ enabled: true });
    return;
  }

  await runtimeApi.alarms.create(RESUME_ALARM, { when: settings.pausedUntil });
}

export function listenForPauseEnd(): void {
  runtimeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESUME_ALARM) {
      void loadSettings().then(syncPauseAlarm);
    }
  });
}
