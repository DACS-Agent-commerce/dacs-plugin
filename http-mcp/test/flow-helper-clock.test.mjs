// Approval must align the simulated payment clock with finalized SR-2 evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { startSdkChainFixture } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { linkedUser, tool, portal, tokenFrom, approvePurchase, reportPurchase } from './helpers/flows.mjs';

for (const [name, start] of [['chain', startChainFixture], ['SDK chain', startSdkChainFixture]]) {
  test(`${name} advanceTo rejects seconds and accepts epoch milliseconds`, async (t) => {
    const chain = await start();
    t.after(() => chain.close());
    for (const timestamp of [0, 1_700_000_000, 1e12 - 1]) {
      assert.throws(() => chain.advanceTo(timestamp), RangeError);
    }
    assert.doesNotThrow(() => chain.advanceTo(1e12));
    assert.doesNotThrow(() => chain.advanceTo(1_700_000_000_000));
  });
}

test('shared purchase approval pays after finalized commitment with a 60 second clock skew', async (t) => {
  const now = () => Date.now() + 60_000;
  const h = await startProtocolHarness({ now });
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId: 'approval-clock-skew', now });
  const buyer = await linkedUser(h);
  const prepared = await tool(h, buyer, 'prepare_purchase', {
    listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim,
    idempotencyKey: 'approval-clock-skew', protocol: 'dacs-pay-dem',
  });
  assert.equal(prepared.status, 'agreement_pending');
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = (part, body) => portal(h, `/portal/api/purchase/${id}/${part}`, { token, ...body });
  const identity = await api('agreement/identity', { address: buyer.wallet.address });
  const plan = await api('agreement/plan', { signature: buyer.wallet.signHex(identity.signRequest.message) });
  const signed = await api('agreement/sign', {
    agreementSignature: buyer.wallet.signHex(plan.signRequest.agreementMessage),
    anchorSignature: buyer.wallet.signHex(plan.signRequest.anchorMessage),
  });
  assert.equal(signed.status, 'awaiting_approval');
  const { approved } = await approvePurchase(h, id, prepared.approvalUrl, buyer.wallet);
  assert.equal(approved.status, 'payment_handoff');
  const txHash = h.chain.walletBroadcast(approved.payload);
  const delivered = await reportPurchase(h, id, token, { txHash });
  assert.equal(delivered.status, 'settled_verified');
  assert.equal(delivered.evidence.protocol.stage, 'awaiting-countersignature', JSON.stringify(delivered.evidence.protocol.lastAttempt));
});
