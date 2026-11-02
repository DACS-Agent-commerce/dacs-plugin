// A native-evidence check that another check overtakes
// while its seller.submitPayment() is in flight. settle() saves inside its own
// transaction, so the check's protocol_check_not_saved event was rolled back
// with it and the possibly-issued evidence write left no trace. The event now
// commits, so ops health reads the write as unresolved. The purchase behaves
// as before: the same answer, stored state and retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeEvidenceFlow } from './helpers/native-payment-evidence-flow.mjs';
import { opsHealth } from '../src/ops/health.mjs';

test('a native-evidence check overtaken during submitPayment logs its held write, and ops health reports it until a saved readback', async (t) => {
  const w = await nativeEvidenceFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  // Fixture native block timestamps have second resolution (see native-payment-evidence.test.mjs).
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const ops = w.h.app.services.ops, agent = w.seller.agent, submit = agent.submitPayment;
  let saved;
  // The seller makes the evidence write; meanwhile another check saves newer
  // progress (as the PR's lost-attempt test models it), and this answer is lost.
  agent.submitPayment = async (input) => {
    await submit.call(agent, input);
    const stored = w.op(), protocol = stored.state.protocol;
    saved = ops.transition(stored.id, stored.status, stored.status, { state: { protocol: { ...protocol, revision: (protocol.revision ?? 0) + 1 } }, event: 'protocol_step', data: { stage: protocol.stage } });
    throw new Error('TEST evidence answer lost after the write');
  };
  const sent = await w.send(handoff.payload);
  const reported = await w.api('report', { txHash: w.h.chain.record.accepted[0]?.hash ?? sent.data?.hash });
  agent.submitPayment = submit;
  assert.equal(w.seller.evidenceAttempts.length, 1, 'the evidence write was made once');

  // The check ends with its own unsaved view; the stored purchase is the other check's.
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported));
  assert.equal(reported.evidence.protocol.stage, 'payment-observed');
  assert.deepEqual(reported.evidence.protocol.notSaved, { savedRevision: saved.state.protocol.revision, savedStage: 'payment-observed' });
  assert.deepEqual(w.op().state, saved.state);
  const notSaved = ops.history(w.id).filter((e) => e.type === 'protocol_check_not_saved');
  assert.equal(notSaved.length, 1, 'the not-saved check is in the event log');
  assert.deepEqual([notSaved[0].data.event, notSaved[0].data.outcome, notSaved[0].data.stage, notSaved[0].data.savedRevision],
    ['protocol_native-evidence', 'held', 'payment-observed', saved.state.protocol.revision]);
  // The bounded seller cause stays with the attempt's data before the not-saved fields.
  assert.deepEqual(Object.keys(notSaved[0].data), ['outcome', 'causeCode', 'reason', 'event', 'stage', 'revision', 'savedRevision', 'savedStage']);

  assert.equal(notSaved[0].data.causeCode,'status-5xx');
  assert.equal(notSaved[0].data.reason,'seller agent response is unavailable or unauthenticated; the operation outcome may be unknown');

  const stuck = () => opsHealth({ databasePath: w.h.config.databasePath, now: Date.now() }).stuck.filter((s) => s.purchaseId === w.id).map((s) => [s.stage, s.outcome, s.unresolvedWrites]);
  assert.deepEqual(stuck(), [['payment-observed', 'unknown-readback-required', ['native-evidence']]]);

  // The retry reads the evidence back and saves it, which settles the write.
  assert.equal((await w.verify()).protocol.stage, 'payment-evidenced');
  assert.equal(w.seller.evidenceAttempts.length, 1, 'the retry never resends the evidence write');
  assert.deepEqual(stuck(), []);
});

// Nothing in the plugin moves a purchase out of settled_verified today; the
// move is forced, as the lost-attempt tests do. The check's attempt cannot be
// saved, so note() logs it with no stage, and that event commits too.
test('a native-evidence check whose purchase changes status during submitPayment logs its held write with the same error', async (t) => {
  const w = await nativeEvidenceFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const ops = w.h.app.services.ops, agent = w.seller.agent, submit = agent.submitPayment;
  let moved;
  agent.submitPayment = async (input) => {
    await submit.call(agent, input);
    moved = ops.transition(w.id, 'settled_verified', 'cancelled', { event: 'TEST_status_move' });
    throw new Error('TEST evidence answer lost after the write');
  };
  const sent = await w.send(handoff.payload);
  const reported = await w.api('report', { txHash: w.h.chain.record.accepted[0]?.hash ?? sent.data?.hash });
  agent.submitPayment = submit;
  assert.equal(reported.error, 'invalid_state', JSON.stringify(reported));
  assert.deepEqual(w.op().state, moved.state, 'nothing of the check was saved');
  const lost = ops.history(w.id).filter((e) => e.type === 'protocol_native-evidence');
  assert.deepEqual(lost.map((e) => [e.data.outcome, Object.hasOwn(e.data, 'stage')]), [['held', false]]);
  assert.equal(lost[0].data.causeCode,'status-5xx');
  assert.equal(lost[0].data.reason,'seller agent response is unavailable or unauthenticated; the operation outcome may be unknown');
  const report = opsHealth({ databasePath: w.h.config.databasePath, now: Date.now() });
  assert.deepEqual(report.stuck.filter((s) => s.purchaseId === w.id).map((s) => [s.stage, s.outcome, s.unresolvedWrites]), [['cancelled', 'unknown-readback-required', ['native-evidence']]]);
});
