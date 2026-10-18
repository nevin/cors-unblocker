import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportRules, getAllowedMethodsForRequest, getEffectiveCorsRuleForRequest, getPatternHost, getTrustPatternForRequest, importRules, isCorsEnabledForRequest, isRequestMethodAllowed, matchesUrlPattern, mergeSettings, normalizeMethodOverridePattern, normalizePattern, normalizePatterns } from '../dist-test/shared/settings.js';

describe('settings pattern normalization', () => {
  it('keeps all urls token', () => {
    assert.equal(normalizePattern('<all_urls>'), '<all_urls>');
  });

  it('normalizes bare hosts to browser match patterns', () => {
    assert.equal(normalizePattern('api.local.test'), '*://api.local.test/*');
  });

  it('normalizes wildcard hosts', () => {
    assert.equal(normalizePattern('*.example.dev'), '*://*.example.dev/*');
    assert.equal(normalizePattern('https://*.example.dev/api'), 'https://*.example.dev/api/*');
    assert.equal(normalizePattern('https://*.etihad.com'), 'https://*.etihad.com/*');
    assert.equal(normalizePattern('https://www.*.etihad.com/*'), 'https://www.*.etihad.com/*');
  });

  it('keeps query-specific method overrides separate', () => {
    assert.equal(normalizeMethodOverridePattern('https://api.example.dev/users?id=1'), 'https://api.example.dev/users?id=1');
    assert.equal(normalizeMethodOverridePattern('https://api.example.dev/users?id=2'), 'https://api.example.dev/users?id=2');
  });

  it('normalizes http urls', () => {
    assert.equal(normalizePattern('https://api.example.dev'), 'https://api.example.dev/*');
  });

  it('rejects unsupported protocols', () => {
    assert.equal(normalizePattern('ftp://api.example.dev'), null);
  });

  it('deduplicates normalized patterns', () => {
    assert.deepEqual(normalizePatterns(['api.local.test', 'api.local.test/']), ['*://api.local.test/*']);
  });

  it('does not allow the global token in the whitelist', () => {
    assert.deepEqual(mergeSettings({ whitelist: ['<all_urls>', 'api.local.test'] }).whitelist, ['*://api.local.test/*']);
  });

  it('matches browser patterns consistently', () => {
    assert.equal(matchesUrlPattern('https://api.example.dev/v1/users', '*://api.example.dev/*'), true);
    assert.equal(matchesUrlPattern('https://other.example.dev/v1/users', '*://api.example.dev/*'), false);
    assert.equal(matchesUrlPattern('http://localhost:3000/data', 'http://localhost:3000/*'), true);
    assert.equal(matchesUrlPattern('ftp://localhost:3000/data', '<all_urls>'), false);
  });

  it('never lets a host wildcard match text in the path or query', () => {
    assert.equal(matchesUrlPattern('https://attacker.com/x.example.dev/', '*://*.example.dev/*'), false);
    assert.equal(matchesUrlPattern('https://attacker.com/?next=a.example.dev/', '*://*.example.dev/*'), false);
    assert.equal(matchesUrlPattern('https://attacker.com/a.etihad.com/', 'https://www.*.etihad.com/*'), false);
    assert.equal(matchesUrlPattern('https://evil.com/', '*://*/api/*'), false);
  });

  it('anchors the end of the host', () => {
    assert.equal(matchesUrlPattern('https://example.dev.evil.com/', '*://*.example.dev/*'), false);
    assert.equal(matchesUrlPattern('https://api.example.dev.evil.com/', '*://api.example.dev/*'), false);
    assert.equal(matchesUrlPattern('http://localhost:30001/', 'http://localhost:3000/*'), false);
    assert.equal(matchesUrlPattern('https://localhost:3000/', 'http://localhost:3000/*'), false);
  });

  it('matches subdomains, the bare domain, and any port when none is given', () => {
    assert.equal(matchesUrlPattern('https://example.dev/', '*://*.example.dev/*'), true);
    assert.equal(matchesUrlPattern('https://a.b.example.dev/x', '*://*.example.dev/*'), true);
    assert.equal(matchesUrlPattern('https://api.example.dev:8443/x', '*://api.example.dev/*'), true);
    assert.equal(matchesUrlPattern('https://www.eu.etihad.com/x', 'https://www.*.etihad.com/*'), true);
    assert.equal(matchesUrlPattern('https://app.example.dev', 'https://app.example.dev/*'), true);
  });

  it('respects path boundaries', () => {
    assert.equal(matchesUrlPattern('https://api.example.dev/api', 'https://api.example.dev/api/*'), true);
    assert.equal(matchesUrlPattern('https://api.example.dev/api/v1', 'https://api.example.dev/api/*'), true);
    assert.equal(matchesUrlPattern('https://api.example.dev/apix', 'https://api.example.dev/api/*'), false);
  });

  it('does not enable CORS for lookalike requests or initiators', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['*.example.dev', 'http://localhost:3000'] });

    assert.equal(isCorsEnabledForRequest('https://attacker.com/x.example.dev/', undefined, settings), false);
    assert.equal(isCorsEnabledForRequest('https://bank.com/api', 'https://attacker.com/a.example.dev/', settings), false);
    assert.equal(isCorsEnabledForRequest('https://example.dev.evil.com/api', undefined, settings), false);
    assert.equal(isCorsEnabledForRequest('http://localhost:30001/api', undefined, settings), false);
    assert.equal(isCorsEnabledForRequest('https://api.backend.test/data', 'http://localhost:3000', settings), true);
  });

  it('resolves per-link allowed methods over the global default', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['api.example.dev'],
      methodOverrides: { 'api.example.dev': ['GET', 'POST'] },
      anyOriginTargets: ['api.example.dev']
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/users', 'https://app.example.dev/', settings), ['GET', 'POST']);
  });

  it('resolves the most specific matching custom rule', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'global',
      methodOverrides: {
        'api.example.dev': ['GET'],
        'https://api.example.dev/private/*': ['POST']
      }
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/private/data', undefined, settings), ['POST']);
  });

  it('resolves custom methods over a broader whitelist rule', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['api.example.dev', 'https://api.example.dev/private/*'],
      methodOverrides: { 'https://api.example.dev/private/*': ['PATCH'] },
      anyOriginTargets: ['api.example.dev', 'https://api.example.dev/private/*']
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/private/data', undefined, settings), ['PATCH']);
  });

  it('normalizes localhost ports for initiator matching', () => {
    assert.equal(getPatternHost('http://localhost:3000/*'), 'localhost');
    assert.equal(getPatternHost('*://*.example.dev/*'), '*.example.dev');
  });

  it('preserves an existing wildcard path', () => {
    assert.equal(normalizePattern('https://api.example.dev/private/*'), 'https://api.example.dev/private/*');
  });

  it('matches an exact selected URL and descendants', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['https://api.example.dev/api/data'], anyOriginTargets: ['https://api.example.dev/api/data'] });

    assert.equal(isCorsEnabledForRequest('https://api.example.dev/api/data', undefined, settings), true);
    assert.equal(isCorsEnabledForRequest('https://api.example.dev/api/data/details', undefined, settings), true);
  });

  it('enforces selected methods for matching requests', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['api.example.dev'], allowMethods: ['HEAD'], anyOriginTargets: ['api.example.dev'] });

    assert.equal(isRequestMethodAllowed('HEAD', 'https://api.example.dev/data', undefined, settings), true);
    assert.equal(isRequestMethodAllowed('GET', 'https://api.example.dev/data', undefined, settings), false);
  });

  it('applies query-specific methods only to the matching URL', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['https://api.example.dev/users'],
      methodOverrides: { 'https://api.example.dev/users?id=1': ['HEAD'] }
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/users?id=1', undefined, settings), ['HEAD']);
    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/users?id=2', undefined, settings), settings.allowMethods);
  });

  it('matches domain rules by first-party and third-party scope', () => {
    const firstParty = mergeSettings({ enabled: true, domainRules: [{ pattern: 'https://app.example.dev', type: 'first_party' }], anyOriginTargets: ['https://app.example.dev'] });
    const thirdParty = mergeSettings({ enabled: true, domainRules: [{ pattern: 'https://app.example.dev', type: 'third_party' }] });

    assert.equal(isCorsEnabledForRequest('https://app.example.dev/page', 'https://other.example.dev/', firstParty), true);
    assert.equal(isCorsEnabledForRequest('https://api.example.dev/data', 'https://app.example.dev/page', firstParty), false);
    assert.equal(isCorsEnabledForRequest('https://api.example.dev/data', 'https://app.example.dev/page', thirdParty), true);
  });

  it('resolves domain-rule methods consistently in global mode', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'global',
      domainRules: [{ pattern: 'https://app.example.dev', type: 'third_party' }],
      methodOverrides: { 'https://app.example.dev': ['HEAD'] }
    });

    assert.equal(isRequestMethodAllowed('HEAD', 'https://api.example.dev/data', 'https://app.example.dev/page', settings), true);
    assert.equal(isRequestMethodAllowed('GET', 'https://api.example.dev/data', 'https://app.example.dev/page', settings), false);
  });

  it('gives individual patterns priority over matching domain rules', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'global',
      whitelist: ['https://api.example.dev/private/*'],
      domainRules: [{ pattern: 'api.example.dev', type: 'both' }],
      methodOverrides: {
        'https://api.example.dev/private/*': ['PATCH'],
        'api.example.dev': ['GET']
      },
      anyOriginTargets: ['https://api.example.dev/private/*', 'api.example.dev']
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/private/data', 'https://app.example.dev/', settings), ['PATCH']);
  });

  it('keeps an individual pattern broad when it shares a domain rule', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['api.example.dev'],
      domainRules: [{ pattern: 'api.example.dev', type: 'first_party' }],
      anyOriginTargets: ['api.example.dev']
    });

    assert.equal(isCorsEnabledForRequest('https://api.example.dev/data', 'https://other.example.dev/', settings), true);
  });

  it('gives skip patterns priority over active and domain rules', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'global',
      whitelist: ['api.example.dev'],
      domainRules: [{ pattern: 'api.example.dev', type: 'both' }],
      skiplist: ['api.example.dev']
    });

    assert.equal(isCorsEnabledForRequest('https://api.example.dev/data', 'https://app.example.dev/', settings), false);
    assert.equal(isRequestMethodAllowed('GET', 'https://api.example.dev/data', 'https://app.example.dev/', settings), true);
  });

  it('explains the effective CORS rule for a request', () => {
    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: false, whitelist: ['api.example.dev'] })),
      { state: 'inactive', source: 'disabled' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: true, mode: 'global' })),
      { state: 'active', source: 'global', pattern: '<all_urls>' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/private/data', 'https://app.example.dev/', mergeSettings({ enabled: true, whitelist: ['api.example.dev', 'https://api.example.dev/private/*'], anyOriginTargets: ['api.example.dev', 'https://api.example.dev/private/*'] })),
      { state: 'active', source: 'pattern', pattern: 'https://api.example.dev/private/*' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: true, domainRules: [{ pattern: 'api.example.dev', type: 'first_party' }], anyOriginTargets: ['api.example.dev'] })),
      { state: 'active', source: 'domain', pattern: '*://api.example.dev/*', domainType: 'first_party' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: true, mode: 'global', skiplist: ['api.example.dev'] })),
      { state: 'skipped', source: 'skip', pattern: '*://api.example.dev/*' }
    );
  });

  it('relaxes requests made by a trusted page, whatever they call', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['http://localhost:3000'] });

    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', 'http://localhost:3000', settings), true);
    assert.equal(isCorsEnabledForRequest('https://other.api.dev/data', 'http://localhost:3000/app', settings), true);
    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.staging.dev/users', 'http://localhost:3000', settings),
      { state: 'active', source: 'pattern', pattern: 'http://localhost:3000/*' }
    );
  });

  it('does not open a rule target to other sites by default', () => {
    const settings = mergeSettings({
      enabled: true,
      whitelist: ['api.staging.dev'],
      domainRules: [{ pattern: 'api.domain.dev', type: 'both' }, { pattern: 'api.first.dev', type: 'first_party' }]
    });

    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', 'https://evil.com', settings), false);
    assert.equal(isCorsEnabledForRequest('https://api.domain.dev/users', 'https://evil.com', settings), false);
    assert.equal(isCorsEnabledForRequest('https://api.first.dev/users', 'https://evil.com', settings), false);
    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', undefined, settings), false);
    assert.deepEqual(getEffectiveCorsRuleForRequest('https://api.staging.dev/users', 'https://evil.com', settings), { state: 'inactive', source: 'none' });
  });

  it('opens a rule target to any site only when opted in', () => {
    const settings = mergeSettings({
      enabled: true,
      whitelist: ['api.staging.dev', 'api.closed.dev'],
      domainRules: [{ pattern: 'api.first.dev', type: 'first_party' }],
      anyOriginTargets: ['api.staging.dev', 'api.first.dev']
    });

    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', 'https://evil.com', settings), true);
    assert.equal(isCorsEnabledForRequest('https://api.first.dev/users', 'https://evil.com', settings), true);
    assert.equal(isCorsEnabledForRequest('https://api.closed.dev/users', 'https://evil.com', settings), false);
  });

  it('keeps global mode open to every site', () => {
    const settings = mergeSettings({ enabled: true, mode: 'global' });

    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', 'https://evil.com', settings), true);
  });

  it('migrates rules without an opt-in to the scoped default', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['api.staging.dev'] });

    assert.deepEqual(settings.anyOriginTargets, []);
    assert.equal(isCorsEnabledForRequest('https://api.staging.dev/users', 'https://evil.com', settings), false);
  });

  it('drops opt-ins for rules that no longer exist', () => {
    const settings = mergeSettings({
      whitelist: ['api.staging.dev'],
      domainRules: [{ pattern: 'api.domain.dev', type: 'both' }],
      anyOriginTargets: ['api.staging.dev', 'api.domain.dev', 'api.removed.dev', 'not a pattern ::']
    });

    assert.deepEqual(settings.anyOriginTargets, ['*://api.staging.dev/*', '*://api.domain.dev/*']);
  });

  it('round-trips opt-ins through rule export and import', () => {
    const settings = mergeSettings({ whitelist: ['api.staging.dev'], anyOriginTargets: ['api.staging.dev'] });
    const imported = mergeSettings(importRules(exportRules(settings)));

    assert.deepEqual(imported.anyOriginTargets, ['*://api.staging.dev/*']);
  });

  it('suggests trusting the page that made a request', () => {
    assert.equal(getTrustPatternForRequest('https://api.staging.dev/users', 'http://localhost:3000/app/page'), 'http://localhost:3000/*');
    assert.equal(getTrustPatternForRequest('https://api.staging.dev/users', null), 'https://api.staging.dev/users/*');
    assert.equal(getTrustPatternForRequest('https://api.staging.dev/users', 'chrome-extension://abc'), 'https://api.staging.dev/users/*');
  });
});
