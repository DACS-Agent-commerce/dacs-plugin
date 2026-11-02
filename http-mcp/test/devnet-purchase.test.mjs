// Opt-in complete purchase profile over
// the actual plugin app: OAuth/MCP, portal API, the built-in packaged SDK
// wallet (every buyer signature and one real SDK native send through the
// simulated-loopback relay), a seller agent on its own loopback server, the
// SIMULATED SR-2 fixture substrate and SDK-wire chain fixture. Approvals here
// are synthetic consent callbacks. Every outcome is SIMULATED; nothing is a
// Demos Devnet transaction and node2 is never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetHarness } from './helpers/devnet-purchase-harness.mjs';
import { advancePastFinalizedCommitment } from './helpers/finalized-payment.mjs';
import { addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { linkedUser, tool, tokenFrom } from './helpers/flows.mjs';
import { portalFindHash, installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { DEVNET_PURCHASE_PROFILE, DEVNET_HELD_GATES, DEVNET_TARGET, devnetStageLedger } from '../src/dacs/devnet-purchase-consumer.mjs';
import { PROTOCOL_PROFILE } from '../src/dacs/purchase-protocol.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const post = async (h, path, body) => {
  const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { ...await r.json(), httpStatus: r.status };
};

async function setup(t, options) {
  const h = await startDevnetHarness(options);
  t.after(() => h.close());
  const approvals = [];
  const decision = { allow: true };
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return decision.allow; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const other = await linkedUser(h);
  const sign = async (message) => { const a = await wallet.request({ method: 'sign', params: [message] }); assert.equal(a.success, true); return a.data.signature; };
  const seller = await addSeller(h, { listingId: `devnet-purchase-${++counter}` });
  return { h, wallet, approvals, decision, buyer, other, address, sign, seller,
    prepare: () => tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `devnet-${counter}`, protocol: 'dacs-pay-dem' }) };
}

async function agree(w, p) {
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  const identity = await post(w.h, `/portal/api/purchase/${id}/agreement/identity`, { token, address: w.address });
  assert.equal(identity.httpStatus, 200, JSON.stringify(identity));
  const plan = await post(w.h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await w.sign(identity.signRequest.message) });
  assert.equal(plan.httpStatus, 200, JSON.stringify(plan));
  return post(w.h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: await w.sign(plan.signRequest.agreementMessage), anchorSignature: await w.sign(plan.signRequest.anchorMessage) });
}

async function approveAndHandoff(w, p) {
  const accountId = w.h.app.services.accounts.walletOwner(w.address);
  advancePastFinalizedCommitment(w.h, w.h.app.services.ops.get(accountId, p.operationId));
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  const challenge = await post(w.h, `/portal/api/purchase/${id}/challenge`, { token, address: w.address });
  assert.equal(challenge.httpStatus, 200, JSON.stringify(challenge));
  const approved = await post(w.h, `/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.challengeId, signature: await w.sign(challenge.message) });
  return { challenge, approved };
}

const ledger = (status) => Object.fromEntries(status.protocol.devnet.stages.map((s) => [s.stage, s.status]));

test('accepting (simulated): complete fixed-price purchase with the built-in packaged wallet; every stage reported; restart keeps it; one native send', async (t) => {
  const w = await setup(t);
  const p = await w.prepare();
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const id = p.operationId, token = tokenFrom(p.approvalUrl);
  const op = () => w.h.app.services.ops.get(w.h.app.services.accounts.walletOwner(w.address), id);
  assert.equal(op().terms.protocol.profile, DEVNET_PURCHASE_PROFILE);
  assert.deepEqual([op().terms.protocol.target, op().terms.protocol.targetRpc, op().terms.protocol.targetIdentity, op().terms.protocol.execution],
    ['Demos Devnet', 'https://testnet-rpc.invalid', 'OBSERVED_ONLY_NOT_TRUSTED_PIN', 'simulated-loopback']);
  assert.equal(p.protocol.devnet.stages.filter((s) => s.status === 'held').length, DEVNET_HELD_GATES.length);

  const signed = await agree(w, p);
  assert.equal(signed.status, 'awaiting_approval', JSON.stringify(signed.evidence?.protocol?.lastAttempt));
  const pv = signed.evidence.protocol;
  assert.equal(pv.stage, 'committed'); assert.equal(pv.commitment.signer, w.seller.wallet.claim);

  const { challenge, approved } = await approveAndHandoff(w, p);
  for (const fragment of [`dacs-agreement: ${pv.agreement.hash}`, `dacs-commitment: ${pv.commitment.contentHash}`, `payee: ${w.seller.wallet.address}`, 'amount-os: 2500000000']) assert.ok(challenge.message.includes(fragment), fragment);
  assert.equal(approved.status, 'payment_handoff', JSON.stringify(approved));
  assert.equal(approved.payload.content.to, pv.agreement.payee); assert.equal(approved.payload.content.amount, pv.agreement.price.amountOs);
  const sent = await w.wallet.request({ method: 'sendTransaction', params: [approved.payload] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  const hash = portalFindHash(sent);
  assert.equal(w.h.chain.record.broadcastAttempts.length, 1);
  const shown = w.approvals.find((a) => a.method === 'sendTransaction');
  assert.equal(shown.content.to, approved.payload.content.to); assert.equal(shown.content.amountOs, approved.payload.content.amount);
  const reported = await post(w.h, `/portal/api/purchase/${id}/report`, { token, txHash: hash });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
  assert.equal(reported.evidence.protocol.stage, 'awaiting-countersignature', JSON.stringify(reported.evidence.protocol.lastAttempt));

  const request = await post(w.h, `/portal/api/purchase/${id}/completion/request`, { token });
  const done = await post(w.h, `/portal/api/purchase/${id}/completion/countersign`, { token, bundleSignature: await w.sign(request.signRequest.bundleMessage), anchorSignature: await w.sign(request.signRequest.anchorMessage) });
  assert.equal(done.evidence.protocol.stage, 'completed', JSON.stringify(done.evidence.protocol.lastAttempt));

  const status = await tool(w.h, w.buyer, 'get_purchase_status', { operationId: id });
  const stages = ledger(status);
  for (const s of ['two-party-agreement-anchored', 'seller-finalized-commitment-readback', 'buyer-approved-native-payment-and-readback', 'dacs4-payment-evidence', 'delivery', 'dacs5-two-sided-copies']) assert.equal(stages[s], 'achieved-simulated', s);
  for (const g of DEVNET_HELD_GATES) assert.equal(stages[g.gate], 'held', g.gate);
  assert.equal(status.protocol.devnet.target.identityStatus, DEVNET_TARGET.identityStatus);
  assert.match(status.protocol.limits.execution, /Demos Devnet live execution held/);
  assert.equal(status.protocol.layers.completedCopies, 'both-copies-verified'); assert.equal(status.protocol.layers.humanAcceptance, 'not-recorded');
  assert.equal(w.seller.agent.stageOf(pv.jobId), 'copies-exchanged');

  // Restart over the same database: the receipt and stages survive; recheck sends nothing.
  await w.h.restart();
  const after = await tool(w.h, w.buyer, 'verify_deal', { operationId: id });
  assert.equal(after.protocol.stage, 'completed'); assert.equal(after.status, 'settled_verified');
  assert.equal(w.h.chain.nonceOf(w.address), 1, 'exactly one native transfer'); assert.equal(w.h.chain.record.broadcastAttempts.length, 1);
  const again = await post(w.h, `/portal/api/purchase/${id}/handoff`, { token });
  assert.notEqual(again.httpStatus, 200, 'no second payment handoff after settlement');
  // Owner scope: the other plugin user cannot read or drive this purchase.
  const foreign = await tool(w.h, w.other, 'get_purchase_status', { operationId: id });
  assert.equal(foreign.error, 'not_found');
  t.diagnostic(JSON.stringify({ profile: DEVNET_PURCHASE_PROFILE, execution: 'simulated-loopback', stages, txHash: hash, broadcasts: 1, restarts: w.h.restarts() }));
  assert.deepEqual(externalAttempts, []);
});

test('lifecycle (simulated): payment outcome unknown keeps the issued coordinates across restart, never re-sends, and readback of the wallet hash continues the purchase', async (t) => {
  const w = await setup(t);
  const p = await w.prepare();
  const id = p.operationId, token = tokenFrom(p.approvalUrl);
  assert.equal((await agree(w, p)).status, 'awaiting_approval');
  const { approved } = await approveAndHandoff(w, p);
  assert.equal(approved.status, 'payment_handoff');
  w.h.chain.faults.broadcastMode = 'apply-then-503';
  const sent = await w.wallet.request({ method: 'sendTransaction', params: [approved.payload] });
  w.h.chain.faults.broadcastMode = 'ok';
  assert.equal(sent.success, false); assert.equal(sent.error.code, 'outcome_unknown');
  const hash = sent.data?.hash ?? sent.error?.data?.hash;
  assert.match(String(hash), /^(0x)?[0-9a-f]{64}$/);
  const reported = await post(w.h, `/portal/api/purchase/${id}/report`, { token, walletError: 'Payment outcome unknown; not retried' });
  assert.equal(reported.httpStatus, 200); assert.equal(reported.status, 'payment_handoff');
  await w.h.restart();
  const unsure = await tool(w.h, w.buyer, 'verify_deal', { operationId: id });
  t.diagnostic(`after restart without hash: ${unsure.status} ${JSON.stringify(unsure.verification ?? unsure.error ?? null)}`);
  assert.ok(['payment_uncertain', 'payment_handoff'].includes(unsure.status), JSON.stringify(unsure));
  const second = await post(w.h, `/portal/api/purchase/${id}/handoff`, { token });
  assert.notEqual(second.status, 'payment_handoff', 'no second payment payload is handed out');
  assert.equal(w.h.chain.record.broadcastAttempts.length, 1);
  const settled = await tool(w.h, w.buyer, 'verify_deal', { operationId: id, txHash: hash });
  assert.equal(settled.status, 'settled_verified', JSON.stringify(settled));
  assert.equal(settled.protocol.stage, 'awaiting-countersignature', JSON.stringify(settled.protocol.lastAttempt));
  assert.equal(ledger(settled)['buyer-approved-native-payment-and-readback'], 'achieved-simulated');
  assert.equal(ledger(settled)['dacs5-two-sided-copies'], 'pending');
  assert.equal(w.h.chain.nonceOf(w.address), 1); assert.equal(w.h.chain.record.broadcastAttempts.length, 1);
  assert.equal(w.approvals.filter((a) => a.method === 'sendTransaction').length, 1);
});

test('lifecycle (simulated): restarts after commitment and after the handoff keep the exact issued payment coordinates; the wallet pays once and readback settles', async (t) => {
  const w = await setup(t);
  const p = await w.prepare();
  const id = p.operationId, token = tokenFrom(p.approvalUrl);
  const committed = await agree(w, p);
  assert.equal(committed.evidence.protocol.stage, 'committed');
  await w.h.restart();
  assert.equal((await tool(w.h, w.buyer, 'get_purchase_status', { operationId: id })).protocol.stage, 'committed');
  const { approved } = await approveAndHandoff(w, p);
  assert.equal(approved.status, 'payment_handoff');
  await w.h.restart();
  const retained = await post(w.h, `/portal/api/purchase/${id}/handoff`, { token });
  t.diagnostic(`handoff after restart: ${retained.httpStatus} ${retained.status ?? retained.error}`);
  if (retained.payload) assert.equal(JSON.stringify(retained.payload), JSON.stringify(approved.payload), 'a re-read handoff is the exact issued payload, never a new one');
  const sent = await w.wallet.request({ method: 'sendTransaction', params: [approved.payload] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  const reported = await post(w.h, `/portal/api/purchase/${id}/report`, { token, txHash: portalFindHash(sent) });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
  assert.equal(reported.evidence.protocol.stage, 'awaiting-countersignature');
  assert.equal(w.h.chain.nonceOf(w.address), 1); assert.equal(w.h.chain.record.broadcastAttempts.length, 1);
  assert.equal(w.h.restarts(), 2);
});

test('boundary: the wallet declining the native payment sends nothing and leaves the purchase awaiting a fresh decision', async (t) => {
  const w = await setup(t);
  const p = await w.prepare();
  assert.equal((await agree(w, p)).status, 'awaiting_approval');
  const { approved } = await approveAndHandoff(w, p);
  w.decision.allow = false;
  const sent = await w.wallet.request({ method: 'sendTransaction', params: [approved.payload] });
  assert.equal(sent.success, false); assert.equal(sent.error.code, 'user_rejected');
  assert.equal(w.h.chain.record.broadcastAttempts.length, 0); assert.equal(w.h.chain.nonceOf(w.address), 0);
  const status = await tool(w.h, w.buyer, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(ledger(status)['buyer-approved-native-payment-and-readback'], 'pending');
  assert.notEqual(status.status, 'settled_verified');
});

test('hold: Demos Devnet execution (non-simulated) answers the exact held gates; nothing is prepared or sent', async (t) => {
  const w = await setup(t, { devnetPurchase: { execution: 'devnet' } });
  const p = await w.prepare();
  assert.equal(p.error, 'devnet_execution_held', JSON.stringify(p));
  for (const g of DEVNET_HELD_GATES) assert.match(p.message, new RegExp(g.gate));
  const status = await tool(w.h, w.buyer, 'list_purchases').catch(() => null);
  t.diagnostic(`held: ${p.message}; list: ${JSON.stringify(status?.purchases?.length ?? status?.error ?? null)}`);
  assert.equal(w.h.chain.record.broadcastAttempts.length, 0); assert.equal(w.approvals.filter((a) => a.method === 'sendTransaction').length, 0);
});

test('compatibility: without the capability a dacs-pay-dem purchase keeps the fixture profile and limits', async (t) => {
  const w = await setup(t, { devnetPurchase: null });
  const p = await w.prepare();
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  assert.equal(p.protocol.profile, PROTOCOL_PROFILE); assert.equal(p.protocol.devnet, undefined);
  assert.equal(p.protocol.limits.execution, undefined); assert.equal(p.protocol.limits.substrate, 'simulated-loopback-fixture');
});

test('compatibility: with the capability and the browser broker both configured, an Agreement-only purchase keeps its profile and payment hold', async (t) => {
  const memory = memoryAnchorJournal();
  const w = await setup(t, { browserAgreement: { journal: { ...memory, entries: () => memory.snapshot() } } });
  const p = await tool(w.h, w.buyer, 'prepare_purchase', { listingId: w.seller.published.listingId, version: 1, seller: w.seller.wallet.claim, idempotencyKey: `devnet-sr2-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  assert.equal(p.protocol.profile, 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1'); assert.equal(p.protocol.devnet, undefined);
  assert.equal(p.protocol.limits.payment, 'held');
  const held = await post(w.h, `/portal/api/purchase/${p.operationId}/challenge`, { token: tokenFrom(p.approvalUrl), address: w.address });
  assert.equal(held.error, 'agreement_payment_held');
  assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.h.app.services.accounts.walletOwner(w.address), operationId: p.operationId })).cancelled, true);
  const complete = await w.prepare();
  assert.equal(complete.protocol.profile, DEVNET_PURCHASE_PROFILE, 'the same server still offers the complete profile for dacs-pay-dem');
});

test('the DACS-5 copies stage counts a completed purchase only once its buyer copy was read back', () => {
  // Older code saved the buyer copy reference from the write acknowledgement, without the readback mark.
  const copies = (bundle) => devnetStageLedger({ status: 'settled_verified', state: { protocol: { stage: 'completed', bundle } } }).stages.find((s) => s.stage === 'dacs5-two-sided-copies').status;
  assert.equal(copies({ buyerCopyRef: { ref: 'read-back' }, buyerCopyReadBack: true }), 'achieved-simulated');
  assert.equal(copies({ buyerCopyRef: { ref: 'acknowledgement-only' } }), 'pending');
});

test('malformed capability fails app construction', async () => {
  await assert.rejects(startDevnetHarness({ devnetPurchase: { execution: 'simulated-loopback', live: true } }), /exactly \{ execution/);
});

test('devnet purchase connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
