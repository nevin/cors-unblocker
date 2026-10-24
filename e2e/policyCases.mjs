import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { policyFromManagedStorage } from '../dist-test/shared/settings.js';
import { freshPath, waitFor } from './cases.mjs';
import { unpackedExtensionId } from './chromeBrowser.mjs';

// Settings an administrator enforces, through the browser's real policy engine: policies.json for
// Firefox, and Chrome's policy folder on Linux, which CI makes writable.
const TRUSTS_APP = { trustedPages: ['app.test'], blockEveryWebsiteMode: true };
const OVERRIDES_OFF = { disableOverrides: true, trustedPages: ['app.test'] };


async function readPolicy(h) {
  return h.name === 'Chrome'
    ? policyFromManagedStorage(await h.worker.evaluate(() => chrome.storage.managed.get(null)))
    : (await h.bridge('appliedSettings')).policy;
}

// `browser`: { name, create(options) returning a harness, skip: false or the reason to skip }.
export function defineAdminPolicyCases(browser) {
  describe(`${browser.name}: a policy that trusts pages and blocks "Every website"`, { skip: browser.skip }, () => {
    const h = browser.create({ managed: TRUSTS_APP });
    before(() => h.launch());
    after(() => h.close());

    it('reaches the extension through the browser\'s policy engine', async () => {
      if (h.name === 'Chrome') {
        assert.equal(h.extensionId(), await unpackedExtensionId(fileURLToPath(new URL('../dist/chrome', import.meta.url))));
      }
      await waitFor(async () => (await readPolicy(h)).trustedPages.length > 0, 'the policy to load');
      assert.deepEqual(await readPolicy(h), { overridesOff: false, trustedPages: ['*://app.test/*'], everyWebsiteBlocked: true });
    });

    it('relaxes calls from the page the policy trusts, with no rules of the user\'s own', async () => {
      await h.configure({ enabled: true });

      const trusted = await h.fetchFrom(h.app, `${h.api}/data`);
      assert.equal(trusted.readable, true, trusted.error);
      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, false);
    });

    it('keeps the user\'s own trusted pages working alongside', async () => {
      await h.configure({ enabled: true, whitelist: [h.siteApp] });

      assert.equal((await h.fetchFrom(h.siteApp, `${h.siteApi}${freshPath('own')}`)).readable, true);
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('policy')}`)).readable, true);
    });

    it('ignores "Every website" mode', async () => {
      await h.configure({ enabled: true, mode: 'global' });

      assert.equal((await h.fetchFrom(h.evil, `${h.api}${freshPath('global')}`)).readable, false);
    });
  });

  describe(`${browser.name}: a policy that keeps overrides off`, { skip: browser.skip }, () => {
    const h = browser.create({ managed: OVERRIDES_OFF });
    before(() => h.launch());
    after(() => h.close());

    it('changes no headers, even on trusted pages the user switched on', async () => {
      await waitFor(async () => (await readPolicy(h)).overridesOff, 'the policy to load');
      await h.configure({ enabled: true, whitelist: [h.app] });

      assert.equal((await h.fetchFrom(h.app, `${h.api}/data`)).readable, false);
    });

    it('still detects and counts blocked calls', async () => {
      await h.configure({ enabled: true, whitelist: [h.app] });
      const page = await h.openPage(h.app);
      try {
        assert.equal((await page.fetchHere(`${h.api}${freshPath('detected')}`)).readable, false);
        await waitFor(async () => (await page.issues()).length === 1, 'the blocked call to be recorded');
        await waitFor(async () => (await page.badge()) === '1', 'the badge to count it');
      } finally {
        await page.close();
      }
    });
  });
}
