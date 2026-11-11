// The extension probe checks a wallet's transaction signature in the form the
// configured node uses (its getNetworkInfo answer, read apart from the wallet):
// the bare hash while the signatureDomain fork is inactive, "demos-tx:v1:<chainId>:<hash>"
// once it is active; an answer that does not say which verifies nothing.
// Message checks stay exact-text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as checks from '../public/wallet-extension-probe/checks.mjs';
import { createExtensionProbeAdapter } from '../public/wallet-extension-probe/adapter.mjs';
import { nativeVector, storageVector, MESSAGE_VECTORS, PROBE_NONCE } from '../public/wallet-extension-probe/vectors.mjs';
import { fakeExtension, fakeWindow, signedTransaction, INACTIVE_NETWORK, ACTIVE_NETWORK } from './helpers/wallet-extension-probe-dom.mjs';
import { createSdkWallet } from './helpers/wallet-extension-probe-sdk.mjs';

const { checkSignedTransaction } = checks;
const wallet = await createSdkWallet();
const tx = () => nativeVector({ from: wallet.address, nonce: PROBE_NONCE, timestamp: 1234 });
const OTHER_CHAIN = { ...ACTIVE_NETWORK, chainId: 8 };
const hashOf = (signed) => signed.hash;

async function probe(provider, { readNetwork = async () => ACTIVE_NETWORK } = {}) {
  const adapter = createExtensionProbeAdapter({ windowObject: fakeWindow(provider), readAccount: async () => ({ currentNonce: 7, balanceOs: '1' }), readNetwork });
  await adapter.discover(); await adapter.connect();
  return adapter;
}
// The extension signs the exact requested transaction over the preimage `networkInfo` calls for.
const extension = (networkInfo) => fakeExtension({ wallet, signTransaction: (t) => ({ success: true, data: signedTransaction(wallet, t, undefined, networkInfo) }) });

test('active fork: a domain-aware extension\'s valid transaction signature is reported valid', async () => {
  const fake = extension(ACTIVE_NETWORK);
  const adapter = await probe(fake.provider);
  const record = await adapter.signTransaction(tx());
  assert.equal(record.signatureValid, true);
  assert.equal(record.hashValid, true);
  assert.equal(record.ok, true, JSON.stringify(record.diffs));
});

test('active fork: the real SDK 4.0.20 signature over demos-tx:v1:<chainId>:<hash> is reported valid', async () => {
  wallet.useNetworkInfo(ACTIVE_NETWORK);
  try {
    const requested = tx(), signed = await wallet.sdkSign(requested, true);
    assert.equal(wallet.signHex(`demos-tx:v1:7:${hashOf(signed)}`).slice(2), signed.signature.data.replace(/^0x/, ''), 'the SDK signed the domain form');
    const result = await checkSignedTransaction(requested, signed, wallet.address, ACTIVE_NETWORK);
    assert.equal(result.hashValid, true);
    assert.equal(result.signatureValid, true);
    assert.equal((await checkSignedTransaction(requested, signed, wallet.address, INACTIVE_NETWORK)).signatureValid, false);
  } finally { wallet.useNetworkInfo(INACTIVE_NETWORK); }
});

test('active fork: a signature over the bare hash is reported invalid', async () => {
  const adapter = await probe(extension(INACTIVE_NETWORK).provider);
  const record = await adapter.signTransaction(tx());
  assert.equal(record.signatureValid, false);
  assert.equal(record.ok, false);
});

test('active fork: a signature for another chain id is reported invalid', async () => {
  const adapter = await probe(extension(OTHER_CHAIN).provider);
  const record = await adapter.signTransaction(tx());
  assert.equal(record.signatureValid, false);
  assert.equal(record.ok, false);
});

test('inactive fork: the bare-hash control is reported valid, and the domain form is not', async () => {
  const bare = await (await probe(extension(INACTIVE_NETWORK).provider, { readNetwork: async () => INACTIVE_NETWORK })).signTransaction(tx());
  assert.equal(bare.signatureValid, true);
  assert.equal(bare.ok, true, JSON.stringify(bare.diffs));
  const domain = await (await probe(extension(ACTIVE_NETWORK).provider, { readNetwork: async () => INACTIVE_NETWORK })).signTransaction(tx());
  assert.equal(domain.signatureValid, false, 'no dual-form fallback');
});

const UNREADABLE = [
  ['null', null], ['undefined', undefined], ['a string', 'active'], ['an array', []], ['an empty object', {}],
  ['forks without the fork', { chainId: 7, forks: {} }], ['the fork is not an object', { chainId: 7, forks: { signatureDomain: true } }],
  ['the fork has no status', { chainId: 7, forks: { signatureDomain: {} } }],
  ['the status is a string', { chainId: 7, forks: { signatureDomain: { activated: 'true' } } }],
  ['the status is a number', { chainId: 7, forks: { signatureDomain: { activated: 1 } } }],
  ['active with no chain id', { forks: { signatureDomain: { activated: true } } }],
  ['active with a string chain id', { chainId: '7', forks: { signatureDomain: { activated: true } } }],
  ['active with a negative chain id', { chainId: -1, forks: { signatureDomain: { activated: true } } }],
  ['active with a fractional chain id', { chainId: 1.5, forks: { signatureDomain: { activated: true } } }],
  ['active with an unsafe chain id', { chainId: 2 ** 53, forks: { signatureDomain: { activated: true } } }],
  ['active with a NaN chain id', { chainId: NaN, forks: { signatureDomain: { activated: true } } }],
];
for (const [label, answer] of UNREADABLE) {
  test(`an unreadable network answer verifies nothing, whichever form was signed (${label})`, async () => {
    const requested = tx();
    for (const signedOver of [INACTIVE_NETWORK, ACTIVE_NETWORK]) {
      const signed = signedTransaction(wallet, requested, undefined, signedOver);
      const result = await checkSignedTransaction(requested, signed, wallet.address, answer);
      assert.equal(result.signatureValid, false);
      assert.equal(result.ok, false);
    }
    assert.equal(checks.txSignatureText(answer, 'a'.repeat(64)), null);
  });
}

test('the network answer is required: a check made without one verifies nothing', async () => {
  const requested = tx(), signed = signedTransaction(wallet, requested);
  assert.equal((await checkSignedTransaction(requested, signed, wallet.address)).signatureValid, false);
});

test('an unreadable network read stops the probe before the wallet is asked to sign', async () => {
  const fake = extension(ACTIVE_NETWORK);
  const adapter = await probe(fake.provider, { readNetwork: async () => { throw new Error('network_unavailable'); } });
  await assert.rejects(adapter.signTransaction(tx()), /network_unavailable/);
  assert.equal(fake.calls.some((c) => c.method === 'signTransaction'), false);
});

test('storage CREATE: the same rule applies', async () => {
  const requested = await storageVector({ from: wallet.address, nonce: PROBE_NONCE, timestamp: 1234 });
  const domain = signedTransaction(wallet, requested, undefined, ACTIVE_NETWORK), bare = signedTransaction(wallet, requested, undefined, INACTIVE_NETWORK);
  assert.equal((await checkSignedTransaction(requested, domain, wallet.address, ACTIVE_NETWORK)).signatureValid, true);
  assert.equal((await checkSignedTransaction(requested, bare, wallet.address, ACTIVE_NETWORK)).signatureValid, false);
  assert.equal((await checkSignedTransaction(requested, bare, wallet.address, INACTIVE_NETWORK)).signatureValid, true);
});

test('message checks stay exact-text on an active-fork chain', async () => {
  const fake = fakeExtension({ wallet });
  const adapter = await probe(fake.provider);
  for (const message of MESSAGE_VECTORS) {
    const record = await adapter.signMessage(message);
    assert.equal(record.ok, true, message);
    assert.equal(record.reason, 'exact-utf8-ed25519');
  }
  const domainText = fakeExtension({ wallet, signMessage: (m) => ({ success: true, data: { type: 'ed25519', data: wallet.signHex(`x${m}`) } }) });
  assert.equal((await (await probe(domainText.provider)).signMessage(MESSAGE_VECTORS[0])).ok, false, 'a signature over other text is still not the message');
});
