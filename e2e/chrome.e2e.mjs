import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applyCorsFixes, planIssueFix } from '../dist-test/shared/corsDiagnosis.js';
import { buildDynamicRules } from '../dist-test/shared/dnrRules.js';
import { mergeSettings } from '../dist-test/shared/settings.js';
import { startTestServer } from './server.mjs';

const extensionPath = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';

let server;
let context;
let worker;
let userDataDir;
let app;
let evil;
let api;

before(async () => {
  server = await startTestServer();
  app = server.origin('app.test');
  evil = server.origin('evil.test');
  api = server.origin('api.test');
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
});

after(async () => {
  await context?.close();
  await server?.close();
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

// Stores settings the way the extension does and waits until Chrome has installed the matching rules.
async function configure(settings) {
  const expectedRuleCount = buildDynamicRules(mergeSettings(settings)).length;
  await worker.evaluate(async ({ settings, logKey }) => {
    await chrome.storage.local.clear();
    await chrome.storage.session.remove(logKey);
    await chrome.storage.local.set({ corsDevControlSettings: settings });
  }, { settings, logKey: REQUEST_LOG_KEY });

  await waitFor(async () => {
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    return rules.length === expectedRuleCount;
  }, `Chrome to install ${expectedRuleCount} rules`);
  // Header rules apply to requests that start after installation; give the network stack a beat.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitFor(check, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Chrome caches preflight results for a few seconds per URL, so each request that needs a fresh
// preflight uses a path no earlier request has used.
let pathCounter = 0;
function freshPath(name) {
  pathCounter += 1;
  return `/${name}-${pathCounter}`;
}

// Like fetchFrom, but keeps the tab open so its CORS issues and badge can be inspected.
async function openPage(pageOrigin) {
  const page = await context.newPage();
  await page.goto(`${pageOrigin}/`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` })).at(-1)?.id, pageOrigin);
  const fetchHere = (url, init = {}) => page.evaluate(async ({ url, init }) => {
    try {
      const response = await fetch(url, init);
      return { readable: true, status: response.status };
    } catch (error) {
      return { readable: false, error: String(error) };
    }
  }, { url, init });
  const issues = async () => (await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key] ?? {}, CORS_ISSUES_KEY))[String(tabId)] ?? [];
  const badge = () => worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
  return { page, tabId, fetchHere, issues, badge };
}

// Loads `pageOrigin` in a tab and fetches `url` from it, reporting whether the page could read the response.
async function fetchFrom(pageOrigin, url, init = {}) {
  const page = await context.newPage();
  try {
    await page.goto(`${pageOrigin}/`);
    return await page.evaluate(async ({ url, init }) => {
      try {
        const response = await fetch(url, init);
        return { readable: true, status: response.status, body: await response.json(), apiVersion: response.headers.get('x-api-version') };
      } catch (error) {
        return { readable: false, error: String(error) };
      }
    }, { url, init });
  } finally {
    await page.close();
  }
}

describe('Chrome extension in a real browser', () => {
  it('leaves CORS alone while disabled', async () => {
    await configure({ enabled: false, whitelist: [app] });

    assert.equal((await fetchFrom(app, `${api}/data`)).readable, false);
  });

  it('relaxes requests made by a trusted page, and only by that page', async () => {
    await configure({ enabled: true, whitelist: [app] });

    const trusted = await fetchFrom(app, `${api}/data`);
    assert.equal(trusted.readable, true, trusted.error);
    assert.deepEqual(trusted.body, { ok: true, method: 'GET', path: '/data' });
    assert.equal((await fetchFrom(evil, `${api}/data`)).readable, false);
  });

  it('does not open a whitelisted target to other sites without the opt-in', async () => {
    await configure({ enabled: true, whitelist: [api] });

    assert.equal((await fetchFrom(evil, `${api}/data`)).readable, false);
  });

  it('opens a target to every site with "Any site may read"', async () => {
    await configure({ enabled: true, whitelist: [api], anyOriginTargets: [api] });

    assert.equal((await fetchFrom(evil, `${api}/data`)).readable, true);
  });

  it('lets a skip rule win over a trusted page, by path', async () => {
    await configure({ enabled: true, whitelist: [app], skiplist: [`${api}/admin/*`] });

    assert.equal((await fetchFrom(app, `${api}/admin/users`)).readable, false);
    assert.equal((await fetchFrom(app, `${api}/data`)).readable, true);
  });

  it('uses the allowed methods in preflight responses', async () => {
    const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };

    await configure({ enabled: true, whitelist: [app], allowMethods: ['GET', 'POST'], allowAllHeaders: true });
    assert.equal((await fetchFrom(app, `${api}${freshPath('methods')}`, put)).readable, false);

    await configure({ enabled: true, whitelist: [app], allowMethods: ['GET', 'PUT'], allowAllHeaders: true });
    const allowed = await fetchFrom(app, `${api}${freshPath('methods')}`, put);
    assert.equal(allowed.readable, true, allowed.error);
    assert.equal(allowed.body.method, 'PUT');
  });

  it('applies a method override on a query-specific URL', async () => {
    const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };
    const path = freshPath('override');
    await configure({
      enabled: true,
      whitelist: [app],
      allowAllHeaders: true,
      methodOverrides: { [`${api}${path}?id=1`]: ['GET'] }
    });

    assert.equal((await fetchFrom(app, `${api}${path}?id=1`, put)).readable, false);
    assert.equal((await fetchFrom(app, `${api}${path}?id=2`, put)).readable, true);
  });

  it('allows custom request headers only with "allow all headers"', async () => {
    const withHeader = { headers: { 'x-custom': '1' } };

    await configure({ enabled: true, whitelist: [app], allowAllHeaders: false });
    assert.equal((await fetchFrom(app, `${api}${freshPath('headers')}`, withHeader)).readable, false);

    await configure({ enabled: true, whitelist: [app], allowAllHeaders: true });
    assert.equal((await fetchFrom(app, `${api}${freshPath('headers')}`, withHeader)).readable, true);
  });

  it('supports credentialed requests from an explicit origin', async () => {
    await configure({ enabled: true, whitelist: [app], allowCredentials: true });

    const result = await fetchFrom(app, `${api}/data`, { credentials: 'include' });
    assert.equal(result.readable, true, result.error);
  });

  it('relaxes everything in global mode, except skipped URLs', async () => {
    await configure({ enabled: true, mode: 'global' });
    assert.equal((await fetchFrom(evil, `${api}/data`)).readable, true);

    await configure({ enabled: true, mode: 'global', skiplist: [api] });
    assert.equal((await fetchFrom(evil, `${api}/data`)).readable, false);
  });

  it('logs requests to session storage without query strings, and only while enabled', async () => {
    const readLogs = () => worker.evaluate(async (key) => ({
      session: (await chrome.storage.session.get(key))[key] ?? [],
      local: (await chrome.storage.local.get(key))[key]
    }), REQUEST_LOG_KEY);

    const disabledPath = freshPath('log-disabled');
    const enabledPath = freshPath('log-enabled');
    const isLogged = (logs, path) => logs.session.some((entry) => entry.url.includes(path));

    await configure({ enabled: false, whitelist: [app] });
    await fetchFrom(app, `${api}${disabledPath}?token=disabled-secret`);

    await configure({ enabled: true, whitelist: [app] });
    await fetchFrom(app, `${api}${enabledPath}?token=enabled-secret`);
    await waitFor(async () => isLogged(await readLogs(), enabledPath), 'the request to be logged');

    const logs = await readLogs();
    assert.equal(isLogged(logs, disabledPath), false);
    assert.ok(logs.session.some((entry) => entry.url === `${api}${enabledPath}`));
    assert.equal(logs.local, undefined);
    assert.doesNotMatch(JSON.stringify(logs.session), /secret/);
  });
});

describe('CORS issue detection in a real browser', () => {
  it('detects a blocked call while overrides are off, and the suggested fix makes it work', async () => {
    await configure({ enabled: false });
    const tab = await openPage(app);
    const path = freshPath('detect');
    try {
      assert.equal((await tab.fetchHere(`${api}${path}?token=secret`)).readable, false);
      await waitFor(async () => (await tab.issues()).length === 1, 'the blocked call to be detected');

      const [issue] = await tab.issues();
      assert.equal(issue.url, `${api}${path}`);
      assert.equal(issue.pageOrigin, app);
      assert.equal(issue.problem.reason, 'missing-allow-origin');
      assert.equal(await tab.badge(), '1');

      const settings = mergeSettings({ enabled: false });
      const plan = planIssueFix(issue, settings);
      assert.deepEqual(plan.fixes.map((fix) => fix.kind), ['enable', 'trust-page']);
      await configure({ ...settings, ...applyCorsFixes(settings, plan.fixes) });

      await waitFor(async () => (await tab.badge()) === '', 'the badge to clear after the fix');
      assert.equal((await tab.fetchHere(`${api}${path}`)).readable, true);
    } finally {
      await tab.page.close();
    }
  });

  it('reports a failing preflight status as something headers cannot fix', async () => {
    await configure({ enabled: true, whitelist: [app], allowAllHeaders: true });
    const tab = await openPage(app);
    try {
      const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };
      assert.equal((await tab.fetchHere(`${api}/preflight-404${freshPath('x')}`, put)).readable, false);
      await waitFor(async () => (await tab.issues()).length === 1, 'the failed preflight to be detected');

      const [issue] = await tab.issues();
      assert.deepEqual(issue.problem, { reason: 'preflight-status', detail: '404' });
      assert.equal(issue.preflight, true);
      assert.equal(issue.method, 'PUT');
      assert.equal(await tab.badge(), '1');
    } finally {
      await tab.page.close();
    }
  });

  it('records nothing for calls that work, and clears issues when the tab navigates', async () => {
    await configure({ enabled: false });
    const tab = await openPage(app);
    try {
      assert.equal((await tab.fetchHere(`${api}/cors-ok${freshPath('ok')}`, { credentials: 'include' })).readable, true);
      assert.equal((await tab.fetchHere(`${api}${freshPath('blocked')}`)).readable, false);
      await waitFor(async () => (await tab.issues()).length === 1, 'only the blocked call to be detected');

      await tab.page.goto(`${app}/`);
      await waitFor(async () => (await tab.issues()).length === 0 && (await tab.badge()) === '', 'navigation to clear the issues');
    } finally {
      await tab.page.close();
    }
  });

  it('does not record anything when detection is turned off', async () => {
    await configure({ enabled: false, detectCorsIssues: false });
    const tab = await openPage(app);
    try {
      assert.equal((await tab.fetchHere(`${api}${freshPath('quiet')}`)).readable, false);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(await tab.issues(), []);
      assert.equal(await tab.badge(), '');
    } finally {
      await tab.page.close();
    }
  });
});

describe('respecting server CORS headers in a real browser', () => {
  it('keeps a credentialed API that handles CORS itself working on a trusted page', async () => {
    const credentialed = { credentials: 'include' };

    await configure({ enabled: true, whitelist: [app] });
    const kept = await fetchFrom(app, `${api}/cors-ok${freshPath('respect')}`, credentialed);
    assert.equal(kept.readable, true, kept.error);
    assert.equal((await fetchFrom(app, `${api}${freshPath('plain')}`)).readable, true);

    // Without respect mode, the extension's Allow-Origin: * replaces the server's echo and breaks credentials.
    await configure({ enabled: true, whitelist: [app], respectServerCors: false });
    assert.equal((await fetchFrom(app, `${api}/cors-ok${freshPath('override')}`, credentialed)).readable, false);
  });

  it('lets "allow all headers" cover the Authorization header', async () => {
    await configure({ enabled: true, whitelist: [app], allowAllHeaders: true });

    const result = await fetchFrom(app, `${api}${freshPath('auth')}`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(result.readable, true, result.error);
  });
});
