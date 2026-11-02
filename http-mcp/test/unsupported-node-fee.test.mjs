// Offline purchase preflight: the real RPC parser and service, no HTTP listener,
// wallet, signing, transaction submission or SDK private store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { recoverable } from '../src/portal/purchase-auto-advance.mjs';
import { openDatabase } from '../src/store/database.mjs';

for (const [scenario, balanceFailure] of [['unsupported', null], ['malformed', null], ['unavailable', null], ['unsupported', 'balance first'], ['unsupported', 'fee first']]) test(`purchase preflight explains ${scenario} fees before seller work or wallet approval, ${balanceFailure ?? 'balance available'}`, async (t) => {
  let feeFailed; const feeFailure = new Promise(resolve => { feeFailed = resolve; });
  const db = openDatabase(':memory:'); t.after(() => db.close());
  let reads = 0, writes = 0, sellerWork = 0;
  const logs = [];
  const reader = createDemosChainReader({ rpcUrl: 'https://offline.invalid/', network: 'demos-testnet', fetchImpl: async (_url, init) => {
    reads += 1;
    assert.equal(JSON.parse(init.body).params[0].message, 'getNetworkParameters');
    return scenario === 'unavailable' ? new Response('unavailable', { status: 503 }) : new Response(JSON.stringify({ result: 200,
      response: { networkFee: 1, rpcFee: 1, additionalFee: scenario === 'unsupported' ? 4 : -1 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const service = createPurchaseService({ db, config: { fundingHelpUrl: 'https://faucet.example/' },
    accounts: { listWallets: () => [{ address: `0x${'aa'.repeat(32)}` }] },
    ops: { findByKey: () => null, createIdempotent: () => { writes += 1; throw new Error('unexpected purchase write'); } },
    coordinates: { unresolvedForSender: () => [] },
    verifier: { verify: async () => ({ transactable: true, payee: `0x${'bb'.repeat(32)}`, price: { amount: '2.5', amountOs: '2500000000' } }) },
    protocol: { supportsMode: () => true, prepareTerms: () => ({ terms: {}, state: {} }), assertSellerAdmission: () => { sellerWork += 1; } },
    chain: { network: 'demos-testnet', networkIdentity: async () => ({ mode: 'simulated-fixture' }), getAddressBalance: async () => {
        if (!balanceFailure) return 1_000_000_000_000n;
        if (balanceFailure === 'fee first') { await feeFailure; await Promise.resolve(); }
        throw new Error('TEST balance offline');
      },
      getTransactionFees: async () => { try { return await reader.getTransactionFees(); } finally { feeFailed(); } } },
    logger: { warn: (event, detail) => logs.push({ event, ...detail }) },
  });
  await assert.rejects(service.prepare({ accountId: 'TEST', listingId: 'TEST', version: 1, seller: 'TEST-seller', idempotencyKey: 'TEST-fee', protocol: 'dacs-pay-dem' }), (error) => {
    assert.equal(error.code, scenario === 'unsupported' ? 'unsupported_node_fee' : 'buyer_balance_unavailable');
    if (scenario === 'unsupported') {
      assert.match(error.message, /additional transaction fee.*wallet version cannot sign/);
      assert.doesNotMatch(error.message, /try again|fund|balance.*unknown/i);
      assert.equal(error.buyerFunding, undefined);
    } else {
      assert.match(error.message, /Try again after the chain read is available/);
      assert.equal(error.buyerFunding.balance, 'unknown');
    }
    return true;
  });
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(sellerWork, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'buyer_funds_read_failed');
  assert.equal(logs[0].errorCode, scenario === 'unsupported' ? 'unsupported_node_fee' : null);
});

// The portal ends on the refusal instead of re-reading, and both refusal guides say so.
test('an unsupported node fee is final for the portal and documented as not retried', () => {
  const message = 'The node requires an additional transaction fee that this wallet version cannot sign.';
  for (const status of [409, 503]) assert.equal(recoverable({ status, code: 'unsupported_node_fee', message }), false, String(status));
  assert.equal(recoverable({ status: 409, code: 'buyer_balance_unavailable', message }), true);
  for (const doc of ['CHATGPT-DEVELOPER-MODE.md', 'portal-auto-advance.md']) {
    const text = readFileSync(new URL(`../docs/${doc}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /`unsupported_node_fee`[^.]*(?:final|not retried)/, doc);
  }
});
