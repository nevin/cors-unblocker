import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildDynamicRules } from '../dist-test/shared/dnrRules.js';
import { mergeSettings } from '../dist-test/shared/settings.js';
import { defineSharedCases, freshPath, waitFor } from './cases.mjs';
import { startTestServer } from './server.mjs';

const extensionPath = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';

let server;
let context;
let worker;
let userDataDir;

// Drives Chrome through the extension's service worker. See cases.mjs for the harness contract.
const h = {
  name: 'Chrome',

  async configure(settings) {
    await worker.evaluate(async ({ settings, logKey }) => {
      await chrome.storage.local.clear();
      await chrome.storage.session.remove(logKey);
      await chrome.storage.local.set({ corsDevControlSettings: settings });
    }, { settings, logKey: REQUEST_LOG_KEY });
    await h.settle(settings);
  },

  // Settings are in effect once Chrome has installed the matching number of rules.
  async settle(settings) {
    const expectedRuleCount = buildDynamicRules(mergeSettings(settings)).length;
    await waitFor(async () => {
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      return rules.length === expectedRuleCount;
    }, `Chrome to install ${expectedRuleCount} rules`);
    // Header rules apply to requests that start after installation; give the network stack a beat.
    await new Promise((resolve) => setTimeout(resolve, 100));
  },

  async setRawSettings(settings) {
    await worker.evaluate(async (settings) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ corsDevControlSettings: settings });
    }, settings);
  },

  async fetchFrom(pageOrigin, url, init = {}) {
    const page = await context.newPage();
    try {
      await page.goto(`${pageOrigin}/`);
      return await page.evaluate(fetchAndDescribe, { url, init });
    } finally {
      await page.close();
    }
  },

  async openPage(pageOrigin) {
    const page = await context.newPage();
    await page.goto(`${pageOrigin}/`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` })).at(-1)?.id, pageOrigin);
    return {
      fetchHere: (url, init = {}) => page.evaluate(fetchAndDescribe, { url, init }),
      issues: async () => (await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key] ?? {}, CORS_ISSUES_KEY))[String(tabId)] ?? [],
      badge: () => worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId),
      goto: (url) => page.goto(url),
      close: () => page.close()
    };
  },

  readLogs: () => worker.evaluate(async (key) => ({
    session: (await chrome.storage.session.get(key))[key] ?? [],
    local: (await chrome.storage.local.get(key))[key]
  }), REQUEST_LOG_KEY),

  readEnabled: () => worker.evaluate(async () => {
    const stored = await chrome.storage.local.get(['enabled', 'pausedUntil', 'corsDevControlSettings']);
    return { enabled: stored.enabled ?? stored.corsDevControlSettings?.enabled, pausedUntil: stored.pausedUntil ?? stored.corsDevControlSettings?.pausedUntil ?? null };
  }),

  title: () => worker.evaluate(() => chrome.action.getTitle({}))
};

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

before(async () => {
  server = await startTestServer();
  h.app = server.origin('app.test');
  h.evil = server.origin('evil.test');
  h.api = server.origin('api.test');
  h.siteApp = server.origin('app.site.test');
  h.siteApi = server.origin('api.site.test');
  userDataDir = await mkdtemp(join(tmpdir(), 'cors-unblocker-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1'
    ]
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  // A same-site session cookie, sent on credentialed calls from app.site.test to api.site.test.
  await context.addCookies([{ name: 'session', value: 'test', domain: 'api.site.test', path: '/' }]);
});

after(async () => {
  await context?.close();
  await server?.close();
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

defineSharedCases(h);

describe('Chrome only', () => {
  // Chrome reports response headers to DevTools and extensions before rules modify them, so the added
  // Vary header cannot be read back; Chrome rejecting an invalid rule would fail configure() instead.
  it('installs a Vary: Origin rule alongside a credentialed response origin', async () => {
    await h.configure({ enabled: true, whitelist: [h.siteApp], allowCredentials: true });

    const installed = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    const headers = installed.flatMap((rule) => rule.action.responseHeaders ?? []);
    assert.ok(headers.some((header) => header.header === 'access-control-allow-origin' && header.value === h.siteApp));
    assert.ok(headers.some((header) => header.header === 'vary' && header.operation === 'append' && header.value === 'Origin'));
    assert.equal((await h.fetchFrom(h.siteApp, `${h.siteApi}${freshPath('vary')}`, { credentials: 'include' })).readable, true);
  });

  it('opens Settings with a welcome card on install, which Got it dismisses', async () => {
    await waitFor(async () => context.pages().some((page) => page.url().endsWith('/options/index.html#welcome')), 'the welcome tab');
    const page = context.pages().find((candidate) => candidate.url().endsWith('/options/index.html#welcome'));
    await page.waitForSelector('#welcome:not([hidden])');
    assert.match(await page.textContent('#welcome'), /Click Trust/);

    await page.click('#dismiss-welcome');
    assert.equal(await page.isHidden('#welcome'), true);
    assert.equal(new URL(page.url()).hash, '');
  });
});
