// Ordinary message signing stays separate from transaction signing: `sign`
// refuses a transaction hash and any "demos-tx:v1:" string before consent, while
// the wallet's own RPC-auth digest still signs through a module-private path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as providerModule from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { renderChallengeMessage, PURPOSES } from '../src/wallet/challenges.mjs';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';

const { createSdkWalletSession, createDevnetNativeWalletTransport } = providerModule;
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/' };
globalThis.location = new URL('http://127.0.0.1/');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const HASH = createHash('sha256').update('a transaction body').digest('hex');
const PAYEE = `0x${'71'.repeat(32)}`;

async function setup(extra = {}) {
  const signed = [];
  class SpyDemos extends Demos {
    async signMessage(message, options) {
      signed.push(message);
      return super.signMessage(message, options);
    }
  }
  const approvals = [];
  const wallet = createSdkWalletSession({
    DemosCtor: SpyDemos, IdentitiesCtor: Identities, validateMnemonic,
    approve: async (request) => { approvals.push(request); return true; },
    ...extra,
  });
  const { address } = await wallet.create();
  return { wallet, signed, approvals, address };
}

const refusal = (res) => { assert.equal(res.success, false); assert.equal(res.error.code, 'transaction_preimage_refused'); };

for (const [label, message] of [
  ['bare lowercase hash', HASH],
  ['0x-prefixed hash', `0x${HASH}`],
  ['uppercase hash', HASH.toUpperCase()],
  ['0x-prefixed uppercase hash', `0x${HASH.toUpperCase()}`],
  ['mixed-case hash', HASH.slice(0, 20).toUpperCase() + HASH.slice(20)],
]) {
  test(`sign refuses a transaction hash before consent: ${label}`, async (t) => {
    const { wallet, signed, approvals } = await setup();
    t.after(() => wallet.lock());
    refusal(await wallet.request({ method: 'sign', params: [message] }));
    assert.equal(approvals.length, 0);
    assert.equal(signed.length, 0);
  });
}

for (const [label, message] of [
  ['domain string with chain id', `demos-tx:v1:7:${HASH}`],
  ['domain string with 0x hash and big chain id', `demos-tx:v1:9007199254740991:0x${HASH}`],
  ['bare prefix', 'demos-tx:v1:'],
  ['malformed after the prefix', 'demos-tx:v1:not a hash at all'],
]) {
  test(`sign refuses the demos-tx:v1: prefix before consent: ${label}`, async (t) => {
    const { wallet, signed, approvals } = await setup();
    t.after(() => wallet.lock());
    refusal(await wallet.request({ method: 'sign', params: [message] }));
    assert.equal(approvals.length, 0);
    assert.equal(signed.length, 0);
  });
}

test('ordinary messages still sign after exact approval: DACS agreement, portal challenge, and text that merely holds a hash', async (t) => {
  const { wallet, signed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  const messages = [
    `dacs-payee-bound-agreement:v1:${HASH}`,
    `dacs-evidence:v1:${HASH}`,
    renderChallengeMessage({
      origin: 'https://plugin.example.test', purpose: PURPOSES.LOGIN, address, binding: { account: 'acct_fixture' },
      nonce: 'fixture-nonce', issuedAt: '2026-10-03T00:00:00.000Z', expiresAt: '2026-10-03T00:05:00.000Z',
    }),
    `please sign ${HASH}`,
    `${HASH} and more`,
    `${HASH}\n`,
    ` ${HASH}`,
    HASH.slice(1),
    `${HASH}0`,
    `0x${HASH}0`,
    `x demos-tx:v1:7:${HASH}`,
  ];
  for (const message of messages) {
    const res = await wallet.request({ method: 'sign', params: [message] });
    assert.equal(res.success, true, message);
    assert.equal(verifyDemosSignature({ address, message, signature: res.data.signature }), true);
  }
  assert.deepEqual(signed, messages);
  assert.deepEqual(approvals.map((a) => a.message), messages);
});

test('RPC authentication still signs its digest; the digest itself is refused as a page message', async (t) => {
  const { wallet, signed, approvals, address } = await setup({
    transactionTransport: createDevnetNativeWalletTransport({ profile: 'devnet-native', network: 'devnet-test', rpcUrl: 'http://127.0.0.1/portal/api/devnet-native-wallet-rpc', bindingUrl: 'http://127.0.0.1/portal/api/devnet-native-wallet-binding' }),
  });
  t.after(() => wallet.lock());
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: false, json: async () => ({ error: 'network_binding_unavailable' }) }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const tx = { content: { type: 'native', from: address, to: PAYEE, amount: '2500000000', nonce: 1, data: ['native', { nativeOperation: 'send', args: [PAYEE, '2500000000'] }] } };
  const res = await wallet.request({ method: 'sendTransaction', params: [tx] });
  assert.equal(res.success, false);
  assert.equal(calls.length, 1);
  const headers = calls[0].init.headers;
  assert.equal(headers.identity, `ed25519:${address}`);
  const digest = createHash('sha256').update(`ed25519:${address}:${headers.timestamp}`).digest('hex');
  assert.deepEqual(signed, [digest]);
  assert.match(headers.signature, /^[0-9a-f]{128}$/);
  assert.equal(verifyDemosSignature({ address, message: digest, signature: headers.signature }), true);
  assert.equal(approvals.length, 0);
  // The same digest, asked for by a page, is a 64-hex string: refused.
  refusal(await wallet.request({ method: 'sign', params: [digest] }));
  assert.deepEqual(signed, [digest]);
  assert.equal(approvals.length, 0);
});

test('no page request method or exported name reaches the internal RPC-auth signer', async (t) => {
  const { wallet, signed, approvals } = await setup();
  t.after(() => wallet.lock());
  const surface = [...Object.keys(providerModule), ...Object.keys(wallet)];
  assert.deepEqual(surface.filter((name) => /sign|auth/i.test(name)), []);
  for (const method of ['signRpcAuthDigest', 'sourceAuthHeaders', 'signMessage', 'signRpcAuth', 'rpcAuth', 'sha256HexOfText']) {
    for (const params of [undefined, [HASH], [{ address: '0x', timestamp: '1' }], ['0x', '1']]) {
      const res = await wallet.request({ method, params });
      assert.equal(res.success, false, method);
      assert.equal(res.error.code, 'unsupported', method);
    }
  }
  assert.equal(signed.length, 0);
  assert.equal(approvals.length, 0);
});
