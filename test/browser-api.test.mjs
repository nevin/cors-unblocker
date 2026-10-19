import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const stored = new Map();
const sessionStored = new Map();
const listeners = [];
const setCalls = [];

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
      callRules: []
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

