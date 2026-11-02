// Ordinary Node closure controls for the source-demo native DEM deliverable,
// complementing test/claude-native-delivery-coverage.test.mjs. Expected fees,
// ordering and bindings are derived from the chain fixture's own accepted
// wire/native records and its debit rule, not from seller answers or counters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { compositeVerificationAddress, contentHash, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/claude-native-delivery-coverage-reader.mjs';
import { createFixtureAnchorClient } from '../src/dacs/fixture-anchors.mjs';

const DEM = 1000000000n;
const big = (v) => BigInt(String(v));
// Payer debit as applied by the fixture: balance removals from the signer plus explicit fees.
const appliedDebit = (tx) => tx.content.gcr_edits.filter((e) => e.type === 'balance' && e.operation === 'remove' && e.account === tx.content.from)
  .reduce((sum, e) => sum + big(e.amount), 0n) + ['network_fee', 'rpc_fee', 'additional_fee'].reduce((sum, k) => sum + big(tx.content.transaction_fee[k]), 0n);
// Wire fixture rule (dacs-storage-anchor-wallet-fixture.mjs check): per-10KiB storage fee, 1 DEM SDK gas, configured node fees.
const fixtureCreateDebit = (tx, faults) => BigInt(Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(tx.content.data[1].data)) / 10240))) * DEM
  + DEM + BigInt(faults.networkFee) * DEM + BigInt(faults.rpcFee) * DEM;

async function paid(t) {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  return { w, sent };
}

test('source demo native delivery closure: approval debits equal fixture-applied debits, ordered seller CREATEs bind the accepted payment, same partyVet composites reach the SDK audit source', { timeout: 120000 }, async (t) => {
  const { w, sent } = await paid(t);
  const reported = await w.api('report', { txHash: sent.data.hash });
  assert.equal(reported.evidence?.protocol?.stage, 'delivery-ready', JSON.stringify(reported));
  const jobId = w.op().terms.protocol.jobId, state = w.seller.agent.deliveryStateOf(jobId);
  const creates = acceptedCreates(w), byKind = (k) => creates.find((tx) => kindOf(tx) === k);
  const agreementCreate = byKind('Agreement'), evidenceCreate = byKind('SettlementEvidence'), deliveryCreate = byKind('Deliverable');
  const payment = w.h.chain.record.accepted.find((tx) => tx.hash === sent.data.hash);
  assert.ok(payment); assert.equal(w.h.chain.record.accepted.length, 1);

  // Fees: each wallet approval's shown debit equals what the fixture applied and its independent rule.
  const faults = w.h.chain.wire.faults;
  const sellerApproval = (k) => w.seller.sellerApprovals.find((r) => r.content?.artifactKind === k).content;
  for (const [kind, tx] of [['SettlementEvidence', evidenceCreate], ['Deliverable', deliveryCreate]]) {
    assert.equal(sellerApproval(kind).debit.totalOs, appliedDebit(tx).toString(), kind);
    assert.equal(appliedDebit(tx), fixtureCreateDebit(tx, faults), kind);
  }
  const paymentApproval = w.buyerActor.approvals.find((r) => r.content?.action === 'native DEM transfer').content;
  assert.equal(paymentApproval.debit.totalOs, appliedDebit(payment).toString());
  assert.equal(appliedDebit(payment), big(payment.content.amount) + DEM + 2n * DEM + 3n * DEM);

  // Ordering/nonces from the shared fixture inclusion: Agreement < payment < SettlementEvidence < Deliverable.
  const block = (tx) => w.h.chain.inclusion.numberFor(tx.hash);
  assert.deepEqual([agreementCreate, payment, evidenceCreate, deliveryCreate].map(block), [1, 2, 3, 4]);
  assert.deepEqual([agreementCreate.content.nonce, payment.content.nonce].map(Number), [1, 2]);
  assert.deepEqual([evidenceCreate.content.nonce, deliveryCreate.content.nonce].map(Number), [1, 2]);
  assert.ok(JSON.stringify(state.anchorReceipt.blockRef).includes(w.h.chain.inclusion.block(block(deliveryCreate)).hash), JSON.stringify(state.anchorReceipt.blockRef));

  // SettlementEvidence accepted bytes bind the accepted payment and are the bytes the SDK audit source consumed.
  const evidence = evidenceCreate.content.data[1];
  assert.equal(evidence.metadata.logicalAddress, paymentEvidenceAddress(jobId, 'demos-native:DEM', 2));
  assert.deepEqual(evidence.data.paymentTxRefs, [{ kind: 'demos', txHash: payment.hash, blockNumber: block(payment) }]);
  assert.equal(state.auditSource.artifacts.settlementEvidence[0].contentHash, contentHash(evidence.data));
  assert.equal(deliveryCreate.content.data[1].data.settlementId, `demos:${payment.hash}`);
  assert.ok(JSON.stringify(state.auditSource.session.phaseResults[2]).includes(payment.hash));

  // partyVetCore: exactly two composites (buyer, seller), each readable at its canonical address
  // through an ordinary fixture client, and the same refs reach the SDK audit source.
  const invocations = w.seller.deliveryContextProvider.invocations;
  assert.deepEqual(invocations.map((i) => i.evaluatedParty).sort(), [w.buyerActor.signer.claim, w.seller.wallet.claim].sort());
  const anchors = createFixtureAnchorClient({ url: w.h.anchors.url });
  for (const invocation of invocations) {
    const read = await anchors.read(compositeVerificationAddress(jobId, invocation.evaluatedParty));
    assert.equal(read.status, 'present');
    assert.equal(contentHash(read.artifact), invocation.recordRef.contentHash);
  }
  assert.deepEqual(state.auditSource.artifacts.vetRequirements.map((v) => v.vetRecordRef.contentHash).sort(), invocations.map((i) => i.recordRef.contentHash).sort());
  t.diagnostic(JSON.stringify({ jobId, blocks: [1, 2, 3, 4], debits: { payment: paymentApproval.debit.totalOs, evidence: sellerApproval('SettlementEvidence').debit.totalOs, delivery: sellerApproval('Deliverable').debit.totalOs },
    permit: 'static-only', partyVet: invocations.length }));
});

// Existing wire fault, scoped to the first applied Deliverable only.
async function lostDeliverableResponse(t) {
  const { w, sent } = await paid(t);
  let dropped = 0;
  Object.defineProperty(w.h.chain.wire.faults, 'dropAfterApply', { configurable: true,
    get: () => { const last = acceptedCreates(w).at(-1); if (dropped === 0 && last && kindOf(last) === 'Deliverable') { dropped += 1; return true; } return false; } });
  const first = await w.api('report', { txHash: sent.data.hash });
  assert.equal(dropped, 1);
  return { w, sent, first, jobId: w.op().terms.protocol.jobId };
}
function assertSingleEffects(w) {
  const deliveries = acceptedCreates(w).filter((tx) => kindOf(tx) === 'Deliverable');
  assert.equal(deliveries.length, 1);
  assert.deepEqual(acceptedCreates(w).map(kindOf).sort(), ['Agreement', 'Deliverable', 'SettlementEvidence']);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 3);
  assert.equal(w.h.chain.record.broadcasts.length, 1);
  assert.equal(w.seller.sellerApprovals.filter((r) => r.content?.artifactKind === 'Deliverable').length, 1);
  assert.equal(w.seller.evidenceAttempts.length, 1);
  return deliveries[0];
}

test('source demo native delivery: lost response after the Deliverable CREATE applies recovers on buyer verify after restart without a second CREATE, approval or payment', { timeout: 120000 }, async (t) => {
  const { w, first, jobId } = await lostDeliverableResponse(t);
  assert.equal(first.evidence?.protocol?.stage, 'payment-observed', JSON.stringify(first));
  assert.equal(first.evidence.protocol.paymentEvidence, null);
  const held = w.seller.agent.deliveryStateOf(jobId);
  assert.equal(held.result.code, 'delivery-submission-ambiguous', JSON.stringify(held));
  assert.equal(held.result.safeToRetryDelivery, false);
  assert.deepEqual(held.result.recovery, { action: 'reconcile-delivery' });
  await w.h.restart(); await w.seller.restart();
  const concurrent = await Promise.all([w.verify(), w.verify()]);
  assert.ok(concurrent.some((answer) => answer.protocol?.stage === 'delivery-ready'), JSON.stringify(concurrent.map((answer) => answer.protocol?.stage)));
  assert.ok(concurrent.every((answer) => ['payment-observed', 'delivery-ready'].includes(answer.protocol?.stage)));
  assert.equal((await w.verify()).protocol?.stage, 'delivery-ready');
  assert.equal(w.seller.agent.deliveryStateOf(jobId).fulfilmentId, held.result.fulfilmentId);
  const delivery = assertSingleEffects(w);
  for (const answer of concurrent.filter((candidate) => candidate.protocol?.stage === 'delivery-ready')) {
    assert.deepEqual(modelReport(answer.protocol.delivery.report), delivery.content.data[1].data);
  }
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  t.diagnostic(JSON.stringify({ firstStage: first.evidence.protocol.stage, held: held.reason, deliveryCreate: delivery.hash, attempts: 3, payments: 1 }));
});

test('source demo native delivery: seller resume and repeat report recover the retained SDK delivery intent read-only', { timeout: 120000 }, async (t) => {
  const { w, sent, jobId } = await lostDeliverableResponse(t);
  await w.h.restart(); await w.seller.restart();
  const resumed = await w.seller.agent.resume({ jobId });
  assert.equal(resumed.status, 'payment-evidenced');
  assert.equal(resumed.delivery?.status, 'delivery-ready', JSON.stringify(resumed));
  const repeated = await w.api('report', { txHash: sent.data.hash });
  const replay = await w.verify();
  assert.equal(repeated.evidence?.protocol?.stage, 'delivery-ready', JSON.stringify(repeated));
  assert.equal(replay.protocol?.stage, 'delivery-ready', JSON.stringify(replay));
  const delivery = assertSingleEffects(w);
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  t.diagnostic(JSON.stringify({ resumed: resumed.delivery.status, repeated: repeated.evidence.protocol.stage, replay: replay.protocol.stage,
    fulfilmentId: w.seller.agent.deliveryStateOf(jobId).fulfilmentId, deliveryCreate: delivery.hash }));
});

test('source demo native delivery: absent recovery readback remains held without resend and later authentic readback recovers', { timeout: 120000 }, async (t) => {
  const { w, jobId } = await lostDeliverableResponse(t);
  const read = w.seller.nativeDeliveryProvider.read;
  w.seller.nativeDeliveryProvider.read = async () => ({ status: 'absent', reason: 'TEST original signed projection temporarily unavailable' });
  await w.h.restart(); await w.seller.restart();
  assert.equal((await w.verify()).protocol?.stage, 'payment-observed');
  assert.match(w.seller.agent.deliveryStateOf(jobId).reason, /temporarily unavailable/);
  assertSingleEffects(w);
  w.seller.nativeDeliveryProvider.read = read;
  assert.equal((await w.verify()).protocol?.stage, 'delivery-ready');
  assertSingleEffects(w);
});
