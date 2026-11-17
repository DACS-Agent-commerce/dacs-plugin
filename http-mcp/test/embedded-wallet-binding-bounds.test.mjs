// Embedded wallet: every call to the same-origin network binding endpoint has
// a deadline and a byte cap, and fails with network_binding_unavailable when
// either is passed. Offline: the binding endpoint is an in-process fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkWalletSession, createDevnetNativeWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';

globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/' };
globalThis.location = new URL('http://127.0.0.1/');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const PAYEE = `0x${'71'.repeat(32)}`;
const AMOUNT_OS = '2000000000';
const NATIVE_RPC_URL = 'http://127.0.0.1/portal/api/devnet-native-wallet-rpc';
const BINDING_URL = 'http://127.0.0.1/portal/api/devnet-native-wallet-binding';
const BINDING_DEADLINE_MS = 10_000;
const BINDING_MAX_BYTES = 262_144;
const CHUNK_BYTES = 65_536;

function nativeSend(from) {
  return { content: { type: 'native', from, to: PAYEE, amount: AMOUNT_OS, nonce: 1, data: ['native', { nativeOperation: 'send', args: [PAYEE, AMOUNT_OS] }] } };
}

async function unlockedNativeWallet(t) {
  const wallet = createSdkWalletSession({
    DemosCtor: Demos,
    IdentitiesCtor: Identities,
    validateMnemonic,
    approve: async () => true,
    transactionTransport: createDevnetNativeWalletTransport({ profile: 'devnet-native', network: 'devnet-test', rpcUrl: NATIVE_RPC_URL, bindingUrl: BINDING_URL }),
  });
  await wallet.create();
  t.after(() => wallet.lock());
  return wallet;
}

function replaceFetch(t, replacement) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  t.after(() => { globalThis.fetch = original; });
}

const jsonReply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const readback = (wallet) => wallet.request({ method: 'readNativeTransfer', params: [{ hash: 'ab'.repeat(32) }] });
const settleOrPending = (promise) => Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve('pending')))]);

test('a readback reply larger than the byte cap is refused as network_binding_unavailable', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  replaceFetch(t, async () => jsonReply({ disposition: 'pending', padding: 'p'.repeat(BINDING_MAX_BYTES) }));
  const res = await readback(wallet);
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'network_binding_unavailable');
});

test('a binding reply is no longer read once the byte cap is passed', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  let pulls = 0;
  let cancelled = false;
  const longReply = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 128) controller.close();
      else controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));
    },
    cancel() { cancelled = true; },
  });
  replaceFetch(t, async () => new Response(longReply, { status: 200 }));
  const res = await settleOrPending(readback(wallet));
  assert.notEqual(res, 'pending');
  assert.equal(res.error.code, 'network_binding_unavailable');
  assert.equal(cancelled, true);
  assert.ok(pulls <= BINDING_MAX_BYTES / CHUNK_BYTES + 2, `${pulls} chunks were read`);
});

test('a binding call that never answers is cut at the deadline as network_binding_unavailable', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  let signal;
  let called;
  const fetchCalled = new Promise((resolve) => { called = resolve; });
  replaceFetch(t, (url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
    called();
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readback(wallet);
  await fetchCalled;
  t.mock.timers.tick(BINDING_DEADLINE_MS);
  const res = await settleOrPending(pending);
  assert.notEqual(res, 'pending');
  assert.equal(res.error.code, 'network_binding_unavailable');
  assert.ok(signal instanceof AbortSignal);
});

test('a binding reply that stalls after its headers is cut at the deadline as network_binding_unavailable', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  let called;
  const fetchCalled = new Promise((resolve) => { called = resolve; });
  replaceFetch(t, async (url, init) => {
    const stalled = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal.reason));
        called();
      },
    });
    return new Response(stalled, { status: 200 });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readback(wallet);
  await fetchCalled;
  t.mock.timers.tick(BINDING_DEADLINE_MS);
  const res = await settleOrPending(pending);
  assert.notEqual(res, 'pending');
  assert.equal(res.error.code, 'network_binding_unavailable');
});

test('the bind call of a native send is bounded by the same byte cap', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  const binding = { bindingVersion: 'dacs-demos-network-binding/v1', network: 'devnet-test', chainIdentity: 'c'.repeat(64) };
  replaceFetch(t, async () => jsonReply({ binding, padding: 'p'.repeat(BINDING_MAX_BYTES) }));
  const res = await wallet.request({ method: 'sendTransaction', params: [nativeSend(wallet.getPublicAccount().address)] });
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'network_binding_unavailable');
});

test('a readback reply under the byte cap is returned unchanged', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  replaceFetch(t, async () => jsonReply({ disposition: 'pending' }));
  const res = await readback(wallet);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(res.data, { disposition: 'pending' });
});

test('a binding refusal under the byte cap keeps its own error code', async (t) => {
  const wallet = await unlockedNativeWallet(t);
  replaceFetch(t, async () => new Response(JSON.stringify({ error: 'wallet_auth_stale' }), { status: 409, headers: { 'content-type': 'application/json' } }));
  const res = await wallet.request({ method: 'sendTransaction', params: [nativeSend(wallet.getPublicAccount().address)] });
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'wallet_auth_stale');
});
