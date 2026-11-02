import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();
function signal() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('on: seller waits for CREATE authorization; payment waits for both independent readbacks', async t => {
  const signed = signal(); let w, sellerSigned = false;
  w = await nativePaymentFlow(t, { commitOnSignature: true, sellerOptions: { onSign(bytes) {
    if (bytes.toString().startsWith('dacs-finality-commitment:v1:')) { sellerSigned = true; signed.resolve(); }
  } } });
  let retained;
  const out = await w.agreement({ beforeWalletApproval: async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sellerSigned, false, 'seller cannot sign before buyer CREATE authorization');
    assert.equal(w.op().status, 'agreement_pending');
    assert.equal((await w.api('challenge', { address: w.address })).error, 'invalid_state');
  }, afterWalletApproval: async () => {
    await Promise.race([signed.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('seller signature did not arrive')), 10000); timer.unref(); })]);
    const address = finalityCommitmentAddress(w.op().terms.protocol.jobId);
    for (let i = 0; i < 250 && !w.h.anchors.records.has(address); i++) await new Promise(resolve => setTimeout(resolve, 20));
    retained = w.h.anchors.records.get(address); assert.ok(retained);
    w.h.anchors.records.delete(address);
  } });
  assert.equal(out.status, 'agreement_pending', JSON.stringify(out));
  assert.equal((await w.api('challenge', { address: w.address })).error, 'invalid_state');
  assert.equal(w.h.chain.record.broadcasts.length, 0);
  w.h.anchors.records.set(retained.receipt.logicalAddress, retained);
  const resumed = await w.verify();
  assert.equal(resumed.status, 'awaiting_approval', JSON.stringify(resumed));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff');
  assert.equal(handoff.payload.content.nonce, 2);
  assert.equal(w.seller.anchorWrites.length, 1);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});

for (const outcome of ['missing', 'indeterminate']) test(`on: ${outcome} Agreement holds through restart, with zero resends or payment`, async t => {
  const signed = signal(); let w;
  w = await nativePaymentFlow(t, { commitOnSignature: true, sellerOptions: { onSign(bytes) {
    if (bytes.toString().startsWith('dacs-finality-commitment:v1:')) signed.resolve();
  } } });
  let original;
  const out = await w.agreement({ afterWalletApproval: async () => {
    await Promise.race([signed.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('seller signature did not arrive')), 10000); timer.unref(); })]);
    original = w.h.chain.wire.record.accepted.splice(0);
    if (outcome === 'indeterminate') w.h.chain.faults.unavailable = true;
  } });
  assert.equal(out.status, 'agreement_pending', JSON.stringify(out));
  assert.equal(w.seller.anchorWrites.length, 1);
  assert.equal(w.seller.agent.stageOf(w.op().terms.protocol.jobId), 'proposed');
  await w.h.restart(); await w.seller.restart();
  for (let i = 0; i < 2; i++) {
    assert.equal((await w.verify()).status, 'agreement_pending');
    assert.equal((await w.api('challenge', { address: w.address })).error, 'invalid_state');
    assert.equal((await w.api('handoff')).error, 'wallet_fenced');
  }
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.seller.anchorWrites.length, 1);
  assert.equal(w.h.chain.record.broadcasts.length, 0);
  w.h.chain.faults.unavailable = false; w.h.chain.wire.record.accepted.push(...original);
  assert.equal((await w.verify()).status, 'awaiting_approval', 'original readbacks alone recover after restart');
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.seller.anchorWrites.length, 1);
});


for (const artifact of ['Agreement', 'commitment']) test(`fresh ${artifact} readback still gates handoff after both records previously verified`, async t => {
  const w = await nativePaymentFlow(t, { commitOnSignature: true });
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  const challenge = await w.api('challenge', { address: w.address }); assert.equal(challenge.httpStatus, 200);
  const address = finalityCommitmentAddress(w.op().terms.protocol.jobId);
  const original = artifact === 'Agreement' ? w.h.chain.wire.record.accepted.splice(0) : w.h.anchors.records.get(address);
  if (artifact === 'commitment') w.h.anchors.records.delete(address);
  const held = await w.api('approve', { challengeId: challenge.challengeId, signature: await w.sign(challenge.message) });
  assert.equal(held.status, 'approved'); assert.equal(held.payload, null);
  assert.equal(w.h.chain.record.broadcasts.length, 0);
  if (artifact === 'Agreement') w.h.chain.wire.record.accepted.push(...original);
  else w.h.anchors.records.set(address, original);
  assert.equal((await w.api('handoff')).status, 'payment_handoff');
  assert.equal(w.seller.anchorWrites.length, 1);
});

for (const abandoned of ['declined', 'expired', 'cancelled']) test(`on: ${abandoned} unauthorized purchase causes zero early seller writes`, async t => {
  let clockOffset = 0;
  const w = await nativePaymentFlow(t, { commitOnSignature: true, now: () => Date.now() + clockOffset });
  await w.agreement({ approvalState: abandoned === 'declined' ? 'denied' : 'completed', skipWalletApproval: abandoned !== 'declined',
    beforeWalletApproval: async () => {
      assert.equal(w.seller.anchorWrites.length, 0);
      if (abandoned === 'declined') w.allowAgreement(false);
      if (abandoned === 'expired') clockOffset = Date.parse(w.op().expiresAt) + 1 - Date.now();
      if (abandoned === 'cancelled') assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.op().accountId, operationId: w.id })).cancelled, true);
    } });
  await w.h.restart(); await w.seller.restart();
  await w.verify();
  assert.equal(w.seller.anchorWrites.length, 0);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 0);
});
