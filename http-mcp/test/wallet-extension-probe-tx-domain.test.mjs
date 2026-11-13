// The extension probe checks a wallet's transaction signature in the form the
// configured node uses (its getNetworkInfo answer, read apart from the wallet):
// the bare hash while the signatureDomain fork is inactive, "demos-tx:v1:<chainId>:<hash>"
// once it is active; an answer that does not say which verifies nothing.
// Message checks stay exact-text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createWalletExtensionProbeRouter } from '../src/portal/wallet-extension-probe.mjs';
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
  ['null', null], ['undefined', undefined], ['a string', 'active'], ['an array', []], ['forks is true', { chainId: 7, forks: true }], ['forks is an array', { chainId: 7, forks: [] }],
  ['the fork is not an object', { chainId: 7, forks: { signatureDomain: true } }],
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

for (const [label, answer] of UNREADABLE) {
  test(`a malformed network answer stops the probe before the wallet is asked to sign (${label})`, async () => {
    const fake = extension(ACTIVE_NETWORK);
    const adapter = await probe(fake.provider, { readNetwork: async () => answer });
    await assert.rejects(adapter.signTransaction(tx()), /network_unavailable/);
    assert.equal(fake.calls.some((c) => c.method === 'signTransaction'), false);
  });
}

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

// The page reads the node's answer through the probe's own route, owner only.
async function network(chain, headers = { authorization: 'Bearer owner' }, route = '/network') {
  const owner = { id: 'acct_owner', auth_issuer: 'issuer', auth_subject: 'subject' };
  const router = createWalletExtensionProbeRouter({ chain, logger: { warn() {} }, config: { walletExtensionProbe: true, authMode: 'builtin', walletExtensionProbeOwnerAccount: owner.id, builtinIssuer: 'issuer' },
    accounts: { getAccount: () => owner, walletOwner: () => owner.id }, authServer: null,
    authenticateBearer: async (value) => { if (value !== 'Bearer owner') throw new Error('refused'); return { extra: { issuer: owner.auth_issuer, subject: owner.auth_subject } }; } });
  const app = express(); app.use(router); app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  const server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers });
    return route.endsWith('.mjs') && res.ok ? [res.status, await res.text(), res.headers.get('content-type')] : [res.status, await res.json()];
  } finally { await new Promise((done) => { server.close(done); server.closeAllConnections(); }); }
}

test('the probe\'s network route returns the configured node\'s answer to the owner, and refuses when it has none', async () => {
  assert.deepEqual(await network({ getNetworkInfo: async () => ACTIVE_NETWORK }), [200, ACTIVE_NETWORK]);
  assert.deepEqual(await network({ getNetworkInfo: async () => INACTIVE_NETWORK }), [200, INACTIVE_NETWORK]);
  for (const chain of [{}, { getNetworkInfo: async () => null }, { getNetworkInfo: async () => 'down' }, { getNetworkInfo: async () => [] }, { getNetworkInfo: async () => { throw new Error('down'); } }]) {
    assert.deepEqual(await network(chain), [500, { error: 'network_unavailable' }]);
  }
  assert.deepEqual(await network({ getNetworkInfo: async () => ACTIVE_NETWORK }, {}), [404, { error: 'not_found' }]);
  assert.deepEqual(await network({ getNetworkInfo: async () => ACTIVE_NETWORK }, { authorization: 'Bearer someone-else' }), [404, { error: 'not_found' }]);
});

import { transactionDomainCases } from './helpers/transaction-domain-cases.mjs';
transactionDomainCases('probe checks', async () => {
  const seen = new Set();
  return async (answer, form) => {
    const requested = tx();
    const signedFor = { chainId: answer.chainId, forks: { signatureDomain: { activated: form === 'domain' } } };
    const signed = signedTransaction(wallet, requested, undefined, signedFor);
    const result = await checkSignedTransaction(requested, signed, wallet.address, answer, seen);
    const text = checks.txSignatureText(answer, signed.hash, seen);
    assert.ok(seen.size <= 16, 'bounded session record');
    return text === null ? 'unavailable' : result.signatureValid ? 'valid' : 'invalid';
  };
});

for (const [label, later] of [['missing', { chainId: 1, forks: {} }], ['false', { chainId: 1, forks: { signatureDomain: { activated: false } } }], ['no forks member', { chainId: 1 }]]) {
  test(`probe adapter session: active chain 1 then ${label} refuses before the wallet is asked`, async () => {
    let answer = { chainId: 1, forks: { signatureDomain: { activated: true } } };
    const fake = fakeExtension({ wallet, signTransaction: (requested) => ({ success: true, data: signedTransaction(wallet, requested, undefined,
      { chainId: 1, forks: { signatureDomain: { activated: answer.forks?.signatureDomain?.activated === true } } }) }) });
    const adapter = await probe(fake.provider, { readNetwork: async () => answer });
    assert.equal((await adapter.signTransaction(tx())).signatureValid, true);
    answer = later;
    await assert.rejects(adapter.signTransaction(tx()), /network_unavailable/);
    assert.equal(fake.calls.filter((c) => c.method === 'signTransaction').length, 1, 'the wallet was asked once, for the first answer');
  });
}

test('probe adapter session: an answer with no forks member selects the bare hash', async () => {
  const none = { chainId: 7 };
  const fake = fakeExtension({ wallet, signTransaction: (requested) => ({ success: true, data: signedTransaction(wallet, requested, undefined, INACTIVE_NETWORK) }) });
  const result = await (await probe(fake.provider, { readNetwork: async () => none })).signTransaction(tx());
  assert.equal(result.signatureValid, true);
});

test('probe serves the shared transaction rule as a browser module through its asset route', async () => {
  const route = '/assets/tx-signature.mjs';
  const [status, source, contentType] = await network({}, { authorization: 'Bearer owner' }, route);
  assert.equal(status, 200);
  assert.match(contentType, /javascript/);
  const { txSignatureText } = await import('data:text/javascript,' + encodeURIComponent(source));
  const seen = new Set();
  assert.equal(txSignatureText({ chainId: 1, forks: {} }, 'hash', seen), 'hash');
  assert.equal(txSignatureText({ chainId: 1, forks: { signatureDomain: { activated: true } } }, 'hash', seen), 'demos-tx:v1:1:hash');
  assert.equal(txSignatureText({ chainId: 1, forks: {} }, 'hash', seen), null);
  assert.deepEqual(await network({}, {}, route), [404, { error: 'not_found' }]);
});
