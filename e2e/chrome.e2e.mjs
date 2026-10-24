import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { defineSharedCases, freshPath, waitFor } from './cases.mjs';
import { createChromeHarness } from './chromeBrowser.mjs';

const h = createChromeHarness();

before(() => h.launch());
after(() => h.close());

defineSharedCases(h);

describe('Chrome only', () => {
  // Chrome reports response headers to DevTools and extensions before rules modify them, so the added
  // Vary header cannot be read back; Chrome rejecting an invalid rule would fail configure() instead.
  it('installs a Vary: Origin rule alongside a credentialed response origin', async () => {
    await h.configure({ enabled: true, whitelist: [h.siteApp], allowCredentials: true });

    const installed = await h.worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    const headers = installed.flatMap((rule) => rule.action.responseHeaders ?? []);
    assert.ok(headers.some((header) => header.header === 'access-control-allow-origin' && header.value === h.siteApp));
    assert.ok(headers.some((header) => header.header === 'vary' && header.operation === 'append' && header.value === 'Origin'));
    assert.equal((await h.fetchFrom(h.siteApp, `${h.siteApi}${freshPath('vary')}`, { credentials: 'include' })).readable, true);
  });

  it('opens Settings with a welcome card on install, which Got it dismisses', async () => {
    await waitFor(async () => h.context.pages().some((page) => page.url().endsWith('/options/index.html#welcome')), 'the welcome tab');
    const page = h.context.pages().find((candidate) => candidate.url().endsWith('/options/index.html#welcome'));
    await page.waitForSelector('#welcome:not([hidden])');
    assert.match(await page.textContent('#welcome'), /Click Trust/);

    await page.click('#dismiss-welcome');
    assert.equal(await page.isHidden('#welcome'), true);
    assert.equal(new URL(page.url()).hash, '');
  });
});
