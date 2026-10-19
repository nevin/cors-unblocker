import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCorsFixes, collectCorsFixes, planCorsIssues, planIssueFix } from '../dist-test/shared/corsDiagnosis.js';
import { mergeSettings } from '../dist-test/shared/settings.js';

export async function waitFor(check, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Browsers cache preflight results for a few seconds per URL, so each request that needs a fresh
// preflight uses a path no earlier request has used.
let pathCounter = 0;
export function freshPath(name) {
  pathCounter += 1;
  return `/${name}-${pathCounter}`;
}

// Cases every browser build must pass. `h` is a browser harness:
//   h.app, h.evil, h.api, h.siteApp, h.siteApi   test origins (set before the cases run)
//   h.configure(settings)                         store settings and wait until they are in effect
//   h.settle(settings)                            wait until the given settings are in effect
//   h.setRawSettings(settings)                    store settings without waiting
//   h.fetchFrom(origin, url, init)                fetch from a fresh tab: { readable, body, totalCount, error }
//   h.openPage(origin)                            keep a tab open: { fetchHere, issues, badge, goto, close }
//   h.readLogs()                                  { session, local } request log
//   h.readEnabled()                               { enabled, pausedUntil } as stored
//   h.title()                                     toolbar tooltip
export function defineSharedCases(h) {
  describe(`${h.name}: rules in a real browser`, () => {
    it('leaves CORS alone while disabled', async () => {
      await h.configure({ enabled: false, whitelist: [h.app] });

      assert.equal((await h.fetchFrom(h.app, `${h.api}/data`)).readable, false);
    });

    it('relaxes requests made by a trusted page, and only by that page', async () => {
      await h.configure({ enabled: true, whitelist: [h.app] });

      const trusted = await h.fetchFrom(h.app, `${h.api}/data`);
      assert.equal(trusted.readable, true, trusted.error);
      assert.deepEqual(trusted.body, { ok: true, method: 'GET', path: '/data' });
      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, false);
    });

    it('does not open a whitelisted target to other sites without the opt-in', async () => {
      await h.configure({ enabled: true, whitelist: [h.api] });

      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, false);
    });

    it('opens a target to every site with "Any site may read"', async () => {
      await h.configure({ enabled: true, whitelist: [h.api], anyOriginTargets: [h.api] });

      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, true);
    });

    it('lets a skip rule win over a trusted page, by path', async () => {
      await h.configure({ enabled: true, whitelist: [h.app], skiplist: [`${h.api}/admin/*`] });

      assert.equal((await h.fetchFrom(h.app, `${h.api}/admin/users`)).readable, false);
      assert.equal((await h.fetchFrom(h.app, `${h.api}/data`)).readable, true);
    });

    it('uses the allowed methods in preflight responses', async () => {
      const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };

      await h.configure({ enabled: true, whitelist: [h.app], allowMethods: ['GET', 'POST'], allowAllHeaders: true });
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('methods')}`, put)).readable, false);

      await h.configure({ enabled: true, whitelist: [h.app], allowMethods: ['GET', 'PUT'], allowAllHeaders: true });
      const allowed = await h.fetchFrom(h.app, `${h.api}${freshPath('methods')}`, put);
      assert.equal(allowed.readable, true, allowed.error);
      assert.equal(allowed.body.method, 'PUT');
    });

    it('applies a method override on a query-specific URL', async () => {
      const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };
      const path = freshPath('override');
      await h.configure({
        enabled: true,
        whitelist: [h.app],
        allowAllHeaders: true,
        methodOverrides: { [`${h.api}${path}?id=1`]: ['GET'] }
      });

      assert.equal((await h.fetchFrom(h.app, `${h.api}${path}?id=1`, put)).readable, false);
      assert.equal((await h.fetchFrom(h.app, `${h.api}${path}?id=2`, put)).readable, true);
    });

    it('allows custom request headers only with "allow all headers"', async () => {
      const withHeader = { headers: { 'x-custom': '1' } };

      await h.configure({ enabled: true, whitelist: [h.app], allowAllHeaders: false });
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('headers')}`, withHeader)).readable, false);

      await h.configure({ enabled: true, whitelist: [h.app], allowAllHeaders: true });
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('headers')}`, withHeader)).readable, true);
    });

    it('supports credentialed requests from an explicit origin', async () => {
      await h.configure({ enabled: true, whitelist: [h.app], allowCredentials: true });

      const result = await h.fetchFrom(h.app, `${h.api}/data`, { credentials: 'include' });
      assert.equal(result.readable, true, result.error);
    });

    it('relaxes everything in global mode, except skipped URLs', async () => {
      await h.configure({ enabled: true, mode: 'global' });
      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, true);

      await h.configure({ enabled: true, mode: 'global', skiplist: [h.api] });
      assert.equal((await h.fetchFrom(h.evil, `${h.api}/data`)).readable, false);
    });

    it('logs requests to session storage without query strings, and only while enabled', async () => {
      const disabledPath = freshPath('log-disabled');
      const enabledPath = freshPath('log-enabled');
      const isLogged = (logs, path) => logs.session.some((entry) => entry.url.includes(path));

      await h.configure({ enabled: false, whitelist: [h.app] });
      await h.fetchFrom(h.app, `${h.api}${disabledPath}?token=disabled-secret`);

      await h.configure({ enabled: true, whitelist: [h.app] });
      await h.fetchFrom(h.app, `${h.api}${enabledPath}?token=enabled-secret`);
      await waitFor(async () => isLogged(await h.readLogs(), enabledPath), 'the request to be logged');

      const logs = await h.readLogs();
      assert.equal(isLogged(logs, disabledPath), false);
      assert.ok(logs.session.some((entry) => entry.url === `${h.api}${enabledPath}`));
      assert.equal(logs.local, undefined);
      assert.doesNotMatch(JSON.stringify(logs.session), /secret/);
    });
  });

  describe(`${h.name}: blocked-call detection in a real browser`, () => {
    it('detects a blocked call while overrides are off, and the suggested fix makes it work', async () => {
      await h.configure({ enabled: false });
      const tab = await h.openPage(h.app);
      const path = freshPath('detect');
      try {
        assert.equal((await tab.fetchHere(`${h.api}${path}?token=secret`)).readable, false);
        await waitFor(async () => (await tab.issues()).length === 1, 'the blocked call to be detected');

        const [issue] = await tab.issues();
        assert.equal(issue.url, `${h.api}${path}`);
        assert.equal(issue.pageOrigin, h.app);
        assert.equal(issue.problem.reason, 'missing-allow-origin');
        assert.equal(await tab.badge(), '1');

        const settings = mergeSettings({ enabled: false });
        const plan = planIssueFix(issue, settings);
        assert.deepEqual(plan.fixes.map((fix) => fix.kind), ['enable', 'trust-page']);
        await h.configure({ ...settings, ...applyCorsFixes(settings, plan.fixes) });

        await waitFor(async () => (await tab.badge()) === '', 'the badge to clear after the fix');
        assert.equal((await tab.fetchHere(`${h.api}${path}`)).readable, true);
      } finally {
        await tab.close();
      }
    });

    it('reports a failing preflight status as something headers cannot fix', async () => {
      await h.configure({ enabled: true, whitelist: [h.app], allowAllHeaders: true });
      const tab = await h.openPage(h.app);
      try {
        const put = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' };
        assert.equal((await tab.fetchHere(`${h.api}/preflight-404${freshPath('x')}`, put)).readable, false);
        await waitFor(async () => (await tab.issues()).length === 1, 'the failed preflight to be detected');

        const [issue] = await tab.issues();
        assert.deepEqual(issue.problem, { reason: 'preflight-status', detail: '404' });
        assert.equal(issue.preflight, true);
        assert.equal(issue.method, 'PUT');
        assert.equal(await tab.badge(), '1');
      } finally {
        await tab.close();
      }
    });

    it('records nothing for calls that work, and clears issues when the tab navigates', async () => {
      await h.configure({ enabled: false });
      const tab = await h.openPage(h.app);
      try {
        assert.equal((await tab.fetchHere(`${h.api}/cors-ok${freshPath('ok')}`, { credentials: 'include' })).readable, true);
        assert.equal((await tab.fetchHere(`${h.api}${freshPath('blocked')}`)).readable, false);
        await waitFor(async () => (await tab.issues()).length === 1, 'only the blocked call to be detected');

        await tab.goto(`${h.app}/`);
        await waitFor(async () => (await tab.issues()).length === 0 && (await tab.badge()) === '', 'navigation to clear the issues');
      } finally {
        await tab.close();
      }
    });

    it('does not record anything when detection is turned off', async () => {
      await h.configure({ enabled: false, detectCorsIssues: false });
      const tab = await h.openPage(h.app);
      try {
        assert.equal((await tab.fetchHere(`${h.api}${freshPath('quiet')}`)).readable, false);
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.deepEqual(await tab.issues(), []);
        assert.equal(await tab.badge(), '');
      } finally {
        await tab.close();
      }
    });
  });

  describe(`${h.name}: server CORS headers, credentials and exposed headers in a real browser`, () => {
    const withCookies = { credentials: 'include' };

    it('keeps a credentialed API that handles CORS itself working on a trusted page', async () => {
      await h.configure({ enabled: true, whitelist: [h.app] });
      const kept = await h.fetchFrom(h.app, `${h.api}/cors-ok${freshPath('respect')}`, withCookies);
      assert.equal(kept.readable, true, kept.error);
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('plain')}`)).readable, true);

      // Without respect mode, the extension's Allow-Origin: * replaces the server's echo and breaks credentials.
      await h.configure({ enabled: true, whitelist: [h.app], respectServerCors: false });
      assert.equal((await h.fetchFrom(h.app, `${h.api}/cors-ok${freshPath('override')}`, withCookies)).readable, false);
    });

    it('lets "allow all headers" cover the Authorization header', async () => {
      await h.configure({ enabled: true, whitelist: [h.app], allowAllHeaders: true });

      const result = await h.fetchFrom(h.app, `${h.api}${freshPath('auth')}`, { headers: { authorization: 'Bearer test-token' } });
      assert.equal(result.readable, true, result.error);
    });

    it('detects a credentialed call rejected for Allow-Origin: *, and the planned fix makes it work', async () => {
      await h.configure({ enabled: false });
      const tab = await h.openPage(h.siteApp);
      const path = `/wildcard${freshPath('cred')}`;
      try {
        assert.equal((await tab.fetchHere(`${h.siteApi}${path}`, withCookies)).readable, false);
        // Without cookies, the same wildcard answer is fine and nothing is recorded for it.
        assert.equal((await tab.fetchHere(`${h.siteApi}/wildcard${freshPath('no-cookies')}`)).readable, true);
        await waitFor(async () => (await tab.issues()).length === 1, 'the credentialed call to be detected');

        const [issue] = await tab.issues();
        assert.equal(issue.credentialed, true);
        assert.equal(issue.problem.reason, 'credentials-wildcard');

        const settings = mergeSettings({ enabled: false });
        const fixes = collectCorsFixes(planCorsIssues([issue], settings), { includeOverride: true });
        assert.deepEqual(fixes.map((fix) => fix.kind), ['enable', 'trust-page', 'override-server', 'allow-credentials']);
        await h.configure({ ...settings, ...applyCorsFixes(settings, fixes) });

        const fixed = await tab.fetchHere(`${h.siteApi}${path}`, withCookies);
        assert.equal(fixed.readable, true, fixed.error);
      } finally {
        await tab.close();
      }
    });

    it('asks for credentials when a trusted page sends cookies, and works once allowed', async () => {
      await h.configure({ enabled: true, whitelist: [h.siteApp] });
      const tab = await h.openPage(h.siteApp);
      const path = freshPath('needs-credentials');
      try {
        assert.equal((await tab.fetchHere(`${h.siteApi}${path}`, withCookies)).readable, false);
        await waitFor(async () => (await tab.issues()).length === 1, 'the credentialed call to be detected');

        const [issue] = await tab.issues();
        const settings = mergeSettings({ enabled: true, whitelist: [h.siteApp] });
        assert.deepEqual(planIssueFix(issue, settings).fixes, [{ kind: 'allow-credentials' }]);

        await h.configure({ ...settings, allowCredentials: true });
        const fixed = await tab.fetchHere(`${h.siteApi}${path}`, withCookies);
        assert.equal(fixed.readable, true, fixed.error);
        await waitFor(async () => (await tab.badge()) === '', 'the badge to clear');
      } finally {
        await tab.close();
      }
    });

    it('lets pages read custom response headers only when headers are exposed', async () => {
      await h.configure({ enabled: true, whitelist: [h.app] });
      assert.equal((await h.fetchFrom(h.app, `${h.api}/with-headers${freshPath('expose')}`)).totalCount, '42');

      await h.configure({ enabled: true, whitelist: [h.app], exposeAllHeaders: false });
      const hidden = await h.fetchFrom(h.app, `${h.api}/with-headers${freshPath('hidden')}`);
      assert.equal(hidden.readable, true);
      assert.equal(hidden.totalCount, null);
    });
  });

  describe(`${h.name}: pausing and the toolbar in a real browser`, () => {
    it('turns overrides back on when the pause ends', async () => {
      await h.configure({ enabled: false, pausedUntil: Date.now() + 1_500, whitelist: [h.app] });
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('paused')}`)).readable, false);

      await waitFor(async () => (await h.readEnabled()).enabled === true, 'the pause to end', 10_000);
      assert.equal((await h.readEnabled()).pausedUntil, null);
      await h.settle({ enabled: true, whitelist: [h.app] });
      assert.equal((await h.fetchFrom(h.app, `${h.api}${freshPath('resumed')}`)).readable, true);
    });

    it('ends a pause that expired while the extension was asleep', async () => {
      await h.setRawSettings({ enabled: false, pausedUntil: Date.now() - 1_000 });
      await waitFor(async () => (await h.readEnabled()).enabled === true, 'the expired pause to end');
    });

    it('shows whether overrides are on, off or paused on the toolbar', async () => {
      await h.configure({ enabled: false });
      await waitFor(async () => (await h.title()) === 'CORS Unblocker: Off', 'the Off tooltip');

      await h.configure({ enabled: true, whitelist: [h.app] });
      await waitFor(async () => (await h.title()) === 'CORS Unblocker: On · 1 trusted page', 'the On tooltip');

      await h.configure({ enabled: false, pausedUntil: Date.now() + 3_600_000 });
      await waitFor(async () => (await h.title()).startsWith('CORS Unblocker: Paused until'), 'the Paused tooltip');
    });
  });
}
