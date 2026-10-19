import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { mergeSettings } from '../dist-test/shared/settings.js';
import { defineSharedCases, waitFor } from './cases.mjs';
import { startTestServer } from './server.mjs';

// The test-only build (scripts/build.mjs firefox --e2e) adds a bridge content script on *.test pages:
// Firefox's WebDriver cannot script extension pages, so the tests talk to the extension through it.
const extensionPath = fileURLToPath(new URL('../dist-e2e/firefox', import.meta.url));
const ADDON_ID = 'cors-dev-tool@example.local';
const ADDON_UUID = '6f1c3c0e-2b9b-4d5e-9a51-6c0f2e7b8a11';
const TEST_HOSTS = ['app.test', 'evil.test', 'api.test', 'app.site.test', 'api.site.test'];
const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';

let server;
let driver;
let workDir;
let controlHandle;

// Runs `command` in the extension's background, from the *.test tab with the given window handle.
async function bridge(command, args = [], handle = controlHandle) {
  await driver.switchTo().window(handle);
  const reply = await driver.executeAsyncScript(`
    const [command, args] = arguments;
    const done = arguments[arguments.length - 1];
    const id = Math.random();
    const listen = (event) => {
      if (event.source === window && event.data && event.data.type === 'cors-unblocker-e2e-response' && event.data.id === id) {
        window.removeEventListener('message', listen);
        done(event.data);
      }
    };
    window.addEventListener('message', listen);
    window.postMessage({ type: 'cors-unblocker-e2e-request', id, command, args }, '*');
  `, command, args);
  if (reply.error) {
    throw new Error(`Bridge command ${command} failed: ${reply.error}`);
  }
  return reply.result;
}

// JSON with object keys sorted, so equal settings compare equal whatever order WebDriver returns keys in.
function canonical(value) {
  return JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item));
}

// Runs in the page: fetches and reports whether the page could read the response.
const FETCH_AND_DESCRIBE = `
  const [url, init] = arguments;
  const done = arguments[arguments.length - 1];
  fetch(url, init).then(
    (response) => response.json().catch(() => null).then((body) => done({ readable: true, status: response.status, body, totalCount: response.headers.get('x-total-count') })),
    (error) => done({ readable: false, error: String(error) })
  );
`;

async function openTab(url) {
  const handle = await driver.switchTo().newWindow('tab').then(() => driver.getWindowHandle());
  await driver.get(url);
  return handle;
}

async function closeTab(handle) {
  await driver.switchTo().window(handle);
  await driver.close();
  await driver.switchTo().window(controlHandle);
}

// Drives Firefox through the bridge. See cases.mjs for the harness contract.
const h = {
  name: 'Firefox',

  async configure(settings) {
    await bridge('localClear');
    await bridge('sessionRemove', [[REQUEST_LOG_KEY]]);
    await bridge('localSet', [{ corsDevControlSettings: settings }]);
    await h.settle(settings);
  },

  // Settings are in effect once the background's header listener holds exactly these settings.
  async settle(settings) {
    const expected = canonical(mergeSettings(settings));
    await waitFor(async () => canonical(await bridge('appliedSettings')) === expected, 'Firefox to apply the settings');
  },

  async setRawSettings(settings) {
    await bridge('localClear');
    await bridge('localSet', [{ corsDevControlSettings: settings }]);
  },

  async fetchFrom(pageOrigin, url, init = {}) {
    const handle = await openTab(`${pageOrigin}/`);
    try {
      return await driver.executeAsyncScript(FETCH_AND_DESCRIBE, url, init);
    } finally {
      await closeTab(handle);
    }
  },

  async openPage(pageOrigin) {
    const handle = await openTab(`${pageOrigin}/`);
    const tabId = await bridge('ownTabId', [], handle);
    return {
      fetchHere: async (url, init = {}) => {
        await driver.switchTo().window(handle);
        return driver.executeAsyncScript(FETCH_AND_DESCRIBE, url, init);
      },
      issues: async () => ((await bridge('sessionGet', [[CORS_ISSUES_KEY]]))[CORS_ISSUES_KEY] ?? {})[String(tabId)] ?? [],
      badge: () => bridge('badgeText', [], handle),
      goto: async (url) => {
        await driver.switchTo().window(handle);
        await driver.get(url);
      },
      close: () => closeTab(handle)
    };
  },

  async readLogs() {
    const session = await bridge('sessionGet', [[REQUEST_LOG_KEY]]);
    const local = await bridge('localGet', [[REQUEST_LOG_KEY]]);
    return { session: session[REQUEST_LOG_KEY] ?? [], local: local[REQUEST_LOG_KEY] };
  },

  async readEnabled() {
    const stored = await bridge('localGet', [['enabled', 'pausedUntil', 'corsDevControlSettings']]);
    return { enabled: stored.enabled ?? stored.corsDevControlSettings?.enabled, pausedUntil: stored.pausedUntil ?? stored.corsDevControlSettings?.pausedUntil ?? null };
  },

  title: () => bridge('title')
};

before(async () => {
  server = await startTestServer();
  h.app = server.origin('app.test');
  h.evil = server.origin('evil.test');
  h.api = server.origin('api.test');
  h.siteApp = server.origin('app.site.test');
  h.siteApi = server.origin('api.site.test');

  // Firefox installs an add-on from an .xpi, which is a zip of the build folder.
  workDir = await mkdtemp(join(tmpdir(), 'cors-unblocker-firefox-'));
  const xpi = join(workDir, 'cors-unblocker-e2e.xpi');
  execFileSync('zip', ['-qr', '-X', xpi, '.'], { cwd: extensionPath });

  const options = new firefox.Options()
    .addArguments('-headless')
    // A fixed internal address for the add-on, and the test hostnames pointed at the local server.
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: ADDON_UUID }))
    .setPreference('network.dns.localDomains', TEST_HOSTS.join(','))
    .setPreference('dom.security.https_first', false);
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  await driver.manage().setTimeouts({ script: 15_000 });
  await driver.installAddon(xpi, true);

  // A same-site session cookie, sent on credentialed calls from app.site.test to api.site.test.
  controlHandle = await driver.getWindowHandle();
  await driver.get(`${h.siteApi}/`);
  await driver.manage().addCookie({ name: 'session', value: 'test', path: '/' });
  // The control tab: an ordinary *.test page that carries the bridge.
  await driver.get(`${h.app}/`);
});

after(async () => {
  await driver?.quit();
  await server?.close();
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
});

defineSharedCases(h);

describe('Firefox only', () => {
  it('opens Settings with the welcome card on install', async () => {
    let welcomeUrl = null;
    await waitFor(async () => {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (url === `moz-extension://${ADDON_UUID}/options/index.html#welcome`) {
          welcomeUrl = url;
        }
      }
      await driver.switchTo().window(controlHandle);
      return welcomeUrl !== null;
    }, 'the welcome tab');
    assert.ok(welcomeUrl);
  });
});
