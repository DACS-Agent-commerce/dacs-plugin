import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { nativeEvidenceFlow } from './helpers/native-payment-evidence-flow.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { showcaseProgressForModel } from '../src/mcp/showcase-model.mjs';
import { tool } from './helpers/flows.mjs';
installLoopbackOnlyGuard();

test('a refused fresh native Agreement readback downgrades Negotiate on both surfaces, across restart, until the gate passes', async (t) => {
  // The seller is never restarted here, so it needs no durable state directory.
  const w = await nativePaymentFlow(t, { env: { DACS_SHOWCASE_LEDGER: '1' }, durableSeller: false });
  const committed = await w.agreement(); assert.equal(committed.protocol.stage, 'seller-committed', JSON.stringify(committed));
  const negotiate = async () => {
    const view = (await w.api('view')).showcaseProgress.stages[2];
    assert.deepEqual((await tool(w.h, w.buyer, 'get_purchase_status', { operationId: w.id })).showcaseProgress.stages[2], showcaseProgressForModel({ stages: [null, null, view] }).stages[2]);
    return view;
  };
  const rows = (stage, label) => stage.evidence.filter((row) => row.label === label);
  let stage = await negotiate();
  assert.equal(stage.state, 'verified'); assert.equal(rows(stage, 'Agreement')[0].state, 'passed');
  // The native Agreement readback changes after verification: the approval gate refuses and records it.
  w.h.chain.faults.native = (object) => ({ ...object, data: { ...object.data, changedAfterVerification: true } });
  assert.equal((await w.api('challenge', { address: w.address })).error, 'agreement_unverified');
  await w.h.restart();
  stage = await negotiate();
  assert.equal(stage.state, 'rejected'); assert.match(stage.reason, /agreement_unverified/);
  assert.equal(rows(stage, 'Agreement')[0].state, 'rejected'); assert.equal(rows(stage, 'Agreement')[0].txHash, null);
  assert.equal(rows(stage, 'Agreement (historical)')[0].state, 'passed');
  assert.equal(rows(stage, 'Agreement (historical)')[0].txHash, w.op().state.protocol.agreement.anchorReceipt.transactionRef.value);
  const [refused] = rows(stage, 'commitment_recheck_refused'); assert.equal(refused.reason, 'agreement_unverified'); assert.match(refused.scope, /^Current/);
  // Only a passed fresh handoff gate recovers it.
  w.h.chain.faults.native = null;
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  stage = await negotiate();
  assert.equal(stage.state, 'verified'); assert.equal(rows(stage, 'Agreement')[0].state, 'passed'); assert.equal(rows(stage, 'Agreement (historical)').length, 0);
  assert.match(rows(stage, 'commitment_recheck_refused')[0].scope, /^Historical/);
  assert.equal(w.h.chain.record.broadcasts.length, 0, 'the ledger view sent nothing');
});

test('a failed fresh native Agreement read after payment downgrades Negotiate on both surfaces until a later verified native-evidence read', async (t) => {
  const w = await nativeEvidenceFlow(t, { env: { DACS_SHOWCASE_LEDGER: '1' } });
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  // Fixture native block timestamps have second resolution (see native-payment-evidence.test.mjs).
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload);
  const reported = await w.api('report', { txHash: w.h.chain.record.accepted[0]?.hash ?? sent.data?.hash });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported)); assert.equal(reported.evidence.protocol.stage, 'payment-evidenced');
  const stages = async () => {
    const view = (await w.api('view')).showcaseProgress.stages;
    assert.deepEqual((await tool(w.h, w.buyer, 'get_purchase_status', { operationId: w.id })).showcaseProgress.stages, showcaseProgressForModel({ stages: view }).stages);
    return view;
  };
  const rows = (stage, label) => stage.evidence.filter((row) => row.label === label);
  let [, , negotiate, settle] = await stages();
  assert.equal(negotiate.state, 'verified'); assert.equal(settle.state, 'payment-evidenced');
  // The native Agreement readback changes after payment; verify_deal re-reads it before asking the seller.
  w.h.chain.faults.native = (object) => ({ ...object, data: { ...object.data, changedAfterVerification: true } });
  const held = await w.verify();
  assert.equal(held.status, 'settled_verified'); assert.equal(held.protocol.stage, 'payment-evidenced');
  assert.equal(Object.hasOwn(held.protocol.lastAttempt, 'code'), false, 'the protocol attempt view is unchanged');
  const event = w.h.app.services.ops.history(w.id).filter((h) => h.type === 'protocol_native-evidence').at(-1);
  assert.deepEqual({ outcome: event.data.outcome, code: event.data.code }, { outcome: 'held', code: 'agreement_unverified' });
  [, , negotiate, settle] = await stages();
  assert.equal(negotiate.state, 'rejected'); assert.match(negotiate.reason, /agreement_unverified/);
  assert.equal(rows(negotiate, 'Agreement')[0].state, 'rejected'); assert.equal(rows(negotiate, 'Agreement (historical)')[0].state, 'passed');
  assert.equal(settle.state, 'held'); assert.match(settle.reason, /fresh native Agreement\/projection readback did not verify/);
  // A later verified native-evidence read re-read the Agreement first.
  w.h.chain.faults.native = null;
  assert.equal((await w.verify()).protocol.stage, 'payment-evidenced');
  [, , negotiate, settle] = await stages();
  assert.equal(negotiate.state, 'verified'); assert.equal(rows(negotiate, 'Agreement')[0].state, 'passed'); assert.equal(rows(negotiate, 'Agreement (historical)').length, 0);
  assert.equal(settle.state, 'payment-evidenced');
  assert.equal(w.h.chain.record.broadcasts.length, 1, 'the payment was sent once');
});

test('ledger native integration connects only to owned loopback', () => assert.deepEqual(externalAttempts, []));
