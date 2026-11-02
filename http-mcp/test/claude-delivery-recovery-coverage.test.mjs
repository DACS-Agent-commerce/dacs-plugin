// Ordinary Node interaction case for the repaired seller delivery recovery,
// complementing test/claude-native-delivery-closure.test.mjs. After a lost
// Deliverable response is recovered by seller resume, the SDK delivery-ready
// result is persisted while the signed transport command is still uncertain.
// That persisted result must pass fresh exact native readback on the read-only
// reconciliation seam before any report is returned. Expected report bytes,
// fulfilment id and effect counts come from the chain fixture's accepted
// signed CREATEs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { contentHash } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/claude-native-delivery-coverage-reader.mjs';

// Same existing wire fault and scoping as the closure test: only the first applied Deliverable loses its response.
async function lostDeliverableResponse(t) {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  let dropped = 0;
  Object.defineProperty(w.h.chain.wire.faults, 'dropAfterApply', { configurable: true,
    get: () => { const last = acceptedCreates(w).at(-1); if (dropped === 0 && last && kindOf(last) === 'Deliverable') { dropped += 1; return true; } return false; } });
  const first = await w.api('report', { txHash: sent.data.hash });
  assert.equal(dropped, 1);
  return { w, sent, first, jobId: w.op().terms.protocol.jobId };
}

// Effect inventory: chain wire/native records plus every seller signing approval, fixture write and public wallet journal row.
const effects = async (w) => ({ kinds: acceptedCreates(w).map(kindOf).sort(), attempts: w.h.chain.wire.record.broadcastAttempts.length,
  payments: w.h.chain.record.broadcasts.length, approvals: w.seller.sellerApprovals.length, evidence: w.seller.evidenceAttempts.length,
  writes: w.seller.anchorWrites.length, journal: (await w.seller.walletJournal.entries()).length });

test('source demo native delivery recovery: persisted SDK delivery-ready from seller resume returns no report while the original projection is absent or unavailable, then reconciles read-only', { timeout: 120000 }, async (t) => {
  const { w, sent, first, jobId } = await lostDeliverableResponse(t);
  assert.equal(first.evidence?.protocol?.stage, 'payment-observed', JSON.stringify(first));
  const held = w.seller.agent.deliveryStateOf(jobId);
  assert.equal(held.result.code, 'delivery-submission-ambiguous', JSON.stringify(held));
  const deliveryCreate = acceptedCreates(w).find((tx) => kindOf(tx) === 'Deliverable');
  const signedReport = deliveryCreate.content.data[1].data;
  // The SDK-retained fulfilment is exactly the one bound by the accepted signed CREATE.
  assert.equal(deliveryCreate.content.data[1].metadata.deliveryBinding.fulfilmentId, held.result.fulfilmentId);

  await w.h.restart(); await w.seller.restart();
  const resumed = await w.seller.agent.resume({ jobId });
  assert.equal(resumed.delivery?.status, 'delivery-ready', JSON.stringify(resumed));
  const persisted = w.seller.agent.deliveryStateOf(jobId);
  assert.equal(persisted.fulfilmentId, held.result.fulfilmentId);
  assert.equal(persisted.contentHash, contentHash(signedReport));
  const baseline = await effects(w);
  assert.deepEqual(baseline.kinds, ['Agreement', 'Deliverable', 'SettlementEvidence']);
  assert.equal(baseline.attempts, 3);
  assert.equal(baseline.payments, 1);
  assert.equal(w.seller.sellerApprovals.filter((r) => r.content?.artifactKind === 'Deliverable').length, 1);

  // Absent: the same answer the TEST provider gives when the original signed projection is unavailable.
  // Unavailable: the opaque reader throws. Both are non-authoritative; neither may yield a report.
  const read = w.seller.nativeDeliveryProvider.read;
  w.seller.nativeDeliveryProvider.read = async () => ({ status: 'absent', reason: 'original signed Deliverable CREATE projection is unavailable' });
  const absent = await w.verify();
  w.seller.nativeDeliveryProvider.read = async () => { throw new Error('TEST native delivery storage unavailable'); };
  const unavailable = (await w.api('report', { txHash: sent.data.hash })).evidence;
  for (const answer of [absent, unavailable]) {
    assert.equal(answer?.protocol?.stage, 'payment-observed', JSON.stringify(answer?.protocol));
    assert.equal(answer.protocol.delivery?.report, undefined);
  }
  // Read-only: the persisted result is neither discarded nor rewritten, and nothing is signed or written.
  assert.deepEqual(w.seller.agent.deliveryStateOf(jobId), persisted);
  assert.deepEqual(await effects(w), baseline);

  w.seller.nativeDeliveryProvider.read = read;
  const recovered = (await w.api('report', { txHash: sent.data.hash })).evidence;
  const replay = await w.verify();
  for (const answer of [recovered, replay]) {
    assert.equal(answer?.protocol?.stage, 'delivery-ready', JSON.stringify(answer?.protocol));
    assert.deepEqual(answer === replay ? modelReport(answer.protocol.delivery.report) : answer.protocol.delivery.report, signedReport);
    assert.equal(answer.protocol.delivery.deliverableRef.contentHash, contentHash(signedReport));
    assert.equal(answer.protocol.delivery.fulfilmentId, held.result.fulfilmentId);
  }
  assert.deepEqual(await effects(w), baseline);
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  t.diagnostic(JSON.stringify({ firstStage: first.evidence.protocol.stage, resumed: resumed.delivery.status, absent: absent.protocol.stage, unavailable: unavailable.protocol.stage,
    recovered: recovered.protocol.stage, replay: replay.protocol.stage, fulfilmentId: held.result.fulfilmentId, deliveryCreate: deliveryCreate.hash, baseline }));
});
