// Test-only (built with --e2e, never shipped): the real Firefox background plus a message handler the
// end-to-end tests use, through bridgeContent.ts, to read and change extension state.
import { getCurrentSettings } from '../background/firefox';

type Command = (tabId: number | undefined, ...args: unknown[]) => Promise<unknown>;
// Firefox returns promises here; the shared typings come from Chrome and declare callbacks.
const action = browser.browserAction as unknown as {
  getBadgeText(details: { tabId: number }): Promise<string>;
  getTitle(details: Record<string, never>): Promise<string>;
};

const commands: Record<string, Command> = {
  ownTabId: async (tabId) => tabId,
  appliedSettings: async () => getCurrentSettings(),
  localClear: async () => browser.storage.local.clear(),
  localSet: async (_tabId, values) => browser.storage.local.set(values as Record<string, unknown>),
  localGet: async (_tabId, keys) => browser.storage.local.get(keys as string[] | null),
  sessionGet: async (_tabId, keys) => browser.storage.session.get(keys as string[] | null),
  sessionRemove: async (_tabId, keys) => browser.storage.session.remove(keys as string[]),
  badgeText: async (tabId) => action.getBadgeText({ tabId: tabId ?? -1 }),
  title: async () => action.getTitle({})
};

browser.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender) => {
  const request = message as { e2e?: boolean; command?: string; args?: unknown[] } | null;
  const command = request?.e2e && request.command ? commands[request.command] : undefined;
  if (!command) {
    return undefined;
  }
  return command(sender.tab?.id, ...(request?.args ?? []));
});
