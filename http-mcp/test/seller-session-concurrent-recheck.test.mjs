// Delegated rechecks that overlap, or fail early, must leave a purchase with a
// seller-free readback once its key may be deleted. save() still writes each
// recheck's own snapshot (a revision check is a separate change); the retained
// seller answer is what must survive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { modelReport } from './helpers/model-report.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';

const protocolOf = (answer) => answer?.protocol ?? answer?.evidence?.protocol;

function assertReady(answer, original, label) {
  const protocol = protocolOf(answer);
  assert.equal(protocol?.stage, 'delivery-ready', `${label}: ${JSON.stringify(protocol)}`);
  assert.equal(protocol?.delivery?.fulfilmentId, original.fulfilmentId, label);
  assert.equal(protocol?.delivery?.deliverableRef?.contentHash, original.contentHash, label);
  // w.verify() answers carry the model-facing labelled wrapper; w.api('report') the raw report.
  assert.deepEqual(modelReport(protocol?.delivery?.report), original.report, label);
}

async function deliveryReady(t) {
  const w = await sourceDemoFlow(t, { delegated: true });
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(), sent = await w.send(handoff.payload);
  assert.equal(sent.success, true, JSON.stringify(sent));
  const first = protocolOf(await w.api('report', { txHash: sent.data.hash }));
  assert.equal(first?.stage, 'delivery-ready', JSON.stringify(first));
  const original = { fulfilmentId: first.delivery.fulfilmentId, contentHash: first.delivery.deliverableRef.contentHash, report: first.delivery.report };
  const effects = () => ({ writes: w.seller.anchorWrites.length, creates: w.h.chain.wire.record.broadcastAttempts.length, payments: w.h.chain.record.broadcasts.length });
  return { w, first, original, effects, baseline: effects(), authentic: w.seller.nativeDeliveryProvider.read };
}

test('a recheck that started before a concurrent one retained the answer, and the sweep deleted the key, cannot erase that answer', { timeout: 600000 }, async (t) => {
  const { w, original, effects, baseline, authentic } = await deliveryReady(t);
  // A final legacy row: verified before the answer was retained.
  const { sellerAnswer: retained, ...legacy } = w.op().state.protocol;
  assert.ok(retained?.signedProjection);
  w.h.app.services.ops.transition(w.id, 'settled_verified', 'settled_verified', { state: { protocol: legacy }, event: 'TEST_legacy_row' });
  w.advanceDelegationClock(SELLER_SESSION_KEY_GRACE_MS + 60000);
  assert.deepEqual(w.sweepSessions().deleted, [], 'no retained projection yet, so the key stays');

  let entered, release, reads = 0;
  const reached = new Promise((resolve) => { entered = resolve; }), paused = new Promise((resolve) => { release = resolve; });
  w.seller.nativeDeliveryProvider.read = async (input) => {
    reads += 1;
    if (reads === 1) { entered(); await paused; throw new Error('TEST first concurrent Deliverable read fails late'); }
    return authentic(input);
  };
  // Both rechecks start from the same legacy snapshot; the first pauses in its
  // Deliverable read while the second retains the full answer.
  const slow = w.verify();
  await reached;
  assertReady(await w.verify(), original, 'the concurrent recheck');
  assert.deepEqual(w.op().state.protocol.sellerAnswer?.signedProjection, retained.signedProjection);
  assert.deepEqual(w.sweepSessions().deleted.map((item) => item.operationId), [w.id], 'the sweep deletes the key once the answer is retained');

  release();
  assert.equal(protocolOf(await slow)?.stage, 'payment-evidenced', 'the late failure still downgrades the current view');
  assert.deepEqual(w.op().state.protocol.sellerAnswer?.signedProjection, retained.signedProjection, 'the stale snapshot does not erase the retained answer');
  w.seller.nativeDeliveryProvider.read = authentic;
  const requests = w.seller.requests.length;
  assertReady(await w.verify(), original, 'with the key deleted, the retained answer still recovers the delivery');
  assert.equal(w.seller.requests.length, requests, 'without asking the seller');
  assert.deepEqual(effects(), baseline, 'no new writes, CREATEs or payments');
});

test('a readback-only recheck that fails before its payment summary still marks the retained seller fields', { timeout: 600000 }, async (t) => {
  const { w, first, original } = await deliveryReady(t);
  assert.ok(first.nativeEvidence?.sellerStatus);
  assert.equal(first.nativeEvidence?.sellerAnswerSource, undefined, 'the first answer came from the seller');
  w.h.chain.faults.unavailable = true;
  const failed = protocolOf(await w.verify());
  assert.equal(failed?.stage, 'payment-evidenced', JSON.stringify(failed));
  assert.equal(failed.nativeEvidence?.sellerStatus, w.op().state.protocol.sellerAnswer.status, 'the retained seller field is still visible');
  assert.match(failed.nativeEvidence?.sellerAnswerSource ?? '', /^retained; the seller was not asked$/);
  w.h.chain.faults.unavailable = false;
  const recovered = await w.verify();
  assertReady(recovered, original, 'restored chain');
  // No longer final and its key alive, so the recovery asked the seller.
  assert.equal(protocolOf(recovered).nativeEvidence?.sellerAnswerSource, undefined);
});
