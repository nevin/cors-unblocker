import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const stored = new Map();
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
    }
  },
  onChanged: {
    addListener(listener) {
      listeners.push(listener);
    }
  }
};

globalThis.chrome = { storage };
const { SettingsController } = await import('../dist-test/shared/browserApi.js');

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
      domainRules: []
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
