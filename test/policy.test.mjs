import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { planCorsFix, readCorsRequest } from '../dist-test/shared/corsDiagnosis.js';
import { buildDynamicRules } from '../dist-test/shared/dnrRules.js';
import { getStatusText } from '../dist-test/shared/statusText.js';
import { applyAdminPolicy, hasAdminPolicy, isCorsEnabledForRequest, mergeSettings, NO_POLICY, policyFromManagedStorage, withoutAdminPolicy } from '../dist-test/shared/settings.js';

const app = 'http://localhost:3000';
const api = 'https://api.staging.dev/users';

describe('reading the policy', () => {
  it('reads the managed storage keys and ignores malformed values', () => {
    assert.deepEqual(policyFromManagedStorage({}), NO_POLICY);
    assert.deepEqual(policyFromManagedStorage({ disableOverrides: 'yes', trustedPages: 'localhost:3000', blockEveryWebsiteMode: 1 }), NO_POLICY);
    assert.deepEqual(policyFromManagedStorage({
      disableOverrides: true,
      trustedPages: ['localhost:3000', 'https://app.dev.example.com', '<all_urls>', '', 7],
      blockEveryWebsiteMode: true
    }), {
      overridesOff: true,
      // "Every website" can't be smuggled in as a trusted page.
      trustedPages: ['*://localhost:3000/*', 'https://app.dev.example.com/*'],
      everyWebsiteBlocked: true
    });
    assert.equal(hasAdminPolicy(NO_POLICY), false);
    assert.equal(hasAdminPolicy(policyFromManagedStorage({ trustedPages: ['localhost:3000'] })), true);
  });

  it('matches the keys the Chrome policy schema declares', async () => {
    const schema = JSON.parse(await readFile(new URL('../policy-schema.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('../manifest.chrome.json', import.meta.url), 'utf8'));
    assert.equal(manifest.storage.managed_schema, 'policy-schema.json');
    assert.deepEqual(Object.keys(schema.properties).sort(), ['blockEveryWebsiteMode', 'disableOverrides', 'trustedPages']);
    assert.equal(schema.properties.trustedPages.items.type, 'string');
  });
});

describe('enforcing the policy', () => {
  const own = mergeSettings({ enabled: true, mode: 'global', whitelist: ['localhost:5173'] });

  it('keeps overrides off: no header rules, and blocked calls cannot be fixed here', () => {
    const settings = applyAdminPolicy(own, policyFromManagedStorage({ disableOverrides: true }));
    assert.equal(settings.enabled, false);
    assert.equal(settings.pausedUntil, null);
    assert.deepEqual(buildDynamicRules(settings), []);
    assert.equal(isCorsEnabledForRequest(api, app, settings), false);
    assert.equal(getStatusText(settings), 'Off · set by your organization');

    const request = readCorsRequest(api, 'GET', [{ name: 'Origin', value: app }]);
    assert.deepEqual(planCorsFix(request, { reason: 'missing-allow-origin' }, false, settings), { state: 'managed', fixes: [] });
  });

  it('trusts the policy\'s pages for everyone', () => {
    const settings = applyAdminPolicy(mergeSettings({ enabled: true }), policyFromManagedStorage({ trustedPages: ['localhost:3000'] }));
    assert.equal(isCorsEnabledForRequest(api, app, settings), true);
    assert.equal(isCorsEnabledForRequest(api, 'http://localhost:4000', settings), false);
    assert.ok(buildDynamicRules(settings).some((rule) => rule.condition.initiatorDomains?.includes('localhost')));
  });

  it('blocks "Every website" mode', () => {
    const settings = applyAdminPolicy(own, policyFromManagedStorage({ blockEveryWebsiteMode: true }));
    assert.equal(settings.mode, 'whitelist');
    assert.equal(isCorsEnabledForRequest(api, 'https://unrelated.example', settings), false);
    assert.ok(buildDynamicRules(settings).every((rule) => rule.condition.regexFilter !== undefined || rule.condition.urlFilter !== '*'));
  });

  it('changes nothing without a policy', () => {
    assert.deepEqual(applyAdminPolicy(own, NO_POLICY), own);
  });

  it('keeps the policy and its pages out of what is stored', () => {
    const policy = policyFromManagedStorage({ trustedPages: ['localhost:3000'] });
    assert.deepEqual(withoutAdminPolicy({ whitelist: ['*://localhost:3000/*', 'localhost:5173'], policy }, policy), { whitelist: ['localhost:5173'] });
    assert.deepEqual(withoutAdminPolicy({ enabled: true }, policy), { enabled: true });
  });
});
