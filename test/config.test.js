'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, createMemoryFs, createIpc, userData } = require('./helpers/harness');

function setup({ initial = {}, env = {}, available = true, decryptError = false } = {}) {
  const mem = createMemoryFs(initial);
  const warnings = [];
  const storageCalls = [];
  const module = loadModule('modules/config.js', {
    requires: {
      fs: mem.fs,
      electron: {
        app: { getPath: (name) => { assert.equal(name, 'userData'); return userData; } },
        safeStorage: {
          isEncryptionAvailable: () => available,
          encryptString: (value) => {
            storageCalls.push(['encrypt', value]);
            return Buffer.from('encrypted:' + value);
          },
          decryptString: (value) => {
            storageCalls.push(['decrypt', value]);
            if (decryptError) throw new Error('Cannot decrypt');
            return value.toString().slice('encrypted:'.length);
          }
        }
      }
    },
    globals: { process: { env }, console: { warn: (...args) => warnings.push(args) } }
  });
  return { module, mem, warnings, storageCalls, file: path.join(userData, 'config.json') };
}

test('config: default path and environment override', () => {
  assert.equal(setup().module.configPath(), path.join(userData, 'config.json'));
  const override = path.join(userData, 'custom', 'settings.json');
  assert.equal(setup({ env: { CONFIG_PATH: override } }).module.configPath(), override);
});

for (const [name, contents] of [['missing', undefined], ['invalid JSON', '{not-json'], ['null JSON', 'null']]) {
  test('config: ' + name + ' returns all defaults', () => {
    const file = path.join(userData, 'config.json');
    const { module } = setup({ initial: contents === undefined ? {} : { [file]: contents } });
    const cfg = module.loadConfig();
    assert.deepEqual(cfg, {
      baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash',
      lastFolder: '', theme: { preset: 'aurora', custom: null }, aiComplete: true,
      permission: 'safe', keybindings: {}, fontSize: 14, tabSize: 2,
      autoSave: false, wordWrap: 'off', largeFileThreshold: 1048576, lockscreen: true
    });
  });
}

test('config: stored settings override defaults while retaining new defaults', () => {
  const file = path.join(userData, 'config.json');
  const { module } = setup({ initial: { [file]: JSON.stringify({ model: 'custom-model', fontSize: 18, extensionSetting: true }) } });
  const cfg = module.loadConfig();
  assert.equal(cfg.model, 'custom-model');
  assert.equal(cfg.fontSize, 18);
  assert.equal(cfg.extensionSetting, true);
  assert.equal(cfg.permission, 'safe');
  assert.equal(cfg.apiKey, '');
});

test('config: encrypted key round-trips without mutating the caller', () => {
  const { module, mem, file, storageCalls } = setup();
  const cfg = { apiKey: 'unit-secret', apiKeyEncrypted: 'stale-key', fontSize: 17 };
  const original = { ...cfg };
  module.saveConfig(cfg);
  const raw = JSON.parse(mem.content(file));
  assert.deepEqual(cfg, original);
  assert.equal(raw.apiKey, undefined);
  assert.equal(raw.apiKeyEncrypted, Buffer.from('encrypted:unit-secret').toString('base64'));
  assert.equal(raw.fontSize, 17);
  assert.equal(module.loadConfig().apiKey, 'unit-secret');
  assert.equal(storageCalls[0][0], 'encrypt');
  assert.equal(storageCalls[1][0], 'decrypt');
});

test('config: saving a legacy plaintext configuration migrates its key', () => {
  const file = path.join(userData, 'config.json');
  const { module, mem } = setup({ initial: { [file]: JSON.stringify({ apiKey: 'legacy-key', model: 'legacy-model' }) } });
  const cfg = module.loadConfig();
  assert.equal(cfg.apiKey, 'legacy-key');
  module.saveConfig(cfg);
  const raw = JSON.parse(mem.content(file));
  assert.equal(raw.apiKey, undefined);
  assert.equal(raw.apiKeyEncrypted, Buffer.from('encrypted:legacy-key').toString('base64'));
});

test('config: legacy plaintext takes precedence over a stale encrypted key', () => {
  const file = path.join(userData, 'config.json');
  const { module, storageCalls } = setup({ initial: { [file]: JSON.stringify({ apiKey: 'plaintext', apiKeyEncrypted: 'stale' }) } });
  assert.equal(module.loadConfig().apiKey, 'plaintext');
  assert.equal(storageCalls.length, 0);
});

for (const options of [{ available: false }, { decryptError: true }]) {
  test('config: unreadable encrypted key returns an empty key ' + JSON.stringify(options), () => {
    const file = path.join(userData, 'config.json');
    const { module } = setup({ ...options, initial: { [file]: JSON.stringify({ apiKeyEncrypted: 'a2V5', model: 'saved' }) } });
    assert.equal(module.loadConfig().apiKey, '');
    assert.equal(module.loadConfig().model, 'saved');
  });
}

test('config: unavailable encryption uses the documented fallback and warns', () => {
  const { module, mem, file, warnings, storageCalls } = setup({ available: false });
  module.saveConfig({ apiKey: 'fallback-key', apiKeyEncrypted: 'stale' });
  assert.deepEqual(JSON.parse(mem.content(file)), { apiKey: 'fallback-key' });
  assert.equal(warnings.length, 1);
  assert.equal(storageCalls.length, 0);
  assert.equal(module.loadConfig().apiKey, 'fallback-key');
});

test('config: clearing a key removes both persisted representations', () => {
  const { module, mem, file } = setup();
  module.saveConfig({ apiKey: '', apiKeyEncrypted: 'old', model: 'saved' });
  assert.deepEqual(JSON.parse(mem.content(file)), { model: 'saved' });
  assert.equal(module.loadConfig().apiKey, '');
});

test('config: IPC partial updates preserve existing settings and persist changes', () => {
  const { module, mem, file } = setup();
  module.saveConfig({ apiKey: 'unit-key', model: 'existing', fontSize: 15 });
  const ipc = createIpc();
  module.registerConfig(ipc);
  const cfg = ipc.invoke('config:set', { tabSize: 4 });
  assert.equal(cfg.model, 'existing');
  assert.equal(cfg.apiKey, 'unit-key');
  assert.equal(cfg.tabSize, 4);
  assert.deepEqual(ipc.invoke('config:get'), cfg);
  assert.equal(JSON.parse(mem.content(file)).apiKey, undefined);
});

test('config: mkdir and write failures propagate to the caller', () => {
  for (const method of ['mkdirSync', 'writeFileSync']) {
    const { module, mem } = setup();
    mem.fs[method] = () => { throw new Error('disk unavailable'); };
    assert.throws(() => module.saveConfig({ apiKey: '' }), /disk unavailable/);
  }
});
