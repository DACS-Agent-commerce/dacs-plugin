// The embedded wallet ships exactly @kynesyslabs/demosdk 4.0.20, and the lock, the
// build entry, the runtime manifest, the package checks and the built bundle all
// say so. 4.0.20 is the SDK whose message signer refuses a transaction's signing
// preimage and whose transaction signer follows the node's signature-domain fork.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { RUNTIME_LABEL, RUNTIME_SDK, RUNTIME_SDK_LABEL } from '../scripts/embedded-wallet-runtime.mjs';

const VERSION = '4.0.20';
const INTEGRITY = 'sha512-8B4FrC8ZDvimnKaKQ2ZwBD6d+oGft9th/9BSQnrkHAQCvz4rVvJYXdZrT8JH2ylV+275WLzcXpmphA5m5qDQog==';
const url = (path) => new URL(path, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');
const json = (path) => JSON.parse(read(path));

test('wallet-build pins exactly demosdk 4.0.20', () => {
  assert.deepEqual(json('../wallet-build/package.json').dependencies, { '@kynesyslabs/demosdk': VERSION, esbuild: '0.25.12' });
  assert.match(read('../wallet-build/build.mjs'), /const EXPECTED = \{ '@kynesyslabs\/demosdk': '4\.0\.20', esbuild: '0\.25\.12' \}/);
});

test('the lock resolves demosdk 4.0.20 from the registry with its recorded integrity', () => {
  const lock = json('../wallet-build/package-lock.json');
  assert.equal(lock.packages[''].dependencies['@kynesyslabs/demosdk'], VERSION);
  const record = lock.packages['node_modules/@kynesyslabs/demosdk'];
  assert.equal(record.version, VERSION);
  assert.equal(record.resolved, `https://registry.npmjs.org/@kynesyslabs/demosdk/-/demosdk-${VERSION}.tgz`);
  assert.equal(record.integrity, INTEGRITY);
});

test('the build entry names 4.0.20', () => {
  const entry = read('../wallet-build/entry.mjs');
  assert.match(entry, /export const DEMOS_SDK_VERSION = '4\.0\.20';/);
  assert.match(entry, /export const RUNTIME_LABEL = 'upstream-demosdk-4\.0\.20-browser-bundle';/);
  assert.doesNotMatch(entry, /4\.0\.16/);
});

test('the runtime manifest names 4.0.20 and no other demosdk', () => {
  const manifest = json('../public/portal/embedded-wallet/runtime-manifest.json');
  assert.equal(manifest.sdk.version, VERSION);
  assert.equal(manifest.runtimeLabel, `upstream-demosdk-${VERSION}-browser-bundle`);
  for (const list of [manifest.shippedPackages, manifest.noticePackages]) {
    assert.deepEqual(list.filter((name) => name.startsWith('@kynesyslabs/demosdk@')), [`@kynesyslabs/demosdk@${VERSION}`]);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /4\.0\.16/);
});

test('the package checks name 4.0.20', () => {
  assert.deepEqual(RUNTIME_SDK, { name: '@kynesyslabs/demosdk', version: VERSION });
  assert.equal(RUNTIME_LABEL, `upstream-demosdk-${VERSION}-browser-bundle`);
  assert.equal(RUNTIME_SDK_LABEL, `unmodified upstream @kynesyslabs/demosdk ${VERSION}`);
  assert.match(read('../scripts/check-embedded-wallet-package.mjs'), /does not name the pinned upstream SDK 4\.0\.20/);
});

test('the shipped bundle names 4.0.20 in every file and exports it', async () => {
  const dir = url('../public/portal/embedded-wallet/');
  const files = ['demos-runtime.mjs', ...readdirSync(new URL('runtime-chunks/', dir)).map((name) => `runtime-chunks/${name}`)];
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), /demosdk[ @-]4\.0\.16|4\.0\.16, esbuild/, file);
  const text = readFileSync(new URL('demos-runtime.mjs', dir), 'utf8');
  assert.match(text.slice(0, 600), /unmodified upstream @kynesyslabs\/demosdk 4\.0\.20/);
  assert.match(text.slice(text.lastIndexOf('THIRD-PARTY NOTICES')), /@kynesyslabs\/demosdk@4\.0\.20 — license: MIT/);
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
  assert.equal(runtime.DEMOS_SDK_VERSION, VERSION);
  assert.equal(runtime.RUNTIME_LABEL, RUNTIME_LABEL);
});

test('the shipped bundle is SDK 4.0.20 in behaviour: its message signer refuses a transaction preimage unless asked raw', async () => {
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const { Demos } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
  const demos = new Demos();
  await demos.connectWallet(demos.newMnemonic(128), { algorithm: 'ed25519' });
  const hash = 'ab'.repeat(32);
  await assert.rejects(demos.signMessage(hash, { algorithm: 'ed25519' }), /transaction's signing preimage/);
  await assert.rejects(demos.signMessage(`demos-tx:v1:7:${hash}`, { algorithm: 'ed25519' }), /transaction's signing preimage/);
  assert.equal((await demos.signMessage(hash, { algorithm: 'ed25519', raw: true })).type, 'ed25519');
  assert.equal((await demos.signMessage('an ordinary message', { algorithm: 'ed25519' })).type, 'ed25519');
});
