import { runtimeApi } from './browserApi.js';

export const WELCOME_HASH = '#welcome';

// First install only: open Settings with a short "how it works" card. Updates stay quiet.
export function openWelcomeOnInstall(reason: string): void {
  if (reason === 'install') {
    void runtimeApi.tabs.create({ url: runtimeApi.runtime.getURL(`options/index.html${WELCOME_HASH}`) });
  }
}
