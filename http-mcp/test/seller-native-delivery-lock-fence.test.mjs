// The seller-state job lock is checked last before the native Deliverable
// submission. A holder whose row was removed from outside (a raw DELETE, a
// hand edit, or the earlier version reclaiming across PID namespaces) submits
// nothing and retains nothing: its own session write is fenced, and the SDK's
// delivery WAL keeps the thrown submission at its intent rather than recording
// an outcome. The next request takes the job again, reads back authoritative
// absence and delivers exactly once. SIMULATED: the source-demo flow's
// loopback chain and TEST seller (helpers/source-demo-flow.mjs). The row is
// removed in the event-loop turn after the seller's last protocol signature
// before the submission, once that signature's fenced completion has been
// recorded: after the last fenced write and before the submission's check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/claude-native-delivery-coverage-reader.mjs';

test('a holder that lost its job lock before the native Deliverable submission submits and retains nothing; the next request delivers exactly once', { timeout: 300000 }, async (t) => {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  const jobId = w.op().terms.protocol.jobId, provider = w.seller.nativeDeliveryProvider, { reconcile, submit } = provider;
  const calls = [];
  // armed after the SDK reads back the empty delivery address; the next
  // protocol signature (not a seller-state envelope) is the last before the submission.
  let armed = false;
  provider.reconcile = async (input) => {
    const answer = await reconcile(input);
    calls.push(['reconcile', answer.status]);
    if (calls.length === 1 && answer.status === 'absent') armed = true;
    return answer;
  };
  provider.submit = async (input) => { calls.push(['submit']); return submit(input); };
  const signBytes = w.seller.wallet.signBytes;
  w.seller.wallet.signBytes = (bytes) => {
    const signature = signBytes(bytes);
    if (armed && !Buffer.from(bytes).toString('latin1').startsWith('dacs-chatgpt-plugin')) {
      armed = false;
      calls.push(['signed']);
      setImmediate(() => {
        const db = new DatabaseSync(join(w.seller.durableDirectory, 'seller-state.sqlite'));
        try { calls.push(['row removed', db.prepare('DELETE FROM seller_locks WHERE job=?').run(jobId).changes]); } finally { db.close(); }
      });
    }
    return signature;
  };
  const deliverables = () => ({ creates: acceptedCreates(w).map(kindOf).filter((kind) => kind === 'Deliverable').length,
    approvals: w.seller.sellerApprovals.filter((r) => r.content?.artifactKind === 'Deliverable').length });

  const stale = await w.api('report', { txHash: sent.data.hash });
  assert.equal(stale.evidence?.protocol?.stage, 'payment-observed', JSON.stringify(stale.evidence?.protocol));
  assert.deepEqual(calls, [['reconcile', 'absent'], ['signed'], ['row removed', 1]], 'the stale holder submitted nothing');
  assert.deepEqual(w.seller.functionalErrors, [{ code: 'seller_state_fenced', message: 'seller_state_fenced' }], 'its step ended fenced');
  assert.deepEqual(deliverables(), { creates: 0, approvals: 0 }, 'nothing was approved or sent');
  assert.equal(w.seller.agent.deliveryStateOf(jobId), null, 'the stale holder retained no delivery hold or result');

  // Nothing durable says the delivery was attempted, rejected or ambiguous: the next holder delivers.
  const next = await w.api('report', { txHash: sent.data.hash });
  assert.equal(next.evidence?.protocol?.stage, 'delivery-ready', JSON.stringify(next.evidence?.protocol));
  assert.deepEqual(calls.slice(3).filter(([name]) => name !== 'signed').slice(0, 2), [['reconcile', 'absent'], ['submit']], 'the next holder read back absence, then submitted');
  assert.deepEqual(calls.filter(([name]) => name === 'submit'), [['submit']], 'submitted once in total');
  assert.deepEqual(deliverables(), { creates: 1, approvals: 1 }, 'one Deliverable CREATE in total');
});
