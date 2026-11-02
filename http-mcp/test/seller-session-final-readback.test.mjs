// A delegated purchase's final delivery is current only while a fresh native
// read authenticates it, exactly as for a custody purchase
// (docs/CURRENT-DELIVERY-READBACK.md). Final rechecks are readback-only: no
// seller request or session signature, before or after key deletion. A key is
// retired only once the purchase retains the signed payment projection that
// readback needs; a legacy row keeps it until a seller-backed recheck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { sha256Hex } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { modelReport } from './helpers/model-report.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';

const protocolOf = (answer) => answer?.protocol ?? answer?.evidence?.protocol;
const READS = [
  ['absent', async () => ({ status: 'absent', reason: 'TEST current Deliverable absent' }), 'payment-evidenced'],
  ['rejected', async () => ({ status: 'rejected', reason: 'TEST current Deliverable rejected' }), 'delivery-rejected'],
  ['unavailable', async () => { throw new Error('TEST current Deliverable storage unavailable'); }, 'payment-evidenced'],
];

function assertNotCurrent(answer, stage, report, label) {
  const protocol = protocolOf(answer);
  assert.equal(protocol?.stage, stage, `${label}: ${JSON.stringify(protocol)}`);
  assert.equal(protocol?.layers?.service, 'not-delivered', label);
  assert.equal(protocol?.delivery, null, label);
  assert.equal(JSON.stringify(answer).includes(JSON.stringify(report)), false, `${label}: historical report bytes are not current`);
  assert.equal(JSON.stringify(answer).includes(JSON.stringify(JSON.stringify(report)).slice(1, -1)), false, `${label}: nor inside a labelled wrapper`);
}

function assertReady(answer, original, label) {
  const protocol = protocolOf(answer);
  assert.equal(protocol?.stage, 'delivery-ready', `${label}: ${JSON.stringify(protocol)}`);
  assert.equal(protocol?.layers?.service, 'test-report-delivered-and-verified', label);
  assert.equal(protocol?.delivery?.fulfilmentId, original.fulfilmentId, label);
  assert.equal(protocol?.delivery?.deliverableRef?.contentHash, original.contentHash, label);
  // w.verify() answers carry the model-facing labelled wrapper; w.api('report') the raw report.
  assert.deepEqual(modelReport(protocol?.delivery?.report), original.report, label);
}

async function deliveryReady(t, delegated) {
  const w = await sourceDemoFlow(t, { delegated });
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(), sent = await w.send(handoff.payload);
  assert.equal(sent.success, true, JSON.stringify(sent));
  const first = protocolOf(await w.api('report', { txHash: sent.data.hash }));
  assert.equal(first?.stage, 'delivery-ready', JSON.stringify(first));
  const original = { fulfilmentId: first.delivery.fulfilmentId, contentHash: first.delivery.deliverableRef.contentHash, report: first.delivery.report };
  const effects = () => ({ writes: w.seller.anchorWrites.length, creates: w.h.chain.wire.record.broadcastAttempts.length, payments: w.h.chain.record.broadcasts.length });
  return { w, original, effects, baseline: effects(), authentic: w.seller.nativeDeliveryProvider.read };
}

test('custody delivery-ready: absent, rejected and unavailable fresh reads clear the current delivery and restoration recovers it', { timeout: 600000 }, async (t) => {
  const { w, original, effects, baseline, authentic } = await deliveryReady(t, false);
  const requests = w.seller.requests.length;
  assertReady(await w.verify(), original, 'custody final recheck');
  assert.ok(w.seller.requests.length > requests, 'custody final rechecks still ask the seller, as on main');
  for (const [name, read, stage] of READS) {
    w.seller.nativeDeliveryProvider.read = read;
    assertNotCurrent(await w.verify(), stage, original.report, `custody ${name}`);
    assert.equal(w.op().state.protocol.delivery, null);
    w.seller.nativeDeliveryProvider.read = authentic;
    assertReady(await w.verify(), original, `custody ${name} restored`);
  }
  assert.equal(Object.hasOwn(w.op().state.protocol, 'sellerAnswer'), false, 'custody purchases retain nothing new');
  assert.deepEqual(effects(), baseline);
});

test('delegated delivery-ready: final rechecks re-read without the seller, clear on absent, rejected and unavailable reads before and after key deletion, and recover the exact original', { timeout: 600000 }, async (t) => {
  const { w, original, effects, baseline, authentic } = await deliveryReady(t, true);
  const keyName = `${sha256Hex(w.id)}.json`, retiredName = `${sha256Hex(w.id)}.retired.json`;
  assert.ok(w.op().state.protocol.sellerAnswer, 'the authenticated seller answer is retained as a readback pointer');
  assert.doesNotMatch(JSON.stringify(w.op().state.protocol.sellerAnswer), /privateKey|BEGIN|pkcs8/i);
  const finalAt = w.op().state.protocol.sellerSessionFinalAt;

  // Final polling with the authentic reader: readback only, no seller request,
  // and the durable final clock is not restarted.
  let requests = w.seller.requests.length;
  for (let n = 0; n < 3; n++) {
    const answer = await w.verify();
    assertReady(answer, original, `final poll ${n}`);
    assert.match(protocolOf(answer).nativeEvidence?.sellerAnswerSource ?? '', /^retained; the seller was not asked/, 'seller fields come from the retained answer');
  }
  assert.equal(w.seller.requests.length, requests, 'final rechecks never ask the seller');
  assert.equal(w.op().state.protocol.sellerSessionFinalAt, finalAt);

  // Before key deletion.
  for (const [name, read, stage] of READS) {
    requests = w.seller.requests.length;
    w.seller.nativeDeliveryProvider.read = read;
    assertNotCurrent(await w.verify(), stage, original.report, `delegated ${name} before deletion`);
    assert.equal(w.op().state.protocol.delivery, null);
    assert.equal(w.seller.requests.length, requests, `${name}: the final readback did not ask the seller`);
    assert.equal(Object.hasOwn(w.op().state.protocol, 'sellerSessionFinalAt'), false, `${name}: a downgraded purchase is not final`);
    if (name === 'absent') {
      // A downgraded purchase may need the seller again: its key is kept.
      w.advanceDelegationClock(SELLER_SESSION_KEY_GRACE_MS + 60000);
      const swept = w.sweepSessions();
      assert.deepEqual(swept.deleted, []);
      assert.match(swept.kept[0].reason, /not final/);
      assert.deepEqual(readdirSync(w.sessionDirectory), [keyName]);
    }
    w.seller.nativeDeliveryProvider.read = authentic;
    assertReady(await w.verify(), original, `delegated ${name} restored before deletion`);
  }

  // A row verified before the answer was retained (legacy) has no public
  // signed payment CREATE: the seller wallet journal keeps only each wallet
  // lane's latest CREATE (here the Deliverable). So its key is kept, and while
  // it exists a final recheck asks the seller, as on main, and retains a
  // projection-bearing answer.
  const ops = () => w.h.app.services.ops, { sellerAnswer, ...legacy } = w.op().state.protocol;
  assert.ok(sellerAnswer.signedProjection, 'the retained answer carries the public signed payment CREATE');
  ops().transition(w.id, 'settled_verified', 'settled_verified', { state: { protocol: legacy }, event: 'TEST_legacy_row' });
  assert.equal(Object.hasOwn(w.op().state.protocol, 'sellerAnswer'), false);
  const kept = w.sweepSessions();
  assert.deepEqual(kept.deleted, []);
  assert.match(kept.kept[0].reason, /no retained signed payment projection/);
  assert.deepEqual(readdirSync(w.sessionDirectory), [keyName]);
  requests = w.seller.requests.length;
  assertReady(await w.verify(), original, 'legacy row rechecked through the seller with its kept key');
  assert.ok(w.seller.requests.length > requests, 'the legacy recheck asked the seller');
  const reacquired = w.op().state.protocol.sellerAnswer;
  assert.deepEqual(reacquired.signedProjection, sellerAnswer.signedProjection);
  assert.equal(reacquired.settlementId, sellerAnswer.settlementId);
  for (const key of ['status', 'fulfilmentId', 'logicalAddress', 'contentHash', 'evidenceHash']) assert.equal(reacquired.delivery[key], sellerAnswer.delivery[key], key);
  w.advanceDelegationClock(SELLER_SESSION_KEY_GRACE_MS + 60000);

  // Recovery kept the original final clock (it does not restart); the advanced
  // sweep clock is past its grace window, so the retained answer retires the key.
  const swept = w.sweepSessions();
  assert.deepEqual(swept.deleted.map((item) => item.operationId), [w.id]);
  assert.deepEqual(readdirSync(w.sessionDirectory), [retiredName]);

  // After key deletion, also across a restart: the same fresh readback decides.
  for (const [name, read, stage] of READS) {
    if (name === 'unavailable') { await w.h.restart(); w.restartSessions(); }
    requests = w.seller.requests.length;
    w.seller.nativeDeliveryProvider.read = read;
    assertNotCurrent(await w.verify(), stage, original.report, `delegated ${name} after deletion`);
    assert.equal(w.op().state.protocol.delivery, null);
    w.seller.nativeDeliveryProvider.read = authentic;
    assertReady(await w.verify(), original, `delegated ${name} restored after deletion`);
    assert.equal(w.seller.requests.length, requests, `${name}: no seller request after deletion`);
    assert.deepEqual(readdirSync(w.sessionDirectory), [retiredName], `${name}: no replacement key`);
  }

  // A legacy row whose key an earlier version already deleted reads fresh from
  // a pointer derived from its verified delivery, and keeps that pointer. Not
  // protected here: this composition has no other source of the signed
  // payment CREATE, so it stays held (never the old delivery, never the
  // seller) but keeps reading; the operator composition recovers it
  // (seller-session-legacy-operator.test.mjs).
  const { sellerAnswer: retainedAnswer, ...bare } = w.op().state.protocol;
  assert.ok(retainedAnswer.signedProjection);
  ops().transition(w.id, 'settled_verified', 'settled_verified', { state: { protocol: bare }, event: 'TEST_legacy_row_key_deleted' });
  requests = w.seller.requests.length;
  assertNotCurrent(await w.verify(), 'native-payment-evidence-held', original.report, 'legacy row after an earlier deletion');
  assert.match(w.op().state.protocol.nativeEvidence.nativeReadReason, /writer authorization/);
  assert.equal(w.op().state.protocol.sellerAnswer?.settlementId, retainedAnswer.settlementId, 'the derived pointer is kept');
  assert.equal(Object.hasOwn(w.op().state.protocol.sellerAnswer, 'signedProjection'), false);
  assertNotCurrent(await w.verify(), 'native-payment-evidence-held', original.report, 'legacy row after an earlier deletion, rechecked');
  assert.match(w.op().state.protocol.nativeEvidence.nativeReadReason, /writer authorization/, 'it is read again, not held as deleted');
  assert.equal(w.seller.requests.length, requests);
  assert.deepEqual(readdirSync(w.sessionDirectory), [retiredName], 'no replacement key');
  assert.deepEqual(effects(), baseline, 'readback never writes, pays or creates');
});
