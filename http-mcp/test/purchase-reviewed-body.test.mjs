// Offline purchase verification over the real admitted transport and stores.
// The .invalid RPC is injected; there is no socket, signer or submission path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { admittedTransport, CHAIN, layoutAdmission, layoutChain, mutableOwner, NETWORK, NOW, OTHER, WALLET } from './helpers/claude-node2-current-coverage-fixture.mjs';
import { NODE2_REVIEWED_NODE_VERSION, node2NetworkInfo } from './helpers/node2-reviewed-build.mjs';

const PAYEE = `0x${'7'.repeat(64)}`;
const body = (overrides = {}) => ({ hash: OTHER, status: 'confirmed', blockNumber: 10,
  content: { type: 'native', from: WALLET, to: PAYEE, amount: '1', nonce: 1, timestamp: NOW,
    data: ['native', { nativeOperation: 'send', args: [PAYEE, '1'] }] }, ...overrides });
const dirtyBuild = () => node2NetworkInfo({ ...NODE2_REVIEWED_NODE_VERSION, dirty: true });

async function world(t, { native = false, original = body(), replacement = body({ status: 'failed' }), state = 'included', dirty = false, onRequest } = {}) {
  const owner = mutableOwner(), acquire = owner.acquireConnectionFence, trace = [];
  let run, switched = false;
  owner.acquireConnectionFence = async (...args) => {
    const fence = await acquire(...args);
    return { ...fence, release() {
      fence.release();
      if (!switched && trace.some(c => c.message === 'getTransactionStatus')) {
        switched = true;
        owner.state.connectionId = 'TEST-dirty-replacement';
        run.stub.set({ getNetworkInfo: dirtyBuild(), getTxByHash: { result: 200, response: replacement } });
      }
    } };
  };
  run = admittedTransport(await layoutAdmission(), { ...layoutChain(),
    getNetworkInfo: dirty ? dirtyBuild() : node2NetworkInfo(),
    getTransactionStatus: { result: 200, response: { state, blockNumber: 10 } },
    getTxByHash: { result: 200, response: original },
    10: { result: 200, response: { number: 10, status: 'confirmed', hash: OTHER,
      content: { ordered_transactions: [OTHER], timestamp: NOW / 1000 } } },
  }, { owner, onRequest: async request => {
    trace.push({ ...request, connectionId: owner.state.connectionId });
    await onRequest?.(request, owner);
  } });
  t.after(() => run.capability.close());
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const accountId = 'TEST-reviewed-purchase-body';
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
    .run(accountId, 'TEST', accountId, new Date(NOW).toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-reviewed-body-secret-000000000000', now: () => NOW });
  const coordinates = createCoordinateStore({ db });
  const domain = { network: NETWORK, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN };
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE, claim: 'TEST-seller' },
    price: { amountOs: '1' }, listing: { listingId: 'TEST-reviewed-body', version: 1, contentHash: 'ab'.repeat(32) },
    network: NETWORK, rail: domain.rail, domain,
    ...(native ? { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
      nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment',
      sellerAgreementProjection: 'public-signed-create' } } : {}) };
  const { operation } = ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: 'TEST-reviewed-body',
    request: {}, status: 'payment_handoff', terms, termsHash: 'cd'.repeat(32),
    expiresAt: new Date(NOW + 60000).toISOString() });
  coordinates.save({ operationId: operation.id, kind: 'dem-transfer', network: NETWORK, from: WALLET,
    nonceFence: 0, expectedNonce: 1, target: PAYEE, amountOs: '1', payload: {} });
  const chain = run.capability.chainReader();
  const purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain, now: () => NOW });
  return { ...run, chain, trace, ops, coordinates, operation,
    switched: () => switched,
    // Attach directly from payment_handoff: no retained source intent exists.
    verify: () => purchases.verifyDeal({ accountId, operationId: operation.id, txHash: OTHER }) };
}

function assertOneBody(w) {
  const reads = w.trace.filter(c => ['getTransactionStatus', 'getTxByHash', 'getNetworkInfo'].includes(c.message) || c.blockNumber === 10);
  assert.equal(reads.filter(c => c.message === 'getTxByHash').length, 1, 'verification reuses the observed body');
  assert.equal(reads.filter(c => c.message === 'getNetworkInfo').length, 1);
  assert.ok(reads.every(c => c.connectionId === 'claude-cov-connection-1'), 'all decision facts and the build use one connection');
  assert.ok(w.switched(), 'the connection is replaced immediately after observation');
  assert.deepEqual(w.journal.puts, [], 'a reported hash alone creates no source intent');
  assert.ok(!w.stub.messages().some(m => ['confirmTx', 'broadcastTx'].includes(m)));
}

for (const native of [false, true]) {
  const method = native ? 'native purchase' : 'legacy purchase';

  test(`${method}: purchase ignores a failed body on the replacement connection`, async t => {
    const w = await world(t, { native });
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'verified');
    assert.equal(result.operation.status, 'settled_verified');
    assert.equal(result.verification.txNonce, 1);
    assert.equal(result.verification.txStatus, 'confirmed');
    assert.equal(result.verification.slotConsumed, true);
    assert.equal(Object.hasOwn(result.verification.observation, 'transaction'), false);
    assert.equal(Object.hasOwn(w.coordinates.get(w.operation.id).observation.observation, 'transaction'), false);
    assertOneBody(w);
  });

  test(`${method}: a replacement expected nonce cannot settle the reviewed wrong nonce`, async t => {
    const original = body(); original.content.nonce = 2;
    const w = await world(t, { native, original, replacement: body() });
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'pointer_rejected');
    assert.equal(result.verification.txNonce, 2);
    assert.equal(result.verification.slotConsumed, false);
    assert.equal(w.coordinates.get(w.operation.id).reportedTxHash, null);
    assert.ok(!w.ops.history(w.operation.id).some(e => e.type === 'settled_verified'));
    assertOneBody(w);
  });

  test(`${method}: a replacement confirmed body cannot override reviewed failed execution`, async t => {
    const w = await world(t, { native, original: body({ status: 'failed' }), replacement: body() });
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'execution_failed');
    assert.equal(result.verification.txStatus, 'failed');
    assert.equal(result.verification.slotConsumed, false);
    assert.equal(result.operation.status, 'payment_uncertain');
    assert.ok(!w.ops.history(w.operation.id).some(e => e.type === 'settled_verified'));
    assertOneBody(w);
  });

  for (const state of ['failed', 'rejected']) test(`${method}: ${state} status fetches its body before fence release`, async t => {
    const w = await world(t, { native, state, original: body({ status: 'failed' }), replacement: body() });
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'execution_failed');
    assert.equal(result.verification.txStatus, 'failed');
    assert.equal(result.verification.slotConsumed, false);
    assertOneBody(w);
  });

  test(`${method}: an unreviewed original body cannot change purchase settlement`, async t => {
    const w = await world(t, { native, dirty: true });
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'chain_unavailable');
    assert.equal(result.operation.status, 'broadcast_reported');
    assert.equal(w.coordinates.get(w.operation.id).verifiedAt, null);
    assert.ok(!w.ops.history(w.operation.id).some(e => ['settled_verified', 'pointer_rejected'].includes(e.type)));
    assertOneBody(w);
  });
}

test('connection drift during a failed-status body fetch holds purchase verification', async t => {
  const w = await world(t, { state: 'failed', onRequest: (request, owner) => {
    if (request.message === 'getTxByHash') owner.state.connectionId = 'TEST-drift-during-body';
  } });
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'chain_unavailable');
  assert.equal(result.operation.status, 'broadcast_reported');
  assert.equal(w.coordinates.get(w.operation.id).verifiedAt, null);
  assert.deepEqual(w.journal.puts, []);
});

test('readers without an observation body retain their transaction-read contract', async t => {
  const w = await world(t);
  // The general chain reader has no source-fence snapshot contract.
  w.chain.observePurchaseTransfer = undefined;
  w.chain.observeTransfer = async () => ({ status: 'included', txHash: OTHER, blockNumber: 10,
    payer: WALLET, payee: PAYEE, amountOs: '1' });
  let bodyReads = 0;
  w.chain.getTransaction = async () => { bodyReads++; return body(); };
  assert.equal((await w.verify()).verification.outcome, 'verified');
  assert.equal(bodyReads, 1);
});

test('a supplied null observation body fails closed without fetching a replacement', async t => {
  const w = await world(t);
  w.chain.observePurchaseTransfer = undefined;
  w.chain.observeTransfer = async () => ({ status: 'included', txHash: OTHER, blockNumber: 10,
    payer: WALLET, payee: PAYEE, amountOs: '1', transaction: null });
  w.chain.getTransaction = async () => { assert.fail('must not replace the observed null body'); };
  assert.equal((await w.verify()).verification.outcome, 'transaction_unconfirmed');
  assert.equal(w.coordinates.get(w.operation.id).verifiedAt, null);
});
