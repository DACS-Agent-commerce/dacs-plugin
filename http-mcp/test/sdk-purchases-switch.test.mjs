// DACS_SDK_PURCHASES (src/switches/DACS_SDK_PURCHASES.switch): the plugin's own purchase switch is an off/on enum that is off by default and in a deployment.
// loadConfig refuses `on` unless the chain RPC is a remote https node, every named SDK purchase part is in the client namespace, and the switch-on path is validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as installedClient from '@kynesyslabs/dacs-client';
import { ConfigError, SWITCHES, loadConfig } from '../src/config.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const remoteChain = { DACS_CHAIN_RPC_URL: 'https://node.chain.invalid' };
const on = { ...base, ...remoteChain, DACS_SDK_PURCHASES: 'on' };
const entry = () => SWITCHES.find((s) => s.env === 'DACS_SDK_PURCHASES');
const refusedWith = (code, message) => (error) => error instanceof ConfigError && error.code === code && error.message === message;
const RECORDER_MISSING = 'sdk_part_missing: P19r createPurchaseEvidenceRecorder';
// An inert stand-in for the recorder factory: requireSdkPurchaseParts only looks the name up.
const inertRecorderFactory = () => { throw new Error('a placeholder is never called'); };

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
  assert.throws(() => loadConfig(on), (error) => error instanceof ConfigError && error.message !== 'DACS_SDK_PURCHASES must be off or on', 'on is a known value, refused later by its own rules');
  for (const value of ['1', 'true', '', 'ON', ' on']) {
    assert.throws(() => loadConfig({ ...base, DACS_SDK_PURCHASES: value }), (error) => error instanceof ConfigError && error.message === 'DACS_SDK_PURCHASES must be off or on', JSON.stringify(value));
  }
});

test('loadConfig with the evidence recorder absent refuses DACS_SDK_PURCHASES=on with sdk_part_missing naming its part, the installed namespace refuses the same way, with every named part present it refuses switch_on_not_validated, and off is accepted', () => {
  const withoutRecorder = { ...installedClient };
  delete withoutRecorder.createPurchaseEvidenceRecorder;
  assert.throws(() => loadConfig(on, { clientNamespace: withoutRecorder }), refusedWith('sdk_part_missing', RECORDER_MISSING));
  assert.equal(typeof installedClient.createPurchaseEvidenceRecorder, 'undefined', 'the installed client has no evidence recorder yet');
  assert.throws(() => loadConfig(on), refusedWith('sdk_part_missing', RECORDER_MISSING));
  const allNamed = { ...installedClient, createPurchaseEvidenceRecorder: inertRecorderFactory };
  assert.throws(() => loadConfig(on, { clientNamespace: allNamed }), (error) => error instanceof ConfigError && error.code === 'switch_on_not_validated' && error.message.startsWith('switch_on_not_validated: '));
  for (const clientNamespace of [withoutRecorder, allNamed, undefined]) {
    assert.equal(loadConfig({ ...base, ...remoteChain }, { clientNamespace }).sdkPurchases, 'off');
  }
});

test('with DACS_SDK_PURCHASES=on the chain RPC must be https and not loopback, checked before the SDK parts', () => {
  const allNamed = { ...installedClient, createPurchaseEvidenceRecorder: inertRecorderFactory };
  const message = 'DACS_SDK_PURCHASES=on requires an https, non-loopback DACS_CHAIN_RPC_URL';
  for (const chain of [{}, { DACS_CHAIN_RPC_URL: 'https://127.0.0.1:8443' }, { DACS_CHAIN_RPC_URL: 'https://localhost' }, { DACS_CHAIN_RPC_URL: 'http://localhost:9', DACS_ALLOW_INSECURE_LOCALHOST: '1' }]) {
    const env = { ...base, ...chain, DACS_SDK_PURCHASES: 'on' };
    assert.throws(() => loadConfig(env, { clientNamespace: allNamed }), (error) => error instanceof ConfigError && error.message === message, JSON.stringify(chain));
    assert.equal(loadConfig({ ...env, DACS_SDK_PURCHASES: 'off' }).sdkPurchases, 'off', 'off keeps any chain RPC the other settings allow');
  }
});

test('the configuration carries no chain identity of its own, whatever the environment says', () => {
  const config = loadConfig({ ...base, ...remoteChain, DACS_CHAIN_NETWORK: 'demos-testnet', DACS_CHAIN_PINNED_IDENTITY: 'ab'.repeat(32) });
  assert.deepEqual(Object.keys(config.chain).sort(), ['network', 'rpcUrl', 'timeoutMs']);
  assert.ok(!JSON.stringify(config).includes('ab'.repeat(32)));
});
