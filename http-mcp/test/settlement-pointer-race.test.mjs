// In-memory/durable SQLite only: no signer, transaction submission or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
const A = 'ab'.repeat(32), B = 'bc'.repeat(32);
const gate = () => { let start, release; const started = new Promise(r => { start = r; }), held = new Promise(r => { release = r; }); return { started, release, wait: async () => { start(); await held; } }; };
function world(t, aResult = 'included', bIncluded = false, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pointer-race-')), path = join(dir, 'state.db');
  let db, ops, coordinates, purchases;
  const accountId = 'TEST-pointer', wallet = `0x${'ee'.repeat(32)}`, payee = `0x${'dd'.repeat(32)}`;
  const domain = { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null };
  const terms = { buyer: { wallet }, seller: { payee, claim: 'TEST-seller' }, price: { amountOs: '2500000000' }, listing: { listingId: 'TEST', version: 1, contentHash: 'cd'.repeat(32) }, network: domain.network, rail: domain.rail, domain };
  if (options.native) terms.protocol = { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION };
  const first = gate(), second = gate();
  const chain = { network: domain.network, evidenceMode: domain.mode, networkIdentity: async () => ({ mode: domain.mode }),
    observeTransfer: async hash => { await (hash === A ? first : second).wait(); return hash === A
      ? { status: aResult === 'mismatch' ? 'included' : aResult, txHash: hash, blockNumber: 10, payer: wallet, payee, amountOs: aResult === 'mismatch' ? '1' : terms.price.amountOs }
      : bIncluded ? { status: 'included', txHash: hash, blockNumber: 11, payer: wallet, payee, amountOs: terms.price.amountOs } : { status: 'pending' }; },
    getTransaction: async hash => ({ hash, status: 'confirmed', blockNumber: hash === A ? 10 : 11, content: { from: wallet, nonce: 7 } }) };
  options.configure?.({ chain, domain, wallet, payee });
  const open = () => { db = openDatabase(path); ops = createOperationStore({ db, handoffSecret: 'TEST-pointer-secret-0000000000000000' }); coordinates = createCoordinateStore({ db }); purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain, verifier: {}, protocol: options.protocol }); };
  open();
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(accountId, 'TEST', accountId, new Date().toISOString());
  const create = (id, status) => { const op = ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: id, request: { id }, status, terms, termsHash: 'cd'.repeat(32), state: {}, expiresAt: new Date(Date.now()+60000).toISOString() }).operation;
    coordinates.save({ operationId: op.id, kind: 'dem-transfer', network: domain.network, from: wallet, nonceFence: 6, expectedNonce: 7, target: payee, amountOs: terms.price.amountOs, payload: {} }); return op; };
  const a = create('a', 'cancelled'), other = create('other', options.otherStatus ?? 'payment_handoff'); coordinates.reportHash(a.id, A);
  t.after(() => { first.release(); second.release(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { a, other, first, second, verify: hash => purchases.verifyDeal({ accountId, operationId: a.id, txHash: hash }),
    verifyOther: () => purchases.verifyDeal({ accountId, operationId: other.id }),
    setStatus: status => { db.prepare('UPDATE operations SET status = ? WHERE id = ?').run(status, a.id); },
    snapshot: () => ({ a: ops.get(accountId, a.id), coord: coordinates.get(a.id), historyA: ops.history(a.id), other: ops.get(accountId, other.id), lane: coordinates.get(other.id), history: ops.history(other.id), nonces: db.prepare('SELECT * FROM wallet_nonce_consumptions').all() }),
    restart: () => { db.close(); open(); }, get coordinates() { return coordinates; } };
}
for (const aResult of ['included', 'mismatch', 'pending', 'unavailable', 'failed']) for (const order of ['A first', 'B first']) for (const observedB of [false, true]) test(`stale payment read ${aResult}: ${order}, B observation ${observedB}`, async t => {
  const w = world(t, aResult), reading = w.verify(A); await w.first.started;
  const correcting = w.verify(B); await w.second.started;
  if (observedB) w.coordinates.recordObservation(w.a.id, { txHash: B, status: 'pending', marker: 'existing B' }, false);
  const before = w.snapshot();
  try {
    if (order === 'B first') { w.second.release(); await correcting; }
    const retained = w.snapshot();
    w.first.release(); const stale = await reading;
    assert.equal(stale.verification.outcome, 'pointer_changed');
    const { nonces, ...pointerBound } = w.snapshot(), { nonces: retainedNonces, ...retainedPointerBound } = retained;
    assert.deepEqual(pointerBound, retainedPointerBound, 'A cannot overwrite B, settle, move a status or supersede another purchase');
    // Only A's pointer-independent chain fact, its wallet-signed confirmed body
    // at the saved nonce, is kept for the handoff race guard.
    const walletFact = ['included', 'mismatch', 'failed'].includes(aResult);
    assert.deepEqual(nonces.filter(row => row.tx_hash === A).map(({ operation_id, nonce }) => ({ operation_id, nonce })), walletFact ? [{ operation_id: w.a.id, nonce: 7 }] : []);
    assert.deepEqual(nonces.filter(row => row.tx_hash !== A), retainedNonces.filter(row => row.tx_hash !== A));
    if (order === 'A first') { w.second.release(); await correcting; }
    const after = w.snapshot();
    assert.equal(after.coord.reportedTxHash, B); assert.equal(after.coord.verifiedAt, null);
    assert.equal(after.a.status, before.a.status); assert.deepEqual(after.lane, before.lane); assert.deepEqual(after.other, before.other);
    w.restart(); assert.deepEqual(w.snapshot(), after, 'restart retains only the current pointer and its evidence');
  } finally { w.first.release(); w.second.release(); await Promise.allSettled([reading, correcting]); }
});

// Each invalid component is independent; everything else is a valid proof of
// the saved slot. In particular an alternate signing key may name the buyer
// as payer, but cannot establish that the wallet itself consumed its nonce.
for (const [label, change] of [
  ['wrong hash', (body) => { body.hash = B; }],
  ['missing hash', (body) => { delete body.hash; }],
  ['wrong payer', (body) => { body.content.from_ed25519_address = `0x${'11'.repeat(32)}`; }],
  ['wrong nonce', (body) => { body.content.nonce = 8; }],
  ['missing nonce', (body) => { delete body.content.nonce; }],
  ['failed execution', (body) => { body.status = 'failed'; }],
  ['pending execution', (body) => { body.status = 'pending'; }],
  ['conflicting source', (_body, observation) => { observation.sourceDisposition = 'failed'; }],
  ['conflicting block', (body) => { body.blockNumber = 12; }],
  ['alternate signer', (body) => { body.content.from_ed25519_address = body.content.from; body.content.from = `0x${'11'.repeat(32)}`; }],
]) test(`stale nonce proof refuses ${label}`, async t => {
  const w = world(t, 'included', false, { configure({ chain }) {
    const observe = chain.observeTransfer, get = chain.getTransaction;
    let observation;
    chain.observeTransfer = async hash => (observation = await observe(hash));
    chain.getTransaction = async hash => { const body = await get(hash); change(body, observation); return body; };
  } });
  const reading = w.verify(A); await w.first.started;
  const correcting = w.verify(B); await w.second.started;
  const retained = w.snapshot();
  w.first.release(); const stale = await reading;
  assert.equal(stale.verification.outcome, 'pointer_changed');
  assert.equal(stale.verification.status, 'indeterminate');
  assert.deepEqual(w.snapshot(), retained, 'invalid stale proof adds no nonce row and changes no pointer-bound state');
  w.second.release(); await correcting;
});

test('stale failed source observation still retains an independently confirmed wallet nonce fact', async t => {
  const w = world(t, 'failed', false, { configure({ chain }) {
    const observe = chain.observeTransfer;
    chain.observeTransfer = async hash => ({ ...await observe(hash), sourceDisposition: 'failed' });
  } });
  const reading = w.verify(A); await w.first.started;
  const correcting = w.verify(B); await w.second.started;
  const { nonces: before, ...retained } = w.snapshot();
  assert.deepEqual(before, []);
  w.first.release(); assert.equal((await reading).verification.outcome, 'pointer_changed');
  const { nonces, ...after } = w.snapshot();
  assert.deepEqual(after, retained);
  assert.deepEqual(nonces.map(({ tx_hash, nonce, operation_id }) => ({ tx_hash, nonce, operation_id })), [{ tx_hash: A, nonce: 7, operation_id: w.a.id }]);
  w.second.release(); await correcting;
});

test('stale network refusal preserves the new pointer and emits no refusal event', async t => {
  const identity = gate(); let calls = 0;
  const w = world(t, 'pending', false, { configure({ chain, domain }) {
    domain.mode = chain.evidenceMode = 'public-chain-read';
    domain.chainIdentity = 'cd'.repeat(32);
    chain.pinnedIdentity = domain.chainIdentity;
    chain.networkIdentity = async () => {
      if (++calls === 1) { await identity.wait(); return { identity: '12'.repeat(32) }; }
      return { identity: domain.chainIdentity };
    };
  } });
  t.after(identity.release);
  const reading = w.verify(A); await identity.started;
  const correcting = w.verify(B); await w.second.started;
  const retained = w.snapshot(); identity.release();
  const stale = await reading;
  assert.equal(stale.verification.outcome, 'pointer_changed');
  assert.equal(stale.verification.status, 'indeterminate');
  assert.deepEqual(stale.operation, retained.a);
  assert.deepEqual(w.snapshot(), retained);
  assert.equal(w.snapshot().historyA.filter(e => e.type === 'readback_refused').length, 0);
  w.second.release(); await correcting;
});

for (const settleB of [false, true]) test(`stale ordinary identity error returns the current pointer, B settled ${settleB}`, async t => {
  const identity = gate(); let calls = 0;
  const w = world(t, 'pending', settleB, { configure({ chain, domain }) {
    domain.mode = chain.evidenceMode = 'public-chain-read';
    domain.chainIdentity = 'cd'.repeat(32);
    chain.pinnedIdentity = domain.chainIdentity;
    chain.networkIdentity = async () => {
      if (++calls === 1) { await identity.wait(); throw new Error('TEST rpc offline'); }
      return { identity: domain.chainIdentity };
    };
  } });
  t.after(identity.release);
  const reading = w.verify(A); await identity.started;
  const correcting = w.verify(B); await w.second.started;
  w.second.release(); await correcting;
  const retained = w.snapshot(); identity.release();
  const stale = await reading;
  assert.equal(stale.verification.outcome, 'pointer_changed');
  assert.equal(stale.verification.status, 'indeterminate');
  assert.deepEqual(stale.operation, retained.a);
  assert.deepEqual(w.snapshot(), retained, 'a stale RPC error writes no evidence or events');
});

test('ordinary identity error for the retained pointer stays chain_unavailable', async t => {
  const w = world(t, 'pending', false, { configure({ chain, domain }) {
    domain.mode = chain.evidenceMode = 'public-chain-read';
    domain.chainIdentity = chain.pinnedIdentity = 'cd'.repeat(32);
    chain.networkIdentity = async () => { throw new Error('TEST rpc offline'); };
  } });
  const retained = w.snapshot(), result = await w.verify();
  assert.equal(result.verification.outcome, 'chain_unavailable');
  assert.equal(result.verification.reason, 'TEST rpc offline');
  assert.deepEqual(w.snapshot(), retained);
});

test('not-found returns without requesting a canonical body that would stall', async t => {
  let calls = 0;
  const w = world(t, 'not-found', false, { configure({ chain }) {
    chain.getTransaction = () => { calls++; return new Promise(() => {}); };
  } });
  const reading = w.verify(A); await w.first.started; w.first.release();
  let timer;
  try {
    const result = await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('not-found awaited the body')), 1000); })]);
    assert.equal(result.verification.outcome, 'awaiting_inclusion');
    assert.equal(calls, 0);
  } finally { clearTimeout(timer); }
});

test('observation writes reject a hash other than the retained pointer', t => {
  const w = world(t), before = w.snapshot();
  assert.equal(w.coordinates.recordObservation(w.a.id, { txHash: B }, true), false);
  assert.deepEqual(w.snapshot(), before);
});

test('a completed B settlement survives a delayed A result and restart', async t => {
  const w = world(t, 'included', true), reading = w.verify(A);
  await w.first.started;
  const correcting = w.verify(B); await w.second.started;
  w.second.release();
  assert.equal((await correcting).verification.outcome, 'verified');
  const settled = w.snapshot();
  assert.equal(settled.coord.reportedTxHash, B); assert.equal(settled.coord.observation.txHash, B);
  w.first.release(); assert.equal((await reading).verification.outcome, 'pointer_changed');
  const after = w.snapshot(), withoutNonces = ({ nonces, ...rest }) => rest;
  assert.deepEqual(withoutNonces(after), withoutNonces(settled));
  assert.deepEqual(after.nonces.map(row => row.tx_hash), [...settled.nonces.map(row => row.tx_hash), A], 'only the stale wallet nonce fact is added');
  w.restart(); assert.deepEqual(w.snapshot(), after);
});

test('a purchase observation without its observed hash cannot verify a pointer', t => {
  const w = world(t), before = w.snapshot();
  assert.equal(w.coordinates.recordObservation(w.a.id, { status: 'included' }, true), false);
  assert.deepEqual(w.snapshot(), before);
});

test('same-pointer concurrent read returns the complete stored settlement', async t => {
  let seen = 0;
  const w = world(t, 'included', false, { configure({ chain, wallet, payee }) {
    chain.observeTransfer = async hash => {
      const older = ++seen === 1;
      await (older ? w.first : w.second).wait();
      return { status: 'included', txHash: hash, blockNumber: 10, payer: wallet, payee, amountOs: older ? '1' : '2500000000' };
    };
  } });
  const older = w.verify(A); await w.first.started;
  const newer = w.verify(A); await w.second.started;
  w.second.release(); const settled = await newer, retained = w.snapshot();
  assert.equal(settled.verification.outcome, 'verified');
  w.first.release(); const late = await older;
  assert.equal(late.verification.outcome, 'verified');
  assert.deepEqual(late.verification.observation, retained.coord.observation.observation);
  assert.equal(late.verification.verifiedAt, retained.coord.verifiedAt);
  assert.deepEqual(late.verification, settled.verification);
  assert.deepEqual(w.snapshot(), retained);
});

for (const status of ['pending', 'unavailable', 'not-found']) test(`native ${status} never dispatches nonce or supersession reconciliation`, async t => {
  const calls = [];
  const w = world(t, status, false, { native: true, protocol: {
    nativePaymentSuperseded: async () => { calls.push('supersession'); return true; },
  } });
  w.setStatus('payment_mismatch');
  const reading = w.verify(); await w.first.started; w.first.release();
  const result = await reading;
  assert.equal(result.operation.status, 'payment_mismatch');
  assert.equal(result.verification.outcome, status === 'unavailable' ? 'chain_unavailable' : 'awaiting_inclusion');
  assert.equal(Object.hasOwn(result.verification, 'nativeNonceResolved'), false);
  assert.equal(Object.hasOwn(result.verification, 'nativeLaneResolved'), false);
  assert.deepEqual(calls, []);
  assert.equal(w.snapshot().historyA.some(e => /native_(nonce|supersession)/.test(e.type)), false);
  assert.equal(Object.hasOwn(w.snapshot().coord.observation, 'nativeNonceResolved'), false);
  assert.equal(Object.hasOwn(w.snapshot().coord.observation, 'nativeLaneResolved'), false);
});

test('delayed pending read preserves concurrent supersession and retries its native lane release', async t => {
  let attempts = 0;
  const w = world(t, 'included', false, { native: true, otherStatus: 'broadcast_reported', protocol: {
    nativePaymentSuperseded: async operation => operation.id === w.other.id ? ++attempts > 1 : true,
  } });
  w.coordinates.reportHash(w.other.id, B);
  const delayed = w.verifyOther(); await w.second.started;
  const settling = w.verify(A); await w.first.started; w.first.release();
  assert.equal((await settling).verification.outcome, 'verified');
  const superseded = w.snapshot();
  assert.equal(superseded.other.status, 'superseded');
  assert.equal(superseded.lane.observation.supersededBy, w.a.id);
  assert.equal(superseded.lane.verifiedAt, null);
  assert.equal(attempts, 1, 'first release was temporarily refused');
  w.second.release(); const late = await delayed;
  assert.equal(late.verification.outcome, 'superseded');
  assert.equal(late.verification.supersededBy, w.a.id);
  assert.equal(late.verification.nativeLaneResolved, true);
  assert.equal(attempts, 2, 'delayed read retries the retained recovery');
  assert.equal(w.snapshot().lane.observation.supersededBy, w.a.id);
  assert.equal(w.snapshot().lane.verifiedAt, null);
  assert.equal((await w.verifyOther()).verification.nativeLaneResolved, true);
});
