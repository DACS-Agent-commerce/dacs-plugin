// A recheck that started before a concurrent one retained the seller answer,
// and before the sweep deleted the key, can still finish successfully. It must
// not replace that retirement-safe answer: not with a seller answer that does
// not authenticate the purchase's verified payment receipt, and not with a
// pointer derived from its stale snapshot. Otherwise, once the seller's wallet
// lane moves on, the purchase has no seller-free readback left.
// Real operator composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { sha256Hex } from '@kynesyslabs/dacs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { addressForClaim, verifyDemosSignature } from '../src/wallet/demos-signature.mjs';

const RETAINED = 'retained; the seller was not asked';
const pause = () => { let entered, release; const reached = new Promise((resolve) => { entered = resolve; }), paused = new Promise((resolve) => { release = resolve; }); return { reached, paused, entered: () => entered(), release: () => release() }; };
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`TEST never reached ${label}`)), 60000); timer.unref(); })]);

// One delivered delegated purchase, rewritten as a final legacy row (verified
// before the answer was retained), with the clock past its grace window.
async function legacyFinal(t, options = {}) {
  let offset = 0;
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, now: () => Date.now() + offset, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, ...options });
  t.after(() => h.close());
  const driver = h.operator.createBuyerDriver({ composition: h.composition });
  assert.equal((await driver.purchase({ idempotencyKey: 'TEST-late-recheck-first' })).status, 'delivery-ready');
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind='purchase' AND status='settled_verified'").get();
  const ops = h.application.services.ops, op = () => ops.get(row.account_id, row.id), original = structuredClone(op().state.protocol.sellerAnswer);
  assert.ok(original?.signedProjection);
  const { sellerAnswer, ...legacy } = op().state.protocol;
  ops.transition(row.id, 'settled_verified', 'settled_verified', { state: { protocol: legacy }, event: 'TEST_legacy_row' });
  // Sweeps run past the grace window; every other step runs at the real time
  // (the buyer wallet refuses delegations that start in the future).
  const sweep = () => { offset = SELLER_SESSION_KEY_GRACE_MS + 1000; try { return h.operator.sweepSellerSessions(); } finally { offset = 0; } };
  assert.deepEqual(sweep().deleted, [], 'no retained projection yet, so the key stays');
  return { h, driver, op, original, sweep, id: row.id, verify: () => h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id }) };
}

// The second recheck retains the genuine answer, and the sweep deletes the key.
async function retainAndRetire(x) {
  await x.verify();
  assert.equal(x.op().state.protocol.stage, 'delivery-ready', JSON.stringify(x.op().state.protocol.attempts.slice(-3)));
  assert.deepEqual(x.op().state.protocol.sellerAnswer?.signedProjection, x.original.signedProjection);
  assert.deepEqual(x.sweep().deleted.map((item) => item.operationId), [x.id]);
}

// The seller's next purchase overwrites its wallet journal lane, so only the
// retained answer can still authenticate the first purchase's payment CREATE.
async function recoversAfterLaneMoves(x) {
  assert.deepEqual(x.op().state.protocol.sellerAnswer?.signedProjection, x.original.signedProjection, 'the retirement-safe answer survives');
  assert.equal((await x.driver.purchase({ idempotencyKey: 'TEST-late-recheck-second' })).status, 'delivery-ready');
  await x.verify();
  const p = x.op().state.protocol;
  assert.equal(p.stage, 'delivery-ready', `recovery after the seller lane moved: ${JSON.stringify(p.attempts.at(-1))}`);
  assert.equal(p.nativeEvidence?.sellerAnswerSource, RETAINED);
}

// A race: the first recheck's seller answer carries another
// projection; it pauses in its evidence read and succeeds after the deletion.
async function lateFreshAnswer(t, projection) {
  const gate = pause();
  let armed = false;
  const x = await legacyFinal(t, { wrapPublicJournal: (journal) => ({
    get: async (key) => { const value = await journal.get(key); if (armed && value?.input?.artifactKind === 'Deliverable') { armed = false; gate.entered(); await gate.paused; } return value; },
    put: (...args) => journal.put(...args), entries: (...args) => journal.entries(...args), withWalletLock: (...args) => journal.withWalletLock(...args) }) });
  t.after(() => gate.release());
  // The seller's own authenticated response cache answers the first recheck.
  const peer = new DatabaseSync(join(x.h.config.stateDirectory, 'seller-transport.sqlite')); t.after(() => peer.close());
  const row = peer.prepare('SELECT effect, response FROM peer_effects').all().find((item) => { try { return JSON.parse(item.response).signedProjection?.hash === x.original.signedProjection.hash; } catch { return false; } });
  assert.ok(row, 'the seller cached its payment answer');
  const changed = JSON.parse(row.response); changed.signedProjection = await projection(x);
  peer.prepare('UPDATE peer_effects SET response=? WHERE effect=?').run(JSON.stringify(changed), row.effect);
  armed = true;
  const slow = x.verify();
  await within(gate.reached, 'the paused evidence read');
  peer.prepare('UPDATE peer_effects SET response=? WHERE effect=?').run(row.response, row.effect);
  await retainAndRetire(x);
  gate.release();
  const late = (await slow).operation.state.protocol;
  assert.deepEqual(late.sellerAnswer?.signedProjection, x.original.signedProjection, 'the late success does not replace the retained answer');
  assert.equal(late.stage, 'delivery-ready', 'the late recheck still verifies the delivery');
  assert.match(late.nativeEvidence?.sellerAnswerNotRetained ?? '', /its signed projection names another transaction/);
  await recoversAfterLaneMoves(x);
}

test('a late successful recheck with a genuine seller-signed CREATE of another artifact keeps the retained answer', { timeout: 600000 }, (t) => lateFreshAnswer(t, async (x) => {
  const replayed = (await x.h.prepared.composition.sourceCapability.journal.entries()).map(([, record]) => record.signedTransaction)
    .find((tx) => tx?.content?.data?.[1]?.metadata?.artifactKind === 'Deliverable');
  assert.ok(replayed);
  assert.equal(sha256Hex(JSON.stringify(replayed.content)), replayed.hash);
  assert.equal(verifyDemosSignature({ address: addressForClaim(x.h.composition.sellerAgent.claim), message: replayed.hash, signature: replayed.signature.data }), true, 'a genuine seller-signed CREATE');
  return replayed;
}));

test('a late successful recheck with an unauthenticated projection keeps the retained answer', { timeout: 600000 }, (t) => lateFreshAnswer(t, async () =>
  ({ hash: '0'.repeat(64), content: { TEST: 'not the original signed payment CREATE' }, signature: { type: 'ed25519', data: '0'.repeat(128) } })));

// The race: the first recheck read the legacy row, then paused before
// it authorized its seller request; meanwhile a second recheck retained the
// full answer and the sweep deleted the key. Every await before that
// authorization holds the operator's network-binding observation, which would
// also stall the second recheck, so the pause is modelled exactly: the first
// recheck's own read returns the row as it was before the second one. Its
// request is then refused (seller_session_retired), and it reads back from a
// pointer derived from that stale row, which has no signed projection.
test('a recheck paused before seller authorization, resumed after key retirement, keeps the retained answer', { timeout: 600000 }, async (t) => {
  const x = await legacyFinal(t);
  const stale = x.op(), ops = x.h.application.services.ops, get = ops.get;
  await retainAndRetire(x);
  ops.get = (accountId, id) => { ops.get = get; return id === x.id ? structuredClone(stale) : get(accountId, id); };
  t.after(() => { ops.get = get; });
  const late = (await x.verify()).operation.state.protocol;
  assert.equal(ops.get, get, 'the paused recheck read the stale row');
  assert.equal(late.nativeEvidence?.sellerAnswerSource, RETAINED, 'the late recheck read back without the seller');
  assert.equal(late.stage, 'delivery-ready', `the derived readback still verifies: ${JSON.stringify(late.attempts.at(-1))}`);
  await recoversAfterLaneMoves(x);
});

// A readback-only recheck re-reads from the answer its own snapshot retained.
// When a newer answer was stored meanwhile (by another recheck), its success
// keeps the stored one: only a fresh seller answer replaces it.
test('a successful readback-only recheck from a stale snapshot keeps the newer stored answer', { timeout: 600000 }, async (t) => {
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  assert.equal((await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'TEST-stale-retained' })).status, 'delivery-ready');
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind='purchase' AND status='settled_verified'").get();
  const ops = h.application.services.ops, get = ops.get, op = () => get(row.account_id, row.id), stale = op();
  const newer = { ...stale.state.protocol.sellerAnswer, TEST: 'newer stored answer' };
  ops.transition(row.id, 'settled_verified', 'settled_verified', { state: { protocol: { ...stale.state.protocol, sellerAnswer: newer } }, event: 'TEST_newer_answer' });
  ops.get = (accountId, id) => { ops.get = get; return id === row.id ? structuredClone(stale) : get(accountId, id); };
  t.after(() => { ops.get = get; });
  const late = (await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id })).operation.state.protocol;
  assert.equal(late.nativeEvidence?.sellerAnswerSource, RETAINED, 'readback only');
  assert.equal(late.stage, 'delivery-ready', JSON.stringify(late.attempts.at(-1)));
  assert.deepEqual(op().state.protocol.sellerAnswer, newer);
});
