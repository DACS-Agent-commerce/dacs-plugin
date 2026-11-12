// DACS_SDK_PURCHASES (src/switches/DACS_SDK_PURCHASES.switch): the plugin's own purchase switch is an off/on enum that is off by default and in a deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, SWITCHES, loadConfig } from '../src/config.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const entry = () => SWITCHES.find((s) => s.env === 'DACS_SDK_PURCHASES');

test('DACS_SDK_PURCHASES is off by default and its deploy value is off', () => {
  const s = entry();
  assert.ok(s, 'the switch file exists');
  assert.equal(s.kind, 'enum');
  assert.deepEqual([...s.values], ['off', 'on']);
  assert.equal(s.default, 'off');
  assert.equal(s.deployValue, 'off');
  assert.equal(s.configKey, 'sdkPurchases');
  assert.deepEqual(s.held, {}, 'on is a deploy setting, not a held value');
  assert.equal(loadConfig(base).sdkPurchases, 'off');
  assert.equal(loadConfig({ ...base, DACS_SDK_PURCHASES: 'off' }).sdkPurchases, 'off');
});

test('DACS_SDK_PURCHASES accepts only off or on, and 1, true and the empty string are refused by loadConfig', () => {
  assert.equal(loadConfig({ ...base, DACS_SDK_PURCHASES: 'on' }).sdkPurchases, 'on');
  for (const value of ['1', 'true', '', 'ON', ' on']) {
    assert.throws(() => loadConfig({ ...base, DACS_SDK_PURCHASES: value }), (error) => error instanceof ConfigError && error.message === 'DACS_SDK_PURCHASES must be off or on', JSON.stringify(value));
  }
});
