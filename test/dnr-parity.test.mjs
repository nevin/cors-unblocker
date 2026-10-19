import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDynamicRules } from '../dist-test/shared/dnrRules.js';
import { getAllowedMethodsForRequest, isCorsEnabledForRequest, mergeSettings } from '../dist-test/shared/settings.js';

// Minimal model of how Chrome applies this extension's dynamic rules to one response:
// a matching 'allow' rule cancels lower-priority modifyHeaders rules, and for each header the
// highest-priority 'set' wins.
function simulateChrome(rules, url, initiatorOrigin, serverHeaders = {}) {
  const initiatorHost = initiatorOrigin ? new URL(initiatorOrigin).hostname : null;
  const matches = rules.filter(({ condition }) => {
    if ((condition.excludedResponseHeaders ?? []).some(({ header }) => header in serverHeaders)) {
      return false;
    }
    if (condition.urlFilter === '|http' && !url.startsWith('http')) {
      return false;
    }
    if (condition.regexFilter && !new RegExp(condition.regexFilter).test(url)) {
      return false;
    }
    if (condition.initiatorDomains) {
      return Boolean(initiatorHost) && condition.initiatorDomains.some((domain) => initiatorHost === domain || initiatorHost.endsWith(`.${domain}`));
    }
    return true;
  });

  const allowPriority = Math.max(-Infinity, ...matches.filter((rule) => rule.action.type === 'allow').map((rule) => rule.priority));
  const headers = new Map(Object.entries(serverHeaders));
  const modified = new Set();
  matches
    .filter((rule) => rule.action.type === 'modifyHeaders' && rule.priority > allowPriority)
    .sort((left, right) => right.priority - left.priority)
    .forEach((rule) => rule.action.responseHeaders.forEach(({ header, value }) => {
      if (!modified.has(header)) {
        headers.set(header, value);
        modified.add(header);
      }
    }));
  return headers;
}

function sharedOutcome(settings, url, initiator) {
  const relaxed = isCorsEnabledForRequest(url, initiator, settings);
  return { relaxed, methods: relaxed ? getAllowedMethodsForRequest(url, initiator, settings).join(', ') : null };
}

function chromeOutcome(settings, url, initiator) {
  const headers = simulateChrome(buildDynamicRules(settings), url, initiator);
  const relaxed = headers.has('access-control-allow-origin');
  return { relaxed, methods: relaxed ? headers.get('access-control-allow-methods') : null };
}

const baseRules = {
  enabled: true,
  whitelist: ['http://localhost:3000', 'api.open.dev', 'api.closed.dev', '*.example.dev', 'https://api.paths.dev/v1/*'],
  skiplist: ['https://api.open.dev/admin/*', 'blocked.dev'],
  domainRules: [
    { pattern: 'api.domain.dev', type: 'both' },
    { pattern: 'api.first.dev', type: 'first_party' },
    { pattern: 'api.closedfirst.dev', type: 'first_party' },
    { pattern: 'app.third.dev', type: 'third_party' }
  ],
  anyOriginTargets: ['api.open.dev', 'api.first.dev', 'https://api.paths.dev/v1/*'],
  methodOverrides: {
    'https://api.open.dev/users?id=1': ['HEAD'],
    'http://localhost:3000': ['GET'],
    'https://api.paths.dev/v1/*': ['PUT'],
    'app.third.dev': ['DELETE']
  }
};

const scenarios = {
  whitelist: mergeSettings({ ...baseRules, mode: 'whitelist' }),
  global: mergeSettings({ ...baseRules, mode: 'global' }),
  disabled: mergeSettings({ ...baseRules, enabled: false })
};

const urls = [
  'https://api.open.dev/users',
  'https://api.open.dev/users?id=1',
  'https://api.open.dev/admin/settings',
  'https://api.closed.dev/data',
  'https://api.paths.dev/v1/items',
  'https://api.paths.dev/v2/items',
  'https://a.example.dev/data',
  'https://example.dev.evil.com/data',
  'https://evil.com/x.example.dev/',
  'https://api.domain.dev/data',
  'https://api.first.dev/data',
  'https://api.closedfirst.dev/data',
  'https://blocked.dev/data',
  'http://localhost:3000/api'
];

// Chrome reports initiators as origins, so the matrix uses origins too.
const initiators = [undefined, 'http://localhost:3000', 'https://evil.com', 'https://a.example.dev', 'https://app.third.dev', 'https://api.domain.dev', 'https://blocked.dev'];

describe('Chrome rules match the shared matcher', () => {
  Object.entries(scenarios).forEach(([name, settings]) => {
    it(`agrees on every request in ${name} mode`, () => {
      let compared = 0;
      for (const url of urls) {
        for (const initiator of initiators) {
          // CORS never applies to same-origin requests, where third-party rules intentionally differ.
          if (initiator && new URL(url).origin === initiator) {
            continue;
          }
          assert.deepEqual(chromeOutcome(settings, url, initiator), sharedOutcome(settings, url, initiator), `${name}: ${initiator ?? '(no initiator)'} -> ${url}`);
          compared += 1;
        }
      }
      assert.ok(compared > 80);
    });
  });

  it('relaxes the trusted page and the opted-in target, and nothing else', () => {
    const settings = scenarios.whitelist;
    assert.equal(chromeOutcome(settings, 'https://api.closed.dev/data', 'http://localhost:3000').relaxed, true);
    assert.equal(chromeOutcome(settings, 'https://api.closed.dev/data', 'https://evil.com').relaxed, false);
    assert.equal(chromeOutcome(settings, 'https://api.open.dev/users', 'https://evil.com').relaxed, true);
    assert.equal(chromeOutcome(settings, 'https://api.open.dev/admin/settings', 'http://localhost:3000').relaxed, false);
    assert.deepEqual(chromeOutcome(settings, 'https://api.open.dev/users?id=1', 'https://evil.com'), { relaxed: true, methods: 'HEAD' });
  });

  it('builds no rules while disabled', () => {
    assert.deepEqual(buildDynamicRules(scenarios.disabled), []);
  });

  it('builds valid rules', () => {
    const rules = buildDynamicRules(scenarios.global);
    assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
    assert.ok(rules.filter((rule) => rule.condition.regexFilter).length <= 1000);
    rules.forEach((rule) => {
      // Chrome's RE2 engine rejects lookarounds and backreferences.
      assert.doesNotMatch(rule.condition.regexFilter ?? '', /\(\?[=!<]|\\\d/);
      (rule.condition.initiatorDomains ?? []).forEach((domain) => assert.match(domain, /^[a-z0-9.-]+$/));
    });
  });
});

describe('known Chrome limitations', () => {
  it('cannot trust a host with a mid-pattern wildcard, so it fails closed', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['https://www.*.etihad.com/*'] });

    assert.equal(sharedOutcome(settings, 'https://api.dev/data', 'https://www.eu.etihad.com').relaxed, true);
    assert.equal(chromeOutcome(settings, 'https://api.dev/data', 'https://www.eu.etihad.com').relaxed, false);
    assert.doesNotThrow(() => buildDynamicRules(settings));
  });

  it('matches a trusted page by domain, so other ports and subdomains are trusted too', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['http://localhost:3000', 'app.example.dev'] });

    assert.equal(sharedOutcome(settings, 'https://api.dev/data', 'http://localhost:4000').relaxed, false);
    assert.equal(chromeOutcome(settings, 'https://api.dev/data', 'http://localhost:4000').relaxed, true);
    assert.equal(sharedOutcome(settings, 'https://api.dev/data', 'https://sub.app.example.dev').relaxed, false);
    assert.equal(chromeOutcome(settings, 'https://api.dev/data', 'https://sub.app.example.dev').relaxed, true);
  });

  it('cannot echo the request origin, so credentialed rules do not open targets to other sites', () => {
    const settings = mergeSettings({
      enabled: true,
      allowCredentials: true,
      whitelist: ['https://app.example.dev', 'https://api.example.dev'],
      anyOriginTargets: ['https://api.example.dev']
    });

    assert.equal(sharedOutcome(settings, 'https://api.example.dev/data', 'https://other.dev').relaxed, true);
    assert.equal(chromeOutcome(settings, 'https://api.example.dev/data', 'https://other.dev').relaxed, false);
    assert.equal(chromeOutcome(settings, 'https://api.other.dev/data', 'https://app.example.dev').relaxed, true);
  });

  it('leaves responses that already allow CORS untouched unless told to override them', () => {
    const serverHeaders = { 'access-control-allow-origin': 'https://prod.example.com', 'access-control-allow-credentials': 'true' };
    const respect = mergeSettings({ enabled: true, whitelist: ['http://localhost:3000'] });
    const override = mergeSettings({ ...respect, respectServerCors: false });

    assert.equal(simulateChrome(buildDynamicRules(respect), 'https://api.dev/data', 'http://localhost:3000', serverHeaders).get('access-control-allow-origin'), 'https://prod.example.com');
    assert.equal(simulateChrome(buildDynamicRules(override), 'https://api.dev/data', 'http://localhost:3000', serverHeaders).get('access-control-allow-origin'), '*');
    assert.equal(simulateChrome(buildDynamicRules(respect), 'https://api.dev/data', 'http://localhost:3000').get('access-control-allow-origin'), '*');
    assert.ok(buildDynamicRules(respect).filter((rule) => rule.action.type === 'allow').every((rule) => !rule.condition.excludedResponseHeaders));
  });

  it('exposes response headers and varies credentialed responses by Origin', () => {
    const plain = buildDynamicRules(mergeSettings({ enabled: true, whitelist: ['http://localhost:3000'] }));
    const plainHeaders = simulateChrome(plain, 'https://api.dev/data', 'http://localhost:3000');
    assert.equal(plainHeaders.get('access-control-expose-headers'), '*');
    assert.equal(plainHeaders.has('vary'), false);

    const credentialed = buildDynamicRules(mergeSettings({ enabled: true, whitelist: ['http://localhost:3000'], allowCredentials: true }));
    const varyHeader = credentialed.flatMap((rule) => rule.action.responseHeaders ?? []).find((header) => header.header === 'vary');
    assert.deepEqual(varyHeader, { header: 'vary', operation: 'append', value: 'Origin' });
    assert.equal(simulateChrome(credentialed, 'https://api.dev/data', 'http://localhost:3000').get('access-control-allow-origin'), 'http://localhost:3000');

    const hidden = buildDynamicRules(mergeSettings({ enabled: true, whitelist: ['http://localhost:3000'], exposeAllHeaders: false }));
    assert.equal(simulateChrome(hidden, 'https://api.dev/data', 'http://localhost:3000').has('access-control-expose-headers'), false);
  });
});

