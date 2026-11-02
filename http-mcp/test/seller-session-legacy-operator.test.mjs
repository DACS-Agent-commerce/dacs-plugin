// In the real operator composition: a delegated purchase verified before the
// seller answer was retained (a legacy row), whose session key an earlier
// version already deleted. A transient Node2 outage downgrades its delivery;
// the readback pointer derived from that delivery must survive the failed
// read, so once Node2 answers again a fresh readback recovers the exact
// original delivery. Readback only: no seller session, CREATE or payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

test('operator: a legacy delegated row whose key was already deleted keeps its readback pointer through a transient Node2 outage and recovers', { timeout: 300000 }, async (t) => {
  let offsetMs = 0, failing = false;
  const faults = [];
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, now: () => Date.now() + offsetMs, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true,
    rpcFault: ({ body }) => {
      if (!failing) return null;
      faults.push(body?.method ?? null);
      return new Response(JSON.stringify({ error: 'TEST transient Node2 outage' }), { status: 503, headers: { 'content-type': 'application/json' } });
    } });
  t.after(() => h.close());
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'operator-legacy-readback-001' });
  assert.equal(result.status, 'delivery-ready');
  offsetMs = SELLER_SESSION_KEY_GRACE_MS + 1000;
  const swept = h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length, 1, JSON.stringify(swept.kept));
  const [{ operationId, accountId }] = swept.deleted, ops = h.application.services.ops, op = () => ops.get(accountId, operationId);
  const directory = join(h.config.stateDirectory, 'seller-sessions'), keys = () => readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  const original = structuredClone(op().state.protocol.delivery);

  // The row as an earlier version left it: no retained answer, key deleted.
  const { sellerAnswer, ...legacy } = op().state.protocol;
  assert.ok(sellerAnswer);
  ops.transition(operationId, 'settled_verified', 'settled_verified', { state: { protocol: legacy }, event: 'TEST_legacy_row' });
  const effects = () => ({ creates: h.node2.chain.wire.record.accepted.length, payments: h.node2.chain.record.accepted.length }), baseline = effects();
  const verify = () => h.application.services.purchases.verifyDeal({ accountId, operationId });

  failing = true;
  await verify();
  failing = false;
  assert.ok(faults.length > 0, 'the recheck reached Node2 during the outage');
  if (h.prepared.config.buyerChainReadback === 'on') {
    // DACS_BUYER_CHAIN_READBACK=on: an outage is indeterminate,
    // never a contradiction, so the verified delivery is kept, not cleared.
    const held = op().state.protocol;
    assert.deepEqual(held.delivery, original, 'an indeterminate read keeps the verified delivery');
    assert.equal(held.stage, 'delivery-ready');
    assert.deepEqual([held.attempts.at(-1).step, held.attempts.at(-1).outcome], ['chain-readback', 'indeterminate']);
  } else {
    assert.equal(op().state.protocol.delivery, null, 'a failed read clears the current delivery');
    assert.notEqual(op().state.protocol.stage, 'delivery-ready');
  }
  const pointerKept = op().state.protocol.sellerAnswer?.settlementId === sellerAnswer.settlementId;

  await verify();
  const p = op().state.protocol;
  assert.equal(p.stage, 'delivery-ready', `after the outage: ${JSON.stringify(p.attempts?.at(-1))}`);
  assert.equal(p.delivery.fulfilmentId, original.fulfilmentId);
  assert.equal(p.delivery.deliverableRef.contentHash, original.deliverableRef.contentHash);
  assert.deepEqual(p.delivery.report, original.report);
  assert.ok(pointerKept, 'the derived readback pointer was kept through the failed read');
  assert.deepEqual(effects(), baseline, 'readback only: no CREATE or payment');
  assert.deepEqual(keys(), [], 'no replacement session key');
});
