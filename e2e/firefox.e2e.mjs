import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { defineSharedCases, waitFor } from './cases.mjs';
import { ADDON_UUID, createFirefoxHarness } from './firefoxBrowser.mjs';

const h = createFirefoxHarness();

before(() => h.launch());
after(() => h.close());

defineSharedCases(h);

describe('Firefox only', () => {
  it('opens Settings with the welcome card on install', async () => {
    let welcomeUrl = null;
    await waitFor(async () => {
      for (const handle of await h.driver.getAllWindowHandles()) {
        await h.driver.switchTo().window(handle);
        const url = await h.driver.getCurrentUrl();
        if (url === `moz-extension://${ADDON_UUID}/options/index.html#welcome`) {
          welcomeUrl = url;
        }
      }
      await h.driver.switchTo().window(h.controlHandle);
      return welcomeUrl !== null;
    }, 'the welcome tab');
    assert.ok(welcomeUrl);
  });
});
