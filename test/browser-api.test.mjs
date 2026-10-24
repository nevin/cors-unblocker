import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const stored = new Map();
const sessionStored = new Map();
const listeners = [];
const setCalls = [];
// The organization's policy. null means none: Firefox then rejects managed reads.
let managedPolicy = null;

const storage = {
  local: {
    async get(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requestedKeys.filter((key) => stored.has(key)).map((key) => [key, stored.get(key)]));
    },
    async set(values) {
      setCalls.push(values);
      Object.entries(values).forEach(([key, value]) => stored.set(key, value));
      listeners.forEach((listener) => listener(
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])),
        'local'
      ));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => stored.delete(key));
    }
  },
  session: {
    async get(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requestedKeys.filter((key) => sessionStored.has(key)).map((key) => [key, sessionStored.get(key)]));
    },
    async set(values) {
      Object.entries(values).forEach(([key, value]) => sessionStored.set(key, value));
      listeners.forEach((listener) => listener(
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])),
        'session'
      ));
    }
  },
  managed: {
    async get() {
      if (managedPolicy === null) {
        throw new Error('Managed storage manifest not found');
      }
      return { ...managedPolicy };
    }
  },
  onChanged: {
    addListener(listener) {
      listeners.push(listener);
    }
  }
};

globalThis.chrome = { storage };
const { REQUEST_LOG_KEY, SettingsController, clearPersistedRequestLog, onDiscoveredRequestsChanged, recordDiscoveredRequest, toLoggedUrl } = await import('../dist-test/shared/browserApi.js');

describe('SettingsController', () => {
  it('loads legacy settings and updates only changed fields', async () => {
    stored.set('corsDevControlSettings', {
      enabled: false,
      mode: 'whitelist',
      whitelist: ['api.local.test']
    });

    const controller = new SettingsController();
    const initial = await controller.initialize();

    assert.deepEqual(initial, {
      enabled: false,
      mode: 'whitelist',
      whitelist: ['*://api.local.test/*'],
      skiplist: [],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      methodOverrides: {},
      theme: 'system',
      allowAllHeaders: false,
      allowCredentials: false,
      domainRules: [],
      anyOriginTargets: [],
      respectServerCors: true,
      detectCorsIssues: true,
      exposeAllHeaders: true,
      pausedUntil: null,
      callRules: [],
      policy: { overridesOff: false, trustedPages: [], everyWebsiteBlocked: false }
    });

    stored.set('mode', 'global');
    const updated = await controller.update({ enabled: true });

    assert.equal(updated.enabled, true);
    assert.equal(updated.mode, 'global');
    assert.equal(setCalls.at(-1).enabled, true);
    assert.equal(setCalls.at(-1).mode, undefined);
  });

  it('notifies subscribers when storage changes externally', async () => {
    const controller = new SettingsController();
    const received = [];
    controller.subscribe((settings) => received.push(settings));
    await controller.initialize();

    stored.set('enabled', true);
    listeners.at(-1)({ enabled: { newValue: true } }, 'local');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.at(-1).enabled, true);
  });
});

describe('request log', () => {
  it('drops query strings and fragments', () => {
    assert.equal(toLoggedUrl('https://api.example.dev/users?token=secret#section'), 'https://api.example.dev/users');
    assert.equal(toLoggedUrl('http://localhost:3000'), 'http://localhost:3000/');
    assert.equal(toLoggedUrl('chrome-extension://abc/page.html'), null);
    assert.equal(toLoggedUrl('not a url'), null);
  });

  it('records to session storage without query strings and never to local storage', async () => {
    const localWritesBefore = setCalls.filter((values) => REQUEST_LOG_KEY in values).length;
    const notified = [];
    onDiscoveredRequestsChanged((requests) => notified.push(requests));

    await recordDiscoveredRequest('https://api.example.dev/users?token=secret', 'https://app.example.dev/page?session=abc', 7, 'fetch');
    await recordDiscoveredRequest('https://api.example.dev/users?token=other', 'https://app.example.dev/page?session=abc', 7);

    const log = sessionStored.get(REQUEST_LOG_KEY);
    assert.equal(log.length, 1);
    assert.equal(log[0].url, 'https://api.example.dev/users');
    assert.equal(log[0].initiator, 'https://app.example.dev/page');
    assert.equal(log[0].count, 2);
    // A later sighting without a type keeps the type already known.
    assert.equal(log[0].type, 'fetch');
    assert.doesNotMatch(JSON.stringify(log), /secret|session=abc/);
    assert.equal(setCalls.filter((values) => REQUEST_LOG_KEY in values).length, localWritesBefore);
    assert.equal(notified.at(-1)[0].url, 'https://api.example.dev/users');
  });

  it('removes a request log persisted by earlier versions', async () => {
    stored.set(REQUEST_LOG_KEY, [{ url: 'https://old.example.dev/?token=secret' }]);
    await clearPersistedRequestLog();
    assert.equal(stored.has(REQUEST_LOG_KEY), false);
  });
});

describe('pausing', () => {
  it('saves the pause end whenever overrides are switched on or off', async () => {
    const controller = new SettingsController();
    await controller.initialize();

    await controller.update({ enabled: false, pausedUntil: Date.now() + 60_000 });
    assert.equal(typeof stored.get('pausedUntil'), 'number');

    // Switching on ends the pause; the stored field must not keep the old end time.
    await controller.update({ enabled: true });
    assert.equal(stored.get('pausedUntil'), null);
    assert.equal(controller.settings.pausedUntil, null);
  });
});


describe('organization policy', () => {
  it('enforces the policy on top of the user\'s own settings', async () => {
    stored.clear();
    stored.set('corsDevControlSettings', { enabled: true, mode: 'global', whitelist: ['localhost:5173'] });
    managedPolicy = { disableOverrides: true, trustedPages: ['localhost:3000', 42], blockEveryWebsiteMode: true };
    try {
      const controller = new SettingsController();
      const settings = await controller.initialize();

      assert.equal(settings.enabled, false);
      assert.equal(settings.mode, 'whitelist');
      assert.deepEqual(settings.whitelist, ['*://localhost:3000/*', '*://localhost:5173/*']);
      assert.deepEqual(settings.policy, { overridesOff: true, trustedPages: ['*://localhost:3000/*'], everyWebsiteBlocked: true });

      // Switching on is refused while the policy keeps overrides off; the user's choice is kept for later.
      const updated = await controller.update({ enabled: true, mode: 'global' });
      assert.equal(updated.enabled, false);
      assert.equal(updated.mode, 'whitelist');
      assert.equal(stored.get('enabled'), true);
    } finally {
      managedPolicy = null;
    }
  });

  it('never stores the policy or the pages it trusts', async () => {
    stored.clear();
    managedPolicy = { trustedPages: ['localhost:3000'] };
    try {
      const controller = new SettingsController();
      const settings = await controller.initialize();
      await controller.update({ whitelist: [...settings.whitelist, '*://localhost:5173/*'] });

      assert.deepEqual(stored.get('whitelist'), ['*://localhost:5173/*']);
      assert.deepEqual(stored.get('corsDevControlSettings').whitelist, ['*://localhost:5173/*']);
      assert.equal('policy' in stored.get('corsDevControlSettings'), false);
      // Removing the policy's page is not possible: it is trusted again on the next load.
      const removed = await controller.update({ whitelist: [] });
      assert.deepEqual(removed.whitelist, ['*://localhost:3000/*']);
    } finally {
      managedPolicy = null;
    }

    // Once the administrator removes the policy, only the user's own pages remain.
    const controller = new SettingsController();
    assert.deepEqual((await controller.initialize()).whitelist, []);
  });

  it('treats an unreadable managed storage as no policy', async () => {
    managedPolicy = null;
    const controller = new SettingsController();
    assert.deepEqual((await controller.initialize()).policy, { overridesOff: false, trustedPages: [], everyWebsiteBlocked: false });
  });

  it('notifies subscribers when the policy changes', async () => {
    const controller = new SettingsController();
    const received = [];
    controller.subscribe((settings) => received.push(settings));
    await controller.initialize();

    managedPolicy = { disableOverrides: true };
    try {
      listeners.forEach((listener) => listener({ disableOverrides: { newValue: true } }, 'managed'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(received.at(-1).policy.overridesOff, true);
    } finally {
      managedPolicy = null;
    }
  });
});
