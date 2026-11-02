// Closure (dashboard D1/F1): the guided tester dashboard on the offline
// launcher, through its public HTTP API, the portal API and the fixture
// chain's public RPC. SIMULATED fixtures only; source-aware; not a security
// review, not live, not ChatGPT.
//
// D1: an identity action that is closed (failed_before_send or cancelled) is
//     finished on the dashboard: it is not listed as unfinished, and pressing
//     Add (or Remove) starts a NEW action with a new key, even when the
//     dashboard's copy was stale. The corrected new action completes in the
//     SAME running launcher.
// F1: a finished purchase (above all a settled one with its receipt) is kept
//     on the dashboard and in the evidence download when Prepare starts the
//     next purchase. A pending repeat still returns the same operation, and a
//     cancelled purchase never acquires a receipt.
//
// The "wallet" is a fresh synthetic ed25519 key standing in for a wallet
// extension (labelled): it signs portal messages and SDK-shaped transactions
// and submits them to the fixture chain (test/helpers/overnight-acceptance-
// dashboard.mjs). Accepting controls run before the regression cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOfflineTester } from '../bin/offline-fixtures/operator.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { act, dashState, evidence, signIn, payFromPortal, portalApi, portalPath, rpc, signTx, submitTx } from './helpers/overnight-acceptance-dashboard.mjs';

let h;
let buyer;
before(async () => {
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  buyer = createEphemeralWallet();
  await signIn(h, 'buyer', buyer);
});
after(async () => {
  await h?.stop();
});

const ok = async (name, args) => {
  const r = await act(h, name, args);
  assert.equal(r.ok, true, `${name}: ${r.error}`);
  return r.state;
};
const twitterAdd = (s) => s.identity.twitter.add;

// Public proof on the fixture proof publisher, signed by the stand-in key
// exactly as the wallet's proof text is (ed25519 over "dw2p").
async function publishProof(kind, username) {
  const res = await fetch(`${h.fixtures.proofs}/api/proofs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, username, proof: `demos:dw2p:ed25519:${buyer.signHex('dw2p')}` }) });
  assert.equal(res.status, 200);
  return (await res.json()).proofUrl;
}

// The stand-in wallet's identity write: one SDK-shaped identity transaction,
// confirmed and broadcast to the fixture chain.
async function walletIdentityWrite(method, payload) {
  const nonce = (await rpc(h.fixtures.chain, { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: buyer.address } }] })).response + 1;
  const content = { type: 'identity', from: buyer.address, to: buyer.address, amount: 0, data: ['identity', { context: 'web2', method, payload }], nonce, timestamp: Date.now(), transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 } };
  const sent = await submitTx(h.fixtures.chain, signTx(buyer, { content }));
  assert.equal(sent.broadcast, true, `identity write not accepted: ${sent.reason}`);
}

// Portal steps for one identity action, as the portal page calls them.
function identityPortal(portalUrl) {
  const { id, token } = portalPath(portalUrl);
  return (step, body = {}) => portalApi(h, `/portal/api/identity/${id}/${step}`, { token, ...body });
}

const KEY_OR_CAPABILITY = /#t=|access_token|refresh_token|Bearer|tester-(buy|add|rm|sell)-|idempotency/i;

// ------------------------------------------------------------------ F1

test('F1 accepting control: pending repeat returns the same purchase; waiting is not completion; approval settles it with a receipt', async () => {
  await ok('find-listing');
  const first = await ok('prepare-purchase');
  assert.equal(first.purchase.status, 'awaiting_approval');
  const again = await ok('prepare-purchase');
  assert.equal(again.purchase.operationId, first.purchase.operationId, 'pending repeat: same operation');
  assert.equal(again.purchase.idempotencyKey, first.purchase.idempotencyKey, 'pending repeat: same key');
  assert.equal(again.purchase.replayed, true);
  assert.equal((await ok('refresh-receipt')).purchase.receipt, null, 'no receipt while waiting');
  const paid = await payFromPortal(h, buyer, first.purchase.approvalUrl);
  assert.equal(paid.report.status, 'settled_verified');
  const settled = await ok('refresh-receipt');
  assert.equal(settled.purchase.status, 'settled_verified');
  assert.equal(settled.purchase.receipt.txHash.replace(/^0x/, ''), paid.sent.txHash.replace(/^0x/, ''));
  assert.deepEqual(settled.unfinished, []);
});

test('F1 regression: Prepare after a settled purchase keeps the settled purchase and its receipt on the dashboard and in the evidence download', async () => {
  const before = (await dashState(h)).purchase;
  assert.equal(before.status, 'settled_verified', 'precondition: the settled purchase with its receipt is shown');
  const next = await ok('prepare-purchase');
  assert.equal(next.purchase.status, 'awaiting_approval', 'Prepare starts the next purchase');
  assert.notEqual(next.purchase.operationId, before.operationId);
  const kept = next.completedPurchases ?? [];
  assert.equal(kept.length, 1, 'the settled purchase is kept');
  assert.equal(kept[0].operationId, before.operationId);
  assert.equal(kept[0].status, 'settled_verified');
  assert.deepEqual(kept[0].receipt, before.receipt, 'with the receipt the dashboard showed');
  assert.deepEqual(kept[0].terms, before.terms);
  assert.equal(Object.hasOwn(kept[0], 'idempotencyKey'), false, 'no idempotency key kept');
  assert.equal(Object.hasOwn(kept[0], 'approvalUrl'), false, 'no portal capability kept');
  const ev = await evidence(h);
  const e = ev.json.evidence;
  assert.equal(e.buyer.purchase.status, 'awaiting_approval');
  assert.equal(e.buyer.purchase.receipt.observed, false);
  assert.equal(e.buyer.completedPurchases.length, 1);
  assert.equal(e.buyer.completedPurchases[0].operationId, before.operationId);
  assert.equal(e.buyer.completedPurchases[0].status, 'settled_verified');
  assert.equal(e.buyer.completedPurchases[0].receipt.observed, true);
  assert.equal(e.buyer.completedPurchases[0].receipt.txHash, before.receipt.txHash);
  assert.doesNotMatch(ev.text, KEY_OR_CAPABILITY, 'evidence carries no key or capability');
  assert.ok(!ev.text.includes(next.purchase.idempotencyKey) && !ev.text.includes(before.idempotencyKey));
});

test('F1: a cancelled purchase never acquires a receipt, and is kept as cancelled when the next one is prepared', async () => {
  const cancelled = await ok('cancel-purchase');
  assert.equal(cancelled.purchase.status, 'cancelled');
  assert.equal(cancelled.purchase.receipt, null);
  const next = await ok('prepare-purchase');
  assert.equal(next.purchase.status, 'awaiting_approval');
  const kept = next.completedPurchases ?? [];
  assert.deepEqual(kept.map((p) => p.status), ['settled_verified', 'cancelled']);
  assert.equal(kept[1].receipt, null, 'cancelled: no receipt');
  const e = (await evidence(h)).json.evidence;
  assert.deepEqual(e.buyer.completedPurchases.map((p) => [p.status, p.receipt.observed]), [['settled_verified', true], ['cancelled', false]]);
});

test('F1: a purchase settled behind a stale dashboard keeps its receipt, read once, when the next one is prepared', async () => {
  const pending = (await dashState(h)).purchase;
  assert.equal(pending.status, 'awaiting_approval');
  const paid = await payFromPortal(h, buyer, pending.approvalUrl);
  assert.equal(paid.report.status, 'settled_verified');
  // The dashboard was not refreshed: it still shows awaiting_approval, so this
  // Prepare is the pending repeat (same key) and comes back settled.
  const replay = await ok('prepare-purchase');
  assert.equal(replay.purchase.operationId, pending.operationId);
  assert.equal(replay.purchase.status, 'settled_verified');
  const next = await ok('prepare-purchase');
  assert.equal(next.purchase.status, 'awaiting_approval');
  const kept = (next.completedPurchases ?? []).at(-1);
  assert.equal(kept?.operationId, pending.operationId);
  assert.equal(kept?.status, 'settled_verified');
  assert.equal(kept?.receipt?.txHash?.replace(/^0x/, ''), paid.sent.txHash.replace(/^0x/, ''), 'the receipt was read before keeping it');
  await ok('cancel-purchase');
});

// ------------------------------------------------------------------ D1

test('D1 accepting control: Add while the action is still open returns the same action (same key and link)', async () => {
  const first = await ok('identity-add', { kind: 'twitter' });
  assert.match(twitterAdd(first).status, /^(prepared|awaiting_wallet)$/);
  const again = await ok('identity-add', { kind: 'twitter' });
  assert.equal(twitterAdd(again).operationId, twitterAdd(first).operationId);
  assert.equal(twitterAdd(again).portalUrl, twitterAdd(first).portalUrl);
  assert.ok(again.unfinished.some((u) => u.step === 'identity-twitter-add'), 'an open action is unfinished');
});

test('D1: an action cancelled on its portal page is finished on the dashboard, and Add starts a new one', async () => {
  const open = twitterAdd(await dashState(h));
  const portal = identityPortal(open.portalUrl);
  assert.equal((await portal('cancel')).status, 'cancelled');
  const refreshed = await ok('refresh-identities');
  assert.equal(twitterAdd(refreshed).status, 'cancelled');
  assert.equal(refreshed.unfinished.some((u) => u.step === 'identity-twitter-add'), false, 'a cancelled action is not unfinished');
  const next = await ok('identity-add', { kind: 'twitter' });
  assert.notEqual(twitterAdd(next).operationId, open.operationId, 'a NEW action');
  assert.notEqual(twitterAdd(next).portalUrl, open.portalUrl);
  assert.match(twitterAdd(next).status, /^(prepared|awaiting_wallet)$/);
});

test('D1 regression: after a pre-send wallet failure, one Add press starts a new action even when the dashboard copy is stale; the corrected action completes in the same run', async () => {
  const handle = `cd_tw_${Math.random().toString(36).slice(2, 7)}`;
  const failedOp = twitterAdd(await dashState(h));
  const portal = identityPortal(failedOp.portalUrl);
  await portal('view');
  await portal('connected', { address: buyer.address });
  assert.equal((await portal('proof', { proofUrl: `https://x.com/${handle}/status/1234567` })).status, 'review');
  await portal('request');
  const reported = await portal('report', { outcome: { success: false, code: 'upstream_unavailable', message: 'the configured Demos node did not answer getTweet; nothing was signed', wallet: 'embedded' } });
  assert.equal(reported.status, 'failed_before_send');

  // No "Refresh identities": the dashboard still holds the old status.
  assert.match(twitterAdd(await dashState(h)).status, /^(prepared|awaiting_wallet)$/, 'precondition: stale dashboard copy');
  const next = await ok('identity-add', { kind: 'twitter' });
  const fresh = twitterAdd(next);
  assert.notEqual(fresh.operationId, failedOp.operationId, 'one press gives a NEW action, not the closed one');
  assert.notEqual(fresh.portalUrl, failedOp.portalUrl);
  assert.match(fresh.status, /^(prepared|awaiting_wallet)$/);
  assert.equal(next.identity.error, null);

  // Corrected: the proof is published; the stand-in wallet writes once.
  const proofUrl = await publishProof('twitter', handle);
  const p2 = identityPortal(fresh.portalUrl);
  await p2('view');
  await p2('connected', { address: buyer.address });
  assert.equal((await p2('proof', { proofUrl })).status, 'review');
  const asked = await p2('request');
  assert.deepEqual(asked.walletRequest, { method: 'addTwitterIdentity', params: [proofUrl] });
  await walletIdentityWrite('web2_identity_assign', { context: 'twitter', username: handle, proof: proofUrl });
  assert.equal((await p2('report', { outcome: { success: true, wallet: 'extension' } })).status, 'association_observed');
  const done = await ok('refresh-identities');
  assert.equal(twitterAdd(done).status, 'association_observed');
  assert.deepEqual(done.identity.observed.twitterHandles, [handle]);
  assert.deepEqual(done.unfinished, []);
  const e = (await evidence(h)).json.evidence;
  assert.equal(e.identity.twitterAdd.status, 'association_observed');
});

test('D1: Remove for the same handle after a cancelled removal starts a new removal', async () => {
  const handle = (await dashState(h)).identity.observed.twitterHandles[0];
  const first = (await ok('identity-remove', { kind: 'twitter', username: handle })).identity.twitter.remove;
  assert.equal((await identityPortal(first.portalUrl)('cancel')).status, 'cancelled');
  // Stale copy again: one press gives a new removal.
  const next = (await ok('identity-remove', { kind: 'twitter', username: handle })).identity.twitter.remove;
  assert.notEqual(next.operationId, first.operationId);
  assert.match(next.status, /^(prepared|awaiting_wallet)$/);
});

test('F1/D1: Start over as a new buyer keeps the finished purchases with the earlier session', async () => {
  const before = await dashState(h);
  assert.ok((before.completedPurchases ?? []).length >= 3);
  const out = await ok('buyer-start-over');
  assert.deepEqual(out.completedPurchases, []);
  const earlier = out.earlier.buyer.at(-1);
  assert.deepEqual(earlier.completedPurchases.map((p) => [p.operationId, p.status, p.receiptObserved]), before.completedPurchases.map((p) => [p.operationId, p.status, Boolean(p.receipt)]));
  const e = (await evidence(h)).json.evidence;
  assert.equal(e.earlier.buyer.at(-1).completedPurchases.length, before.completedPurchases.length);
  assert.doesNotMatch(JSON.stringify(out.earlier), KEY_OR_CAPABILITY);
});
