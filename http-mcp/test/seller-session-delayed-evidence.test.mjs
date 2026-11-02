// Delivery evidence that publishes after the seller answered delivery-ready is
// ordinary recovery: the buyer then verifies delivered from the same retained
// pointer. The key must still be retired after grace (real operator
// composition with delivery evidence on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';

test('a delivery verified delivered after delayed evidence publication still retires its key after grace', { timeout: 600000 }, async (t) => {
  let offset = 0, failed = false;
  // The first delivery evidence intent fails before anything is sent.
  const wrapPublicJournal = (journal) => new Proxy(journal, { get(target, key) {
    if (key === 'put') return async (name, value) => {
      if (!failed && value?.stage === 'intent' && value.input?.artifactKind === 'SettlementEvidence' && String(value.input?.logicalAddress).startsWith('dacs4:evidence:')) {
        failed = true; throw Object.assign(new Error('TEST evidence intent was not stored'), { code: 'TEST-journal-unavailable' });
      }
      return target.put(name, value);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal, evidenceResumeTimer: { every: () => ({}), cancel: () => {} },
    now: () => Date.now() + offset, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  assert.equal((await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'TEST-delayed-evidence' })).status, 'delivery-ready');
  assert.equal(failed, true);
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind='purchase' AND status='settled_verified'").get();
  const op = () => h.application.services.ops.get(row.account_id, row.id), verify = () => h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  assert.equal(op().state.protocol.delivery.evidenceHold.status, 'pending');
  await h.operator.resumeHeldDeliveryEvidence();
  await verify();
  const p = op().state.protocol;
  assert.equal(p.stage, 'delivered');
  assert.equal(p.sellerAnswer.delivery.status, 'delivery-ready', 'the retained answer predates the evidence');
  assert.equal(p.sellerAnswer.delivery.evidenceHash, p.delivery.evidenceHash, 'and names the evidence the buyer verified');
  offset = SELLER_SESSION_KEY_GRACE_MS + 1000;
  const swept = h.operator.sweepSellerSessions();
  assert.deepEqual(swept.deleted.map((item) => item.operationId), [row.id], JSON.stringify(swept.kept));
  offset = 0;
  // The readback-only recheck still verifies delivered without the key.
  await verify();
  assert.equal(op().state.protocol.stage, 'delivered', JSON.stringify(op().state.protocol.attempts.at(-1)));
  assert.equal(op().state.protocol.nativeEvidence?.sellerAnswerSource, 'retained; the seller was not asked');
});
