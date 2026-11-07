// Offline DACS fixed-price pay-dem purchase through the plugin: MCP tools and
// the portal API drive the buyer side (src/purchases.mjs +
// src/dacs/protocol-purchases.mjs) against the seller agent on loopback, the
// SIMULATED chain fixture and the SIMULATED SR-2 fixture substrate. The buyer
// "wallet" is an ephemeral test key that signs exactly what the portal asks;
// the seller key is a separate ephemeral key held only by the seller agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { modelReport, sellerValue } from './helpers/model-report.mjs';
import { canonicalSellerSettlementId, finalityCommitmentAddress, bundleAddress } from '@kynesyslabs/dacs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, toolRaw, portal, tokenFrom, approvePurchase, reportPurchase, seedSellerListing } from './helpers/flows.mjs';
import { startHarness } from './helpers/harness.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { advancePastFinalizedCommitment } from './helpers/finalized-payment.mjs';

// A re-signed variant of a published Listing (same id/version, other terms).
const fixtureListingFor = (wallet, published, overrides) => fixtureListing(wallet, { listingId: published.listingId, version: published.listingVersion, price: published.pricing.price.amount, ...overrides });

let h;
let alice;
let bob;
let n = 0;
const key = (label) => `dacs-${label}-${++n}-${Date.now()}`;

before(async () => {
  h = await startProtocolHarness();
  alice = await linkedUser(h);
  bob = await linkedUser(h);
});
after(async () => h.close());

async function prepare(user, seller, label) {
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: key(label), protocol: 'dacs-pay-dem' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  return { ...p, token: tokenFrom(p.approvalUrl) };
}

// The wallet signs exactly the three messages the portal asks for.
async function signAgreement(p, wallet) {
  // portal() merges the body over the HTTP status, so failures show as `error`.
  const identity = await portal(h, `/portal/api/purchase/${p.operationId}/agreement/identity`, { token: p.token, address: wallet.address });
  assert.equal(identity.error, undefined, JSON.stringify(identity));
  const plan = await portal(h, `/portal/api/purchase/${p.operationId}/agreement/plan`, { token: p.token, signature: wallet.signHex(identity.signRequest.message) });
  assert.equal(plan.error, undefined, JSON.stringify(plan));
  const signed = await portal(h, `/portal/api/purchase/${p.operationId}/agreement/sign`, { token: p.token, agreementSignature: wallet.signHex(plan.signRequest.agreementMessage), anchorSignature: wallet.signHex(plan.signRequest.anchorMessage) });
  return { identity, plan, signed };
}

const operationOf = (p, wallet) => h.app.services.ops.get(h.app.services.accounts.walletOwner(wallet.address), p.operationId);

async function payCommitted(p, wallet) {
  const { challenge, approved } = await approvePurchase(h, p.operationId, p.approvalUrl, wallet);
  assert.equal(approved?.status, 'payment_handoff', JSON.stringify(approved ?? challenge));
  advancePastFinalizedCommitment(h, operationOf(p, wallet));
  const hash = h.chain.walletBroadcast(approved.payload); // SIMULATED wallet sign + broadcast
  return { challenge, approved, hash, reported: await reportPurchase(h, p.operationId, p.token, { txHash: hash }) };
}

async function countersign(p, wallet) {
  const request = await portal(h, `/portal/api/purchase/${p.operationId}/completion/request`, { token: p.token });
  assert.equal(request.error, undefined, JSON.stringify(request));
  return portal(h, `/portal/api/purchase/${p.operationId}/completion/countersign`, { token: p.token, bundleSignature: wallet.signHex(request.signRequest.bundleMessage), anchorSignature: wallet.signHex(request.signRequest.anchorMessage) });
}

test('accepting control: one offline DACS purchase end to end through MCP and the portal', async () => {
  const seller = await addSeller(h, { listingId: 'dacs-e2e-1' });
  const p = await prepare(alice, seller, 'e2e');
  assert.equal(p.protocol.stage, 'identity');
  assert.equal(p.terms.payee, seller.wallet.address);
  assert.equal(p.terms.amountOs, '2500000000');
  assert.deepEqual(p.protocol.layers, { transfer: 'not-observed', dacsPurchase: 'not-evidenced', service: 'not-delivered', completedCopies: 'not-exchanged', humanAcceptance: 'not-recorded' });

  // Payment before commitment: no approval challenge is issued at all.
  const early = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: p.token, address: alice.wallet.address });
  assert.equal(early.error, 'invalid_state');

  const { plan, signed } = await signAgreement(p, alice.wallet);
  for (const field of ['jobId', 'listing', 'seller', 'payee', 'amount', 'amountOs', 'network']) assert.ok(plan.signRequest.summary[field], `plan shows ${field}`);
  assert.equal(plan.signRequest.summary.payee, seller.wallet.address);
  assert.equal(signed.status, 'awaiting_approval', JSON.stringify(signed.evidence?.protocol));
  const pv = signed.evidence.protocol;
  assert.equal(pv.stage, 'committed');
  assert.equal(pv.commitment.signer, seller.wallet.claim);
  assert.equal(pv.commitment.address, finalityCommitmentAddress(pv.jobId));
  assert.equal(pv.agreement.payee, seller.wallet.address);

  const { challenge, approved, hash, reported } = await payCommitted(p, alice.wallet);
  for (const fragment of [`dacs-job: ${pv.jobId}`, `dacs-agreement: ${pv.agreement.hash}`, `dacs-commitment: ${pv.commitment.contentHash}`, `dacs-commitment-signer: ${seller.wallet.claim}`, `payee: ${seller.wallet.address}`, 'amount-os: 2500000000']) {
    assert.ok(challenge.message.includes(fragment), `approval shows ${fragment}`);
  }
  assert.equal(approved.payload.content.to, pv.agreement.payee, 'transfer pays the committed payee');
  assert.equal(approved.payload.content.amount, pv.agreement.price.amountOs, 'transfer pays the committed amount');
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
  assert.equal(reported.evidence.protocol.stage, 'awaiting-countersignature', JSON.stringify(reported.evidence.protocol.lastAttempt));

  const mid = await tool(h, alice, 'get_purchase_status', { operationId: p.operationId });
  assert.deepEqual(mid.protocol.layers, { transfer: 'observed-by-one-rpc-tuple-only', dacsPurchase: 'payment-evidence-verified', service: 'test-report-delivered-and-verified', completedCopies: 'not-exchanged', humanAcceptance: 'not-recorded' });
  assert.equal(sellerValue(mid.protocol.paymentEvidence).model, 'bft-final');
  assert.equal(modelReport(mid.protocol.delivery.report).jobId, pv.jobId);
  assert.match(mid.approvalUrl, /#t=/, 'the link stays open only for the counter-signature');

  const done = await countersign(p, alice.wallet);
  assert.equal(done.status, 'settled_verified');
  assert.equal(done.evidence.protocol.stage, 'completed', JSON.stringify(done.evidence.protocol.lastAttempt));
  assert.equal(seller.agent.stageOf(pv.jobId), 'copies-exchanged', 'the seller verified the buyer copy');

  const raw = await toolRaw(h, alice, 'get_purchase_status', { operationId: p.operationId });
  const final = raw.structuredContent;
  assert.equal(final.protocol.layers.completedCopies, 'both-copies-verified');
  assert.equal(final.protocol.layers.humanAcceptance, 'not-recorded');
  assert.equal(final.approvalUrl, null);
  const text = raw.content[0].text;
  for (const phrase of ['transfer observed-by-one-rpc-tuple-only', 'DACS purchase payment-evidence-verified', 'service test-report-delivered-and-verified', 'completed copies both-copies-verified', 'human acceptance not-recorded']) assert.ok(text.includes(phrase), `status text keeps layer: ${phrase}`);
  assert.equal(final.protocol.limits.vet, 'not-performed');
  assert.equal(final.protocol.limits.substrate, 'simulated-loopback-fixture');
  assert.equal(h.chain.nonceOf(alice.wallet.address), 1, 'exactly one transfer was sent');
  assert.equal(final.reportedTxHash, hash);
});

// ---------------- negatives and boundaries ----------------

test('Listing alteration: a seller agent offering other terms than the published Listing is refused before anything is paid', async () => {
  const buyer = await linkedUser(h);
  // The agent signs a different (re-priced) Listing than the one published on chain.
  const seller = await addSeller(h, { listingId: 'dacs-altered', agentListing: (published, wallet) => fixtureListingFor(wallet, published, { price: '1' }) });
  const p = await prepare(buyer, seller, 'altered');
  const { signed } = await signAgreement(p, buyer.wallet);
  assert.equal(signed.status, 'agreement_rejected', JSON.stringify(signed.evidence?.protocol?.lastAttempt));
  assert.match(signed.evidence.protocol.lastAttempt.reason, /seller|Listing|rejected/i);
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: p.token, address: buyer.wallet.address });
  assert.equal(challenge.error, 'invalid_state', 'no approval after a refused Agreement');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0);
});

test('unavailable seller during the Agreement: indeterminate, nothing paid, the same signatures re-drive after recovery', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-seller-down' });
  const p = await prepare(buyer, seller, 'seller-down');
  seller.state.unavailable = true;
  const { signed } = await signAgreement(p, buyer.wallet);
  assert.equal(signed.status, 'agreement_pending');
  assert.equal(signed.evidence.protocol.stage, 'agreement-signing');
  assert.equal(signed.evidence.protocol.lastAttempt.outcome, 'indeterminate');
  seller.state.unavailable = false;
  const resumed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(resumed.status, 'awaiting_approval', JSON.stringify(resumed.protocol?.lastAttempt));
  assert.equal(resumed.protocol.stage, 'committed');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0);
});

test('missing commitment: an anchored Agreement without a finalized commitment never reaches approval', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-no-commit' });
  const p = await prepare(buyer, seller, 'no-commit');
  seller.state.failPaths.add('/dacs/v1/commitments');
  const { signed } = await signAgreement(p, buyer.wallet);
  assert.equal(signed.status, 'agreement_pending');
  assert.equal(signed.evidence.protocol.stage, 'agreement-anchored');
  assert.equal(signed.evidence.protocol.lastAttempt.step, 'commitment');
  assert.equal(signed.evidence.protocol.lastAttempt.outcome, 'absent');
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: p.token, address: buyer.wallet.address });
  assert.equal(challenge.error, 'invalid_state');
  seller.state.failPaths.clear();
  const resumed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(resumed.status, 'awaiting_approval');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0);
});

test('changed commitment: a commitment that no longer verifies on re-read blocks approval and handoff', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-changed-commit' });
  const p = await prepare(buyer, seller, 'changed-commit');
  const { signed } = await signAgreement(p, buyer.wallet);
  assert.equal(signed.status, 'awaiting_approval');
  const address = finalityCommitmentAddress(signed.evidence.protocol.jobId);
  h.anchors.faults.alter.set(address, (record) => ({ ...record, createdAt: record.createdAt + 1 }));
  const refused = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: p.token, address: buyer.wallet.address });
  assert.equal(refused.error, 'commitment_unverified', 'no approval message is issued');
  // Altered between approval and handoff: the approval is recorded, the payload is not handed out.
  h.anchors.faults.alter.delete(address);
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: p.token, address: buyer.wallet.address });
  h.anchors.faults.alter.set(address, (record) => ({ ...record, createdAt: record.createdAt + 1 }));
  const approved = await portal(h, `/portal/api/purchase/${p.operationId}/approve`, { token: p.token, challengeId: challenge.challengeId, signature: buyer.wallet.signHex(challenge.message) });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.payload, null, 'no transfer payload before a verified commitment readback');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0);
  h.anchors.faults.alter.delete(address);
  const handoff = await portal(h, `/portal/api/purchase/${p.operationId}/handoff`, { token: p.token });
  assert.equal(handoff.status, 'payment_handoff');
  assert.equal(handoff.payload.content.to, seller.wallet.address);
  // Settle so this wallet holds no open handoff.
  advancePastFinalizedCommitment(h, operationOf(p, buyer.wallet));
  await reportPurchase(h, p.operationId, p.token, { txHash: h.chain.walletBroadcast(handoff.payload) });
});

test('unavailable seller after the transfer: the claim is retried with the same transaction and nothing is sent twice', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-claim-down' });
  const p = await prepare(buyer, seller, 'claim-down');
  await signAgreement(p, buyer.wallet);
  seller.state.failPaths.add('/dacs/v1/payments');
  const { reported, hash } = await payCommitted(p, buyer.wallet);
  assert.equal(reported.status, 'settled_verified');
  assert.equal(reported.evidence.protocol.stage, 'awaiting-claim');
  assert.equal(reported.evidence.protocol.layers.dacsPurchase, 'not-evidenced', 'a transfer alone is not a DACS purchase');
  const stillDown = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(stillDown.protocol.stage, 'awaiting-claim');
  assert.match(stillDown.next, /never pay again/);
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 1);
  seller.state.failPaths.clear();
  const resumed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(resumed.protocol.stage, 'awaiting-countersignature', JSON.stringify(resumed.protocol.lastAttempt));
  assert.equal(resumed.protocol.claim.txHash, hash);
  assert.equal(resumed.protocol.claim.settlementId, canonicalSellerSettlementId({ kind: 'demos', txHash: hash }), 'the reference seller\'s settlement identity stays raw');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 1, 'no second send');
});

test('failed or uncertain send: no payment claim reaches the seller and no second payload is handed out', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-failed-send' });
  const p = await prepare(buyer, seller, 'failed-send');
  await signAgreement(p, buyer.wallet);
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload, { failOnChain: true });
  const reported = await reportPurchase(h, p.operationId, p.token, { txHash: hash });
  assert.equal(reported.status, 'payment_uncertain');
  assert.equal(reported.evidence.protocol.layers.transfer, 'not-observed');
  assert.ok(!seller.state.requests.includes('/dacs/v1/payments'), 'no claim for an unconfirmed transfer');
  const again = await portal(h, `/portal/api/purchase/${p.operationId}/handoff`, { token: p.token });
  assert.equal(again.error, 'invalid_state', 'no new payload while the outcome is unresolved');
  const unknown = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(unknown.status, 'payment_uncertain');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 1);
});

test('replayed transaction across jobs: another purchase cannot claim a transfer it did not send', async () => {
  const seller = await addSeller(h, { listingId: 'dacs-replay' });
  const first = await prepare(alice, seller, 'replay-a');
  await signAgreement(first, alice.wallet);
  const { hash } = await payCommitted(first, alice.wallet);
  const second = await prepare(bob, seller, 'replay-b');
  await signAgreement(second, bob.wallet);
  const { approved } = await approvePurchase(h, second.operationId, second.approvalUrl, bob.wallet);
  assert.equal(approved.status, 'payment_handoff');
  const claimed = await reportPurchase(h, second.operationId, second.token, { txHash: hash });
  assert.equal(claimed.verification.outcome, 'pointer_rejected');
  assert.ok(claimed.verification.mismatches.includes('payer is not the approved buyer wallet'));
  assert.equal(claimed.evidence.protocol.stage, 'committed', 'nothing past the commitment for a replayed hash');
  assert.equal(seller.state.requests.filter((r) => r === '/dacs/v1/payments').length, 1, 'only the real payer claimed');
});

test('unavailable SR-2 substrate: the Agreement stays pending and nothing is paid', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-sr2-down' });
  const p = await prepare(buyer, seller, 'sr2-down');
  h.anchors.faults.unavailable = true;
  let signed;
  try {
    ({ signed } = await signAgreement(p, buyer.wallet));
  } finally {
    h.anchors.faults.unavailable = false;
  }
  assert.equal(signed.status, 'agreement_pending');
  assert.equal(signed.evidence.protocol.lastAttempt.outcome, 'indeterminate');
  const resumed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(resumed.status, 'awaiting_approval', JSON.stringify(resumed.protocol?.lastAttempt));
});

test('divergent DACS-5 copy: a seller copy that does not match the buyer copy is rejected', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-divergent' });
  const p = await prepare(buyer, seller, 'divergent');
  const { signed } = await signAgreement(p, buyer.wallet);
  const { reported } = await payCommitted(p, buyer.wallet);
  assert.equal(reported.evidence.protocol.stage, 'awaiting-countersignature');
  h.anchors.faults.alter.set(bundleAddress(signed.evidence.protocol.jobId, 'seller'), (copy) => {
    copy.phaseSummary = copy.phaseSummary.map((entry) => (entry.kind === 'deliver-storage-program' ? { ...entry, outcome: 'fail', errorClass: 'counterparty' } : entry));
    return copy;
  });
  const done = await countersign(p, buyer.wallet);
  assert.equal(done.evidence.protocol.stage, 'bundle-rejected', JSON.stringify(done.evidence.protocol.lastAttempt));
  assert.match(done.evidence.protocol.lastAttempt.reason, /diverge|does not verify|different bundle/);
  assert.equal(done.evidence.protocol.layers.completedCopies, 'not-exchanged');
});

test('hold: without the programmatic dacsProtocol option a protocol purchase is refused and nothing is created', async () => {
  const plain = await startHarness();
  try {
    const user = await linkedUser(plain);
    const wallet = createEphemeralWallet();
    seedSellerListing(plain, wallet, { listingId: 'dacs-held' });
    const refused = await tool(plain, user, 'prepare_purchase', { listingId: 'dacs-held', version: 1, seller: wallet.claim, idempotencyKey: key('held'), protocol: 'dacs-pay-dem' });
    assert.equal(refused.error, 'dacs_protocol_unavailable');
    assert.deepEqual((await tool(plain, user, 'get_account_status')).purchases, []);
  } finally {
    await plain.close();
  }
});

test('legacy purchases are unchanged: no protocol record and the original status vocabulary', async () => {
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: 'dacs-legacy' });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'dacs-legacy', version: 1, seller: seller.wallet.claim, idempotencyKey: key('legacy') });
  assert.equal(p.status, 'awaiting_approval');
  assert.equal(p.protocol, undefined);
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
  const reported = await reportPurchase(h, p.operationId, token, { txHash: h.chain.walletBroadcast(approved.payload) });
  assert.equal(reported.status, 'settled_verified');
  assert.equal(reported.evidence.protocol, undefined);
  assert.ok(!seller.state.requests.length, 'a legacy purchase never contacts a seller agent');
});
