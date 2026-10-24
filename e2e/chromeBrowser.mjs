import { createHash } from 'node:crypto';
import { access, constants, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildDynamicRules } from '../dist-test/shared/dnrRules.js';
import { applyAdminPolicy, mergeSettings, NO_POLICY, policyFromManagedStorage } from '../dist-test/shared/settings.js';
import { waitFor } from './cases.mjs';
import { startTestServer } from './server.mjs';

const extensionPath = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';
// Where Chrome for Testing (Playwright's Chromium) reads policy on Linux. CI makes it writable.
export const CHROME_POLICY_DIRECTORY = '/etc/opt/chrome_for_testing/policies/managed';
const POLICY_FILE = join(CHROME_POLICY_DIRECTORY, 'cors-unblocker-e2e.json');

export async function canSetChromePolicy() {
  try {
    await access(CHROME_POLICY_DIRECTORY, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Chrome names an unpacked extension after its folder: the first 32 hex digits of the path's
// SHA-256, written with the letters a to p.
export async function unpackedExtensionId(path) {
  const hex = createHash('sha256').update(await realpath(path)).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

// Runs in the page: fetches and reports whether the page could read the response.
async function fetchAndDescribe({ url, init }) {
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    return { readable: true, status: response.status, body, totalCount: response.headers.get('x-total-count') };
  } catch (error) {
    return { readable: false, error: String(error) };
  }
}

// Drives Chrome through the extension's service worker. See cases.mjs for the harness contract.
// `managed` is what an administrator would put in managed storage; it needs canSetChromePolicy().
export function createChromeHarness({ managed = null } = {}) {
  let server;
  let userDataDir;
  const policy = managed ? policyFromManagedStorage(managed) : NO_POLICY;

  const h = {
    name: 'Chrome',
    context: null,
    worker: null,

    async launch() {
      server = await startTestServer();
      h.app = server.origin('app.test');
      h.evil = server.origin('evil.test');
      h.api = server.origin('api.test');
      h.siteApp = server.origin('app.site.test');
      h.siteApi = server.origin('api.site.test');
      if (managed) {
        const id = await unpackedExtensionId(extensionPath);
        await writeFile(POLICY_FILE, JSON.stringify({ '3rdparty': { extensions: { [id]: managed } } }));
      }
      userDataDir = await mkdtemp(join(tmpdir(), 'cors-unblocker-e2e-'));
      h.context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          '--host-resolver-rules=MAP *.test 127.0.0.1'
        ]
      });
      h.worker = h.context.serviceWorkers()[0] ?? await h.context.waitForEvent('serviceworker');
      // A same-site session cookie, sent on credentialed calls from app.site.test to api.site.test.
      await h.context.addCookies([{ name: 'session', value: 'test', domain: 'api.site.test', path: '/' }]);
    },

    async close() {
      await h.context?.close();
      await server?.close();
      if (managed) {
        await rm(POLICY_FILE, { force: true });
      }
      if (userDataDir) {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },

    extensionId: () => new URL(h.worker.url()).host,
    appliedPolicy: () => h.worker.evaluate(async () => chrome.storage.managed.get(null)),

    async configure(settings) {
      await h.worker.evaluate(async ({ settings, logKey }) => {
        await chrome.storage.local.clear();
        await chrome.storage.session.remove(logKey);
        await chrome.storage.local.set({ corsDevControlSettings: settings });
      }, { settings, logKey: REQUEST_LOG_KEY });
      await h.settle(settings);
    },

    // Settings are in effect once Chrome has installed the matching number of rules.
    async settle(settings) {
      const expectedRuleCount = buildDynamicRules(applyAdminPolicy(mergeSettings(settings), policy)).length;
      await waitFor(async () => {
        const rules = await h.worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
        return rules.length === expectedRuleCount;
      }, `Chrome to install ${expectedRuleCount} rules`);
      // Header rules apply to requests that start after installation; give the network stack a beat.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },

    async setRawSettings(settings) {
      await h.worker.evaluate(async (settings) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ corsDevControlSettings: settings });
      }, settings);
    },

    async fetchFrom(pageOrigin, url, init = {}) {
      const page = await h.context.newPage();
      try {
        await page.goto(`${pageOrigin}/`);
        return await page.evaluate(fetchAndDescribe, { url, init });
      } finally {
        await page.close();
      }
    },

    async openPage(pageOrigin) {
      const page = await h.context.newPage();
      await page.goto(`${pageOrigin}/`);
      const tabId = await h.worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` })).at(-1)?.id, pageOrigin);
      return {
        fetchHere: (url, init = {}) => page.evaluate(fetchAndDescribe, { url, init }),
        issues: async () => (await h.worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key] ?? {}, CORS_ISSUES_KEY))[String(tabId)] ?? [],
        badge: () => h.worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId),
        goto: (url) => page.goto(url),
        close: () => page.close()
      };
    },

    readLogs: () => h.worker.evaluate(async (key) => ({
      session: (await chrome.storage.session.get(key))[key] ?? [],
      local: (await chrome.storage.local.get(key))[key]
    }), REQUEST_LOG_KEY),

    readEnabled: () => h.worker.evaluate(async () => {
      const stored = await chrome.storage.local.get(['enabled', 'pausedUntil', 'corsDevControlSettings']);
      return { enabled: stored.enabled ?? stored.corsDevControlSettings?.enabled, pausedUntil: stored.pausedUntil ?? stored.corsDevControlSettings?.pausedUntil ?? null };
    }),

    title: () => h.worker.evaluate(() => chrome.action.getTitle({}))
  };
  return h;
}
