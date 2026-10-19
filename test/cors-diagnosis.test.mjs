import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCorsFixes, collectCorsFixes, countOpenIssues, describeCorsCall, describeCorsFix, describeCorsProblem, findCorsProblem, summarizeCorsProblem, isCorsRequest, planCorsFix, planCorsIssues, readCorsRequest } from '../dist-test/shared/corsDiagnosis.js';
import { isCorsEnabledForRequest, mergeSettings } from '../dist-test/shared/settings.js';

const app = 'http://localhost:3000';
const api = 'https://api.staging.dev/users';
const headers = (values) => Object.entries(values).map(([name, value]) => ({ name, value }));

function request(method, extra = {}) {
  return readCorsRequest(api, method, headers({ Origin: app, ...extra }));
}

function preflight(requestedMethod, requestedHeaders) {
  return request('OPTIONS', {
    'Access-Control-Request-Method': requestedMethod,
    ...(requestedHeaders ? { 'Access-Control-Request-Headers': requestedHeaders } : {})
  });
}

describe('CORS request detection', () => {
  it('treats cross-origin requests with an Origin header as CORS requests', () => {
    assert.equal(isCorsRequest(request('GET')), true);
    assert.equal(isCorsRequest(request('GET', { 'Sec-Fetch-Mode': 'cors' })), true);
  });

  it('ignores same-origin, no-cors and origin-less requests', () => {
    assert.equal(isCorsRequest(readCorsRequest(`${app}/api`, 'GET', headers({ Origin: app }))), false);
    assert.equal(isCorsRequest(request('POST', { 'Sec-Fetch-Mode': 'no-cors' })), false);
    assert.equal(isCorsRequest(readCorsRequest(api, 'GET', [])), false);
  });
});

describe('CORS problem detection', () => {
  it('passes responses the browser would accept', () => {
    assert.equal(findCorsProblem(request('GET'), 200, headers({ 'Access-Control-Allow-Origin': '*' })), null);
    assert.equal(findCorsProblem(request('GET'), 500, headers({ 'Access-Control-Allow-Origin': app })), null);
    assert.equal(findCorsProblem(preflight('PUT', 'content-type'), 204, headers({
      'Access-Control-Allow-Origin': app,
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Allow-Headers': 'Content-Type'
    })), null);
  });

  it('reports a missing or mismatched Allow-Origin', () => {
    assert.deepEqual(findCorsProblem(request('GET'), 200, []), { reason: 'missing-allow-origin', detail: null });
    assert.deepEqual(findCorsProblem(request('GET'), 200, headers({ 'Access-Control-Allow-Origin': 'https://prod.example.com' })), { reason: 'origin-mismatch', detail: 'https://prod.example.com' });
  });

  it('reports preflight status, methods and headers', () => {
    assert.deepEqual(findCorsProblem(preflight('PUT'), 404, []), { reason: 'preflight-status', detail: '404' });
    assert.deepEqual(findCorsProblem(preflight('DELETE'), 204, headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT' })), { reason: 'method-not-allowed', detail: 'DELETE' });
    assert.deepEqual(findCorsProblem(preflight('GET', 'x-api-key, x-trace'), 204, headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-trace' })), { reason: 'headers-not-allowed', detail: 'x-api-key' });
  });

  it('does not let a wildcard cover the Authorization header', () => {
    const response = headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    assert.deepEqual(findCorsProblem(preflight('GET', 'authorization, x-trace'), 204, response), { reason: 'headers-not-allowed', detail: 'authorization' });
    assert.equal(findCorsProblem(preflight('GET', 'authorization'), 204, headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*, Authorization' })), null);
  });

  it('never requires simple methods to be listed', () => {
    assert.equal(findCorsProblem(preflight('POST', 'content-type'), 204, headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' })), null);
  });
});

describe('CORS fix planning', () => {
  const missing = { reason: 'missing-allow-origin', detail: null };

  it('lists every change needed while overrides are off', () => {
    const plan = planCorsFix(request('GET'), missing, false, mergeSettings({}));
    assert.deepEqual(plan, { state: 'blocked', fixes: [{ kind: 'enable' }, { kind: 'trust-page', pattern: 'http://localhost:3000/*' }] });
  });

  it('reports a request the current rules already fix', () => {
    const settings = mergeSettings({ enabled: true, whitelist: [app] });
    assert.deepEqual(planCorsFix(request('GET'), missing, false, settings), { state: 'fixed', fixes: [] });
  });

  it('asks to override the server only when the server sent its own Allow-Origin', () => {
    const settings = mergeSettings({ enabled: true, whitelist: [app] });
    const mismatch = { reason: 'origin-mismatch', detail: 'https://prod.example.com' };
    assert.deepEqual(planCorsFix(request('GET'), mismatch, true, settings).fixes, [{ kind: 'override-server' }]);
    assert.equal(planCorsFix(request('GET'), mismatch, true, mergeSettings({ ...settings, respectServerCors: false })).state, 'fixed');
  });

  it('adds missing methods and headers for preflights', () => {
    const settings = mergeSettings({ enabled: true, whitelist: [app], allowMethods: ['GET', 'POST'] });
    const plan = planCorsFix(preflight('PATCH', 'x-api-key'), missing, false, settings);
    assert.deepEqual(plan.fixes, [{ kind: 'allow-method', method: 'PATCH' }, { kind: 'allow-headers' }]);
  });

  it('cannot fix a failing preflight status and respects skip rules', () => {
    assert.deepEqual(planCorsFix(preflight('PUT'), { reason: 'preflight-status', detail: '404' }, false, mergeSettings({})), { state: 'unfixable', fixes: [] });
    assert.equal(planCorsFix(request('GET'), missing, false, mergeSettings({ enabled: true, whitelist: [app], skiplist: ['api.staging.dev'] })).state, 'skipped');
  });

  it('applies a plan so the request becomes fixed', () => {
    const settings = mergeSettings({ allowMethods: ['GET'] });
    const req = preflight('PUT', 'x-api-key');
    const fixed = mergeSettings({ ...settings, ...applyCorsFixes(settings, planCorsFix(req, missing, false, settings).fixes) });

    assert.equal(fixed.enabled, true);
    assert.equal(fixed.allowAllHeaders, true);
    assert.ok(fixed.allowMethods.includes('PUT'));
    assert.equal(isCorsEnabledForRequest(api, app, fixed), true);
    assert.deepEqual(planCorsFix(req, missing, false, fixed), { state: 'fixed', fixes: [] });
  });

  it('summarizes problems in a few words', () => {
    assert.equal(summarizeCorsProblem({ reason: 'preflight-status', detail: '405' }), 'Server answered 405');
    assert.equal(summarizeCorsProblem({ reason: 'credentials-wildcard', detail: null }), 'Sends cookies, but the server allows *');
    assert.equal(describeCorsFix({ kind: 'enable' }), 'Turn CORS Unblocker on');
  });

  it('describes problems and fixes in plain words', () => {
    assert.match(describeCorsProblem({ reason: 'preflight-status', detail: '404' }, { origin: app }), /404.*cannot change status codes/);
    assert.match(describeCorsProblem({ reason: 'origin-mismatch', detail: 'https://prod.example.com' }, { origin: app }), /allows https:\/\/prod\.example\.com, not http:\/\/localhost:3000/);
    assert.equal(describeCorsFix({ kind: 'trust-page', pattern: 'http://localhost:3000/*' }), 'Trust localhost:3000');
  });
});

describe('CORS issue lists', () => {
  const issue = (key, extra = {}) => ({
    key, url: 'https://api.staging.dev/v1/users', pageOrigin: app, method: 'GET', preflight: false, requestedHeaders: [],
    problem: { reason: 'missing-allow-origin', detail: null }, serverSentAllowOrigin: false, count: 1, lastSeen: 0, ...extra
  });
  const issues = [
    issue('a'),
    issue('b', { url: 'https://api.staging.dev/v1/orders', method: 'PATCH', preflight: true, requestedHeaders: ['x-api-key'] }),
    issue('c', { url: 'https://auth.example.com/session', problem: { reason: 'origin-mismatch', detail: 'https://prod.example.com' }, serverSentAllowOrigin: true }),
    issue('d', { url: 'https://legacy.internal/report', method: 'DELETE', preflight: true, problem: { reason: 'preflight-status', detail: '405' } })
  ];

  it('collects each needed fix once, leaving server overrides for explicit confirmation', () => {
    const settings = mergeSettings({ allowMethods: ['GET'] });
    const planned = planCorsIssues(issues, settings);

    assert.deepEqual(collectCorsFixes(planned), [
      { kind: 'enable' },
      { kind: 'trust-page', pattern: 'http://localhost:3000/*' },
      { kind: 'allow-method', method: 'PATCH' },
      { kind: 'allow-headers' }
    ]);
    assert.ok(collectCorsFixes(planned, { includeOverride: true }).some((fix) => fix.kind === 'override-server'));
  });

  it('counts open issues before and after fixing', () => {
    const settings = mergeSettings({ allowMethods: ['GET'] });
    assert.equal(countOpenIssues(issues, settings), 4);

    const fixed = mergeSettings({ ...settings, ...applyCorsFixes(settings, collectCorsFixes(planCorsIssues(issues, settings))) });
    assert.deepEqual(planCorsIssues(issues, fixed).map(({ issue: { key }, state }) => `${key}:${state}`), ['a:fixed', 'b:fixed', 'c:blocked', 'd:unfixable']);
    assert.equal(countOpenIssues(issues, fixed), 2);
  });

  it('describes a call by method and path', () => {
    assert.equal(describeCorsCall(issues[0]), 'GET /v1/users');
    assert.equal(describeCorsCall(issues[1]), 'Preflight for PATCH /v1/orders');
  });
});

describe('credentialed calls', () => {
  const credentialed = (method = 'GET') => request(method, { Cookie: 'session=1' });
  const cors = (values) => headers({ 'Access-Control-Allow-Origin': app, ...values });

  it('treats a Cookie header as credentials mode', () => {
    assert.equal(credentialed().credentialed, true);
    assert.equal(request('GET').credentialed, false);
  });

  it('reports a wildcard origin and a missing Allow-Credentials', () => {
    assert.deepEqual(findCorsProblem(credentialed(), 200, headers({ 'Access-Control-Allow-Origin': '*' })), { reason: 'credentials-wildcard', detail: null });
    assert.deepEqual(findCorsProblem(credentialed(), 200, cors({})), { reason: 'credentials-not-allowed', detail: null });
    assert.equal(findCorsProblem(credentialed(), 200, cors({ 'Access-Control-Allow-Credentials': 'true' })), null);
    assert.equal(findCorsProblem(request('GET'), 200, headers({ 'Access-Control-Allow-Origin': '*' })), null);
  });

  it('plans credentials, exact-origin trust and a server override', () => {
    const plan = planCorsFix(credentialed(), { reason: 'credentials-wildcard', detail: null }, true, mergeSettings({}));
    assert.deepEqual(plan.fixes, [
      { kind: 'enable' },
      { kind: 'trust-page', pattern: 'http://localhost:3000/*' },
      { kind: 'override-server' },
      { kind: 'allow-credentials' }
    ]);
  });

  it('requires trusting the exact origin when the page is only trusted by wildcard', () => {
    const settings = mergeSettings({ enabled: true, whitelist: ['localhost'], allowCredentials: true });
    assert.deepEqual(planCorsFix(credentialed(), { reason: 'missing-allow-origin', detail: null }, false, settings).fixes, [
      { kind: 'trust-page', pattern: 'http://localhost:3000/*' }
    ]);
  });

  it('leaves global mode for credentialed calls', () => {
    const settings = mergeSettings({ enabled: true, mode: 'global', allowCredentials: true });
    const plan = planCorsFix(credentialed(), { reason: 'missing-allow-origin', detail: null }, false, settings);
    assert.deepEqual(plan.fixes, [{ kind: 'whitelist-mode' }, { kind: 'trust-page', pattern: 'http://localhost:3000/*' }]);
    const fixed = mergeSettings({ ...settings, ...applyCorsFixes(settings, plan.fixes) });
    assert.deepEqual(planCorsFix(credentialed(), { reason: 'missing-allow-origin', detail: null }, false, fixed), { state: 'fixed', fixes: [] });
  });

  it('describes credentials problems', () => {
    assert.match(describeCorsProblem({ reason: 'credentials-wildcard', detail: null }, { origin: app }), /Allow-Origin: \*/);
    assert.match(describeCorsFix({ kind: 'allow-credentials' }), /Allow credentials/);
  });
});

