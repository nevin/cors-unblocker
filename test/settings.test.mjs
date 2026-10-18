import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAllowedMethodsForRequest, getEffectiveCorsRuleForRequest, getPatternHost, isCorsEnabledForRequest, isRequestMethodAllowed, mergeSettings, normalizeMethodOverridePattern, normalizePattern, normalizePatterns } from '../dist-test/shared/settings.js';
import { matchesPattern } from '../dist-test/shared/matching.js';

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
    assert.equal(matchesPattern('https://api.example.dev/v1/users', '*://api.example.dev/*'), true);
    assert.equal(matchesPattern('https://other.example.dev/v1/users', '*://api.example.dev/*'), false);
    assert.equal(matchesPattern('http://localhost:3000/data', 'http://localhost:3000/*'), true);
    assert.equal(matchesPattern('ftp://localhost:3000/data', '<all_urls>'), false);
  });

  it('resolves per-link allowed methods over the global default', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['api.example.dev'],
      methodOverrides: { 'api.example.dev': ['GET', 'POST'] }
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
      methodOverrides: { 'https://api.example.dev/private/*': ['PATCH'] }
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
    const settings = mergeSettings({ enabled: true, whitelist: ['https://api.example.dev/api/data'] });

    assert.equal(isCorsEnabledForRequest('https://api.example.dev/api/data', undefined, settings), true);
    assert.equal(isCorsEnabledForRequest('https://api.example.dev/api/data/details', undefined, settings), true);
  });

  it('enforces selected methods for matching requests', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['api.example.dev'], allowMethods: ['HEAD'] });

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
    const firstParty = mergeSettings({ enabled: true, domainRules: [{ pattern: 'https://app.example.dev', type: 'first_party' }] });
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
      }
    });

    assert.deepEqual(getAllowedMethodsForRequest('https://api.example.dev/private/data', 'https://app.example.dev/', settings), ['PATCH']);
  });

  it('keeps an individual pattern broad when it shares a domain rule', () => {
    const settings = mergeSettings({
      enabled: true,
      mode: 'whitelist',
      whitelist: ['api.example.dev'],
      domainRules: [{ pattern: 'api.example.dev', type: 'first_party' }]
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
      getEffectiveCorsRuleForRequest('https://api.example.dev/private/data', 'https://app.example.dev/', mergeSettings({ enabled: true, whitelist: ['api.example.dev', 'https://api.example.dev/private/*'] })),
      { state: 'active', source: 'pattern', pattern: 'https://api.example.dev/private/*' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: true, domainRules: [{ pattern: 'api.example.dev', type: 'first_party' }] })),
      { state: 'active', source: 'domain', pattern: '*://api.example.dev/*', domainType: 'first_party' }
    );

    assert.deepEqual(
      getEffectiveCorsRuleForRequest('https://api.example.dev/data', 'https://app.example.dev/', mergeSettings({ enabled: true, mode: 'global', skiplist: ['api.example.dev'] })),
      { state: 'skipped', source: 'skip', pattern: '*://api.example.dev/*' }
    );
  });
});
