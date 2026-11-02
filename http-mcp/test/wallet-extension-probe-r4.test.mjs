import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { readFileSync } from 'node:fs';
import { checkSignedTransaction } from '../public/wallet-extension-probe/checks.mjs';
import { nativeVector, storageVector } from '../public/wallet-extension-probe/vectors.mjs';
import { createWalletExtensionProbeRouter } from '../src/portal/wallet-extension-probe.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { signedTransaction, installProbeDom } from './helpers/wallet-extension-probe-dom.mjs';
import { createSdkWallet, honestSdk } from './helpers/wallet-extension-probe-sdk.mjs';

const wallet = await createSdkWallet(), other = createEphemeralWallet();
const native = () => nativeVector({ from: wallet.address, nonce: 1, timestamp: 1234 });
const storage = () => storageVector({ from: wallet.address, nonce: 1, timestamp: 1234 });
// Real bundled SDK output in the given fork mode, then the mutation.
const check = async (tx, mutate, postFork) => {
  const sdk = await honestSdk(wallet, tx, postFork);
  return checkSignedTransaction(tx, signedTransaction(wallet, tx, (s) => { sdk(s); mutate(s.content.gcr_edits, s, postFork); }), wallet.address);
};
// Fee values in the profile's own form, so only the edits differ.
const fee = (dem, postFork) => postFork ? `${dem}000000000` : dem;

// Arbitrary edit payloads, inverted into regressions.
const badEdits = [
  ['unknown type', (e) => { e[0].type = 'identity'; }],
  ['debit account', (e) => { e[0].account = other.address; }],
  ['native credit account', (e) => { e[1].account = other.address; }, native],
  ['storage sender', (e) => { e[1].context.sender = other.address; }, storage],
  ['native debit amount', (e) => { e[0].amount = '10000000000'; }, native],
  ['native credit amount', (e) => { e[1].amount = '10000000000'; }, native],
  ['nonce amount', (e) => { e[3].amount = 5; }],
  ['storage target', (e) => { e[1].target = 'stor-evil'; }, storage],
  ['storage payload', (e) => { e[1].context.data.variables.data.statement = 'arbitrary payload'; }, storage],
  ['storage metadata', (e) => { e[1].context.data.metadata.contentHash = 'f'.repeat(64); }, storage],
  ['storage operation', (e) => { e[1].context.operation = 'WRITE_STORAGE'; }, storage],
  ['storage fee', (e) => { e[0].amount = 10; }, storage],
  ['gas amount', (e) => { e[2].amount = 10; }],
  ['rollback', (e) => { e[0].isRollback = true; }],
  ['operation', (e) => { e[0].operation = 'add'; }],
  ['txhash', (e) => { e[0].txhash = {}; }],
  ['extra property', (e) => { e[0].arbitrary = 1; }],
  ['missing edit', (e) => { e.pop(); }],
  ['extra debit', (e) => { e.push(structuredClone(e[0])); }],
  ['ordering', (e) => { e.reverse(); }],
  ['non-array', (_e, s) => { s.content.gcr_edits = {}; }],
  ['combined transfer, nonce and fee attack', (_e, s, postFork) => { s.content.gcr_edits = [
    { type: 'balance', operation: 'remove', account: wallet.address, amount: '10000000000', txhash: '', isRollback: false },
    { type: 'balance', operation: 'add', account: other.address, amount: '10000000000', txhash: '', isRollback: false },
    { type: 'nonce', operation: 'add', account: wallet.address, amount: 5, txhash: '', isRollback: false }]; s.content.transaction_fee.network_fee = fee(9, postFork); }],
  ['combined transfer, storage and fee attack', (_e, s, postFork) => { s.content.gcr_edits = [
    { type: 'balance', operation: 'remove', account: wallet.address, amount: '10000000000', txhash: '', isRollback: false },
    { type: 'balance', operation: 'add', account: other.address, amount: '10000000000', txhash: '', isRollback: false },
    { type: 'storageProgram', target: 'stor-evil', context: { data: { variables: { arbitrary: 'payload' } } }, txhash: '', isRollback: false }]; s.content.transaction_fee = { network_fee: fee(9, postFork), rpc_fee: fee(9, postFork), additional_fee: postFork ? '0' : 0, rpc_address: null }; }],
];
for (const [name, mutate, vector] of badEdits) test(`GCR rejects ${name} as unexpected`, async () => {
  for (const tx of vector ? [await vector()] : [native(), await storage()]) {
    // Pre-fork P4 is never SDK-expected (the SDK truncates its one OS), so it
    // has no honest baseline to mutate.
    for (const postFork of tx.content.type === 'native' ? [true] : [false, true]) {
      const honest = await check(tx, () => {}, postFork);
      assert.equal(honest.diffSummary.reading, 'sdk-expected-only');
      const r = await check(tx, mutate, postFork);
      assert.equal(r.hashValid, true); assert.equal(r.signatureValid, true); assert.equal(r.ok, false);
      assert.equal(r.diffSummary.reading, 'other-unexpected-diffs'); assert.equal(r.diffSummary.unexpected, 1);
    }
  }
});

const parents = [
  ['native args object', native, (s) => { s.content.data[1].args = { 0: other.address, 1: '1' }; }, [false, true, false]],
  ['native operation array', native, (s) => { s.content.data[1] = ['send', other.address, '1']; }, [false, true, false]],
  ['native data string', native, (s) => { s.content.data = 'native:send:' + other.address; }, [false, true, false]],
  ['storage operation array', storage, (s) => { s.content.data[1] = ['CREATE_STORAGE_PROGRAM', 'stor-' + '1'.repeat(40)]; }, [false, true, false]],
  ['content array', native, (s) => { s.content = []; }, [true, true, true]],
  ['envelope array', native, () => {}, [true, true, true]],
];
for (const [name, vector, mutate, flags] of parents) test(`sensitive parent replacement: ${name}`, async () => {
  const tx = await vector();
  const sdk = await honestSdk(wallet, tx, true);
  let s = signedTransaction(wallet, tx, (s) => { sdk(s); mutate(s); });
  if (name === 'envelope array') s = [];
  const r = await checkSignedTransaction(tx, s, wallet.address);
  assert.equal(r.diffSummary.reading, 'nonce-recipient-or-signer-changed');
  assert.deepEqual([r.diffSummary.nonceChanged, r.diffSummary.recipientChanged, r.diffSummary.signerChanged], flags);
});

test('the honest SDK page reading states the fee bound', async () => {
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    const result = await check(native(), (_e, s) => { s.content.transaction_fee.network_fee = fee(9, true); }, true);
    mountProbe(dom.root, { adapter: { report: () => ({}), connect: async () => ({ address: wallet.address }), signTransaction: async () => result } });
    await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
    dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
    await dom.button('P4 Sign native transfer only').click();
    assert.match(dom.nodes().find((n) => n.attributes.role === 'status').textContent, /fee values.*not.*bounded beyond the 10 DEM.*cap/i);
  } finally { dom.restore(); }
});

test('probe docs and vector comment preserve both residuals and separate SDK changes', () => {
  const docs = readFileSync(new URL('../docs/WALLET-EXTENSION-PROBE.md', import.meta.url), 'utf8');
  const vectors = readFileSync(new URL('../public/wallet-extension-probe/vectors.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /Every field difference is a finding, including fees/);
  assert.doesNotMatch(vectors, /can at most produce a one-OS self-transfer/);
  assert.match(vectors, /P4.*self-transfer plus fees/);
  assert.match(vectors, /P5.*public storage-program create.*storage fees/);
});

test('external misconfiguration is hidden like switch off and logged once at startup', async () => {
  const calls = { account: 0, auth: 0, nonce: 0, balance: 0 }, logs = [];
  const dependencies = { accounts: { getAccount() { calls.account++; throw Error('must not run'); } },
    authenticateBearer: async () => { calls.auth++; throw Error('must not run'); },
    chain: { async getAddressNonce() { calls.nonce++; }, async getAddressBalance() { calls.balance++; } },
    logger: { warn: (...args) => logs.push(args) } };
  const make = (on) => {
    const app = express(); app.use(createWalletExtensionProbeRouter({ ...dependencies, config: { walletExtensionProbe: on, authMode: 'external' } }));
    app.use((_req, res) => res.status(404).json({ error: 'not_found' })); return http.createServer(app);
  };
  const on = make(true), off = make(false);
  assert.equal(logs.length, 1, 'startup log exists before any requests');
  assert.equal(logs[0][0], 'wallet_extension_probe_requires_builtin_sign_in');
  for (const server of [on, off]) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (const path of ['/portal/wallet-extension-probe', '/portal/wallet-extension-probe/', '/PORTAL/WALLET-EXTENSION-PROBE/ASSETS/main.mjs', '/portal/%77allet-extension-probe/assets/main.mjs', '/portal/wallet-extension-probe%2Fassets%2Fmain.mjs', '/portal/wallet-extension-probe/assets/%6dain.mjs', '/portal/wallet-extension-probe/nonce/' + wallet.address,
      '/PORTAL/Wallet-Extension-Probe', '/portal/wallet-extension-probe/assets/main.mjs', '/portal/wallet-extension-probe/assets/MAIN.MJS',
      '/portal/wallet-extension-probe//assets/main.mjs', '//portal/wallet-extension-probe', '/portal//wallet-extension-probe',
      '/portal/wallet%2Dextension-probe', '/portal/./wallet-extension-probe', '/portal/x/../wallet-extension-probe',
      '/portal/assets/../wallet-extension-probe/assets/main.mjs', '/portal/assets/%2e%2e/%2e%2e/wallet-extension-probe/main.mjs',
      '/portal/wallet-extension-probe;x', '/portal/wallet-extension-probe?x=1', '/portal/wallet-extension-probe.', '/portal/wallet-extension-probe%20']) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) for (const headers of [{}, { authorization: 'Bearer owner' }]) {
        const results = [];
        for (const server of [on, off]) {
          const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers });
          results.push([res.status, await res.text()]);
        }
        assert.deepEqual(results[0], results[1], `${method} ${path}`);
        assert.deepEqual(results[0], [404, method === 'HEAD' ? '' : '{"error":"not_found"}']);
      }
    }
    assert.equal(logs.length, 1); assert.deepEqual(calls, { account: 0, auth: 0, nonce: 0, balance: 0 });
  } finally { for (const server of [on, off]) await new Promise((r) => server.close(r)); }
});
