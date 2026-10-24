import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { applyAdminPolicy, mergeSettings, NO_POLICY, policyFromManagedStorage } from '../dist-test/shared/settings.js';
import { waitFor } from './cases.mjs';
import { startTestServer } from './server.mjs';

// The test-only build (scripts/build.mjs firefox --e2e) adds a bridge content script on *.test pages:
// Firefox's WebDriver cannot script extension pages, so the tests talk to the extension through it.
const extensionPath = fileURLToPath(new URL('../dist-e2e/firefox', import.meta.url));
export const ADDON_ID = 'cors-unblocker@nevin.github.io';
export const ADDON_UUID = '6f1c3c0e-2b9b-4d5e-9a51-6c0f2e7b8a11';
const TEST_HOSTS = ['app.test', 'evil.test', 'api.test', 'app.site.test', 'api.site.test'];
const REQUEST_LOG_KEY = 'corsDevControlRequestLog';
const CORS_ISSUES_KEY = 'corsDevControlCorsIssues';

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

// Drives Firefox through the bridge. See cases.mjs for the harness contract. `managed` is what an
// administrator would put in policies.json for this add-on, which then reaches its managed storage.
export function createFirefoxHarness({ managed = null } = {}) {
  let server;
  let workDir;
  const policy = managed ? policyFromManagedStorage(managed) : NO_POLICY;

  // Runs `command` in the extension's background, from the *.test tab with the given window handle.
  async function bridge(command, args = [], handle = h.controlHandle) {
    await h.driver.switchTo().window(handle);
    const reply = await h.driver.executeAsyncScript(`
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

  async function openTab(url) {
    const handle = await h.driver.switchTo().newWindow('tab').then(() => h.driver.getWindowHandle());
    await h.driver.get(url);
    return handle;
  }

  async function closeTab(handle) {
    await h.driver.switchTo().window(handle);
    await h.driver.close();
    await h.driver.switchTo().window(h.controlHandle);
  }

  const h = {
    name: 'Firefox',
    driver: null,
    controlHandle: null,
    bridge,

    async launch() {
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
      const builder = new Builder().forBrowser('firefox');
      if (managed) {
        // Firefox reads policies.json from another path only in automation mode, which needs both this
        // preference and non-local connections switched off (the test server is local).
        const policyFile = join(workDir, 'policies.json');
        await writeFile(policyFile, JSON.stringify({ policies: { '3rdparty': { Extensions: { [ADDON_ID]: managed } } } }));
        options
          .setPreference('browser.policies.alternatePath', policyFile)
          .setPreference('security.turn_off_all_security_so_that_viruses_can_take_over_this_computer', true);
        builder.setFirefoxService(new firefox.ServiceBuilder().setEnvironment({ ...process.env, MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1' }));
      }
      h.driver = await builder.setFirefoxOptions(options).build();
      await h.driver.manage().setTimeouts({ script: 15_000 });
      await h.driver.installAddon(xpi, true);

      // A same-site session cookie, sent on credentialed calls from app.site.test to api.site.test.
      h.controlHandle = await h.driver.getWindowHandle();
      await h.driver.get(`${h.siteApi}/`);
      await h.driver.manage().addCookie({ name: 'session', value: 'test', path: '/' });
      // The control tab: an ordinary *.test page that carries the bridge.
      await h.driver.get(`${h.app}/`);
    },

    async close() {
      await h.driver?.quit();
      await server?.close();
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    },

    async configure(settings) {
      await bridge('localClear');
      await bridge('sessionRemove', [[REQUEST_LOG_KEY]]);
      await bridge('localSet', [{ corsDevControlSettings: settings }]);
      await h.settle(settings);
    },

    // Settings are in effect once the background's header listener holds exactly these settings.
    async settle(settings) {
      const expected = canonical(applyAdminPolicy(mergeSettings(settings), policy));
      await waitFor(async () => canonical(await bridge('appliedSettings')) === expected, 'Firefox to apply the settings');
    },

    async setRawSettings(settings) {
      await bridge('localClear');
      await bridge('localSet', [{ corsDevControlSettings: settings }]);
    },

    async fetchFrom(pageOrigin, url, init = {}) {
      const handle = await openTab(`${pageOrigin}/`);
      try {
        return await h.driver.executeAsyncScript(FETCH_AND_DESCRIBE, url, init);
      } finally {
        await closeTab(handle);
      }
    },

    async openPage(pageOrigin) {
      const handle = await openTab(`${pageOrigin}/`);
      const tabId = await bridge('ownTabId', [], handle);
      return {
        fetchHere: async (url, init = {}) => {
          await h.driver.switchTo().window(handle);
          return h.driver.executeAsyncScript(FETCH_AND_DESCRIBE, url, init);
        },
        issues: async () => ((await bridge('sessionGet', [[CORS_ISSUES_KEY]]))[CORS_ISSUES_KEY] ?? {})[String(tabId)] ?? [],
        badge: () => bridge('badgeText', [], handle),
        goto: async (url) => {
          await h.driver.switchTo().window(handle);
          await h.driver.get(url);
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
  return h;
}
