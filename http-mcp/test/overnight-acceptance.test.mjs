// Overnight ORDINARY functional acceptance (SIMULATED fixtures only), at the
// MCP + portal API level. Source-aware; NOT a security review, NOT live
// Demos testnet, NOT ChatGPT, NOT full v0.1 acceptance.
//
// Every expected value is derived from the public tool contract and from
// 1 DEM = 10^9 OS, not copied from the plugin's answers. Every rejection case
// sits next to an otherwise-identical accepting control. Clause map:
// docs/OVERNIGHT-FUNCTIONAL-TESTS.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, portal, tokenFrom, seedSellerListing } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import {
  IDENTITY_WRITE_SCOPE, unique, demToOs, call, ok, isInputRejection, approveAndPay,
  chainTransfer, identityPortal, observedHandles,
} from './helpers/overnight-acceptance-flows.mjs';

let h;
before(async () => {
  h = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only' } });
});
after(async () => h.close());

test('OA-N0 control: the independent DEM->OS conversion matches the denomination rule', () => {
  assert.equal(demToOs('1'), '1000000000');
  assert.equal(demToOs('1.5'), '1500000000');
  assert.equal(demToOs('0.000000001'), '1');
  assert.equal(demToOs('3.141592653'), '3141592653');
  assert.equal(demToOs('12.07'), '12070000000');
  assert.throws(() => demToOs('1.0000000001'));
});

// Oracle witnesses: the shared classifiers cannot mistake success or a domain
// error for an input rejection, an unknown hash yields no transfer, and a
// transfer the chain reports as failed never satisfies the "settled" oracle.
test('OA-N0b oracle witnesses: classification, missing transfer, failed-on-chain transfer is not settled', async () => {
  assert.equal(isInputRejection({ kind: 'ok', data: { error: 'looks like an error' } }), false, 'success is never an input rejection');
  assert.equal(isInputRejection({ kind: 'tool_error', code: 'not_found', message: 'invalid thing' }), false, 'a coded domain error is not an input rejection');
  assert.equal(isInputRejection({ kind: 'tool_error', code: null, message: 'MCP error -32602: Input validation error: Invalid arguments' }), true);
  assert.equal(chainTransfer(h, 'f'.repeat(64)), null, 'an unknown hash has no transfer');
  const s = createEphemeralWallet();
  const listingId = unique('oa-wit');
  seedSellerListing(h, s, { listingId, price: '0.7' });
  const buyer = await linkedUser(h);
  const prepared = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: s.claim, idempotencyKey: unique('oa-wit-buy') });
  const token = tokenFrom(prepared.approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${prepared.operationId}/challenge`, { token, address: buyer.wallet.address });
  const approved = await portal(h, `/portal/api/purchase/${prepared.operationId}/approve`, { token, challengeId: challenge.challengeId, signature: buyer.wallet.signHex(challenge.message) });
  const txHash = h.chain.walletBroadcast(approved.payload, { failOnChain: true }); // the chain reports this transfer failed
  const reported = await portal(h, `/portal/api/purchase/${prepared.operationId}/report`, { token, txHash });
  assert.notEqual(reported.status, 'settled_verified', 'a failed transfer never satisfies the settled oracle');
  const status = await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  // The plugin keeps a chain-reported failure non-final (payment_uncertain);
  // the contract point checked here is only that it is not settled.
  assert.notEqual(status.status, 'settled_verified');
  assert.equal(status.settlement, null);
});

// Dynamic listing change: the buyer's prepared terms are bound; a changed
// title/price on chain stops the approval before any signature, and a new
// purchase shows and pays the NEW terms. A different seller address for the
// same listing id is a different listing with its own payee.
test('OA-N2 a listing changed after prepare is not approvable (terms_changed, nothing signed); the new terms and a new seller address are shown and paid', async () => {
  const sellerA = createEphemeralWallet();
  const buyer = await linkedUser(h);
  const listingId = unique('oa-dyn');
  seedSellerListing(h, sellerA, { listingId, price: '2', title: 'Dynamic v1 title' });
  const first = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: sellerA.claim, idempotencyKey: unique('oa-dyn1') });
  assert.equal(first.terms.amountOs, demToOs('2'));

  // Seller re-publishes the same coordinates with a new title and price.
  seedSellerListing(h, sellerA, { listingId, price: '2.75', title: 'Dynamic v1 RETITLED' });
  const changed = await approveAndPay(h, buyer, first);
  assert.equal(changed.stage, 'challenge', 'no signature is requested for changed terms');
  assert.equal(changed.challenge.error, 'terms_changed');
  const after1 = await ok(h, buyer, 'get_purchase_status', { operationId: first.operationId });
  assert.equal(after1.status, 'terms_changed');
  assert.equal(after1.approval, null);
  assert.equal(after1.settlement, null);
  assert.equal(after1.approvalUrl, null, 'a terms_changed purchase offers no approval link');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0, 'nothing was sent');

  // The buyer now sees and pays the new terms.
  const v2 = await ok(h, null, 'get_listing', { listingId, version: 1, seller: sellerA.claim });
  assert.equal(sellerValue(v2.title), 'Dynamic v1 RETITLED');
  assert.equal(v2.price.amountOs, demToOs('2.75'));
  const second = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: sellerA.claim, idempotencyKey: unique('oa-dyn2') });
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(second.terms.amountOs, demToOs('2.75'));
  const paid = await approveAndPay(h, buyer, second);
  assert.equal(paid.reported?.status, 'settled_verified', JSON.stringify(paid).slice(0, 300));
  assert.equal(chainTransfer(h, paid.txHash).amount, demToOs('2.75'));
  assert.equal(chainTransfer(h, paid.txHash).to, sellerA.address);

  // Same listing id, different seller wallet: its own payee and price.
  const sellerB = createEphemeralWallet();
  seedSellerListing(h, sellerB, { listingId, price: '0.9', title: 'Dynamic other seller' });
  const third = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: sellerB.claim, idempotencyKey: unique('oa-dyn3') });
  assert.equal(third.terms.payee, sellerB.address);
  assert.notEqual(third.terms.payee, sellerA.address);
  const paidB = await approveAndPay(h, buyer, third);
  assert.equal(paidB.reported?.status, 'settled_verified');
  assert.deepEqual([chainTransfer(h, paidB.txHash).to, chainTransfer(h, paidB.txHash).amount, chainTransfer(h, paidB.txHash).nonce], [sellerB.address, demToOs('0.9'), 2]);
});

// C2 at the API level: GitHub and Twitter, add then remove, with readback.
for (const [kind, proofFor, wrongHostProof] of [
  ['github', (handle) => `https://gist.github.com/${handle}/0123456789abcdef`, (handle) => `https://x.com/${handle}/status/1`],
  ['twitter', (handle) => `https://x.com/${handle}/status/1234567`, (handle) => `https://gist.github.com/${handle}/abc`],
]) {
  test(`OA-N3 ${kind}: add (proof -> review -> one wallet request -> association observed) then remove (removal observed), readback changes`, async () => {
    const user = await linkedUser(h, IDENTITY_WRITE_SCOPE);
    const address = user.wallet.address;
    // Valid handle shapes per platform: GitHub allows hyphens (no
    // underscores; the proof step refuses them), X allows underscores.
    const rand = Math.random().toString(36).slice(2, 8);
    const handle = kind === 'github' ? `oa-github-${rand}` : `oa_${kind}_${rand}`;
    assert.deepEqual(observedHandles(await ok(h, user, 'get_identities'), address, kind), [], 'precondition: none linked');

    const add = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-add'), action: 'add', kind });
    assert.equal(add.status, 'prepared');
    const p = identityPortal(h, add);
    assert.equal((await p.step('view')).body.status, 'awaiting_wallet');
    assert.equal((await p.step('connected', { address })).body.status, 'awaiting_public_proof');
    // Ordinary input errors, each followed by the accepting control.
    for (const bad of ['', 'not a url', wrongHostProof(handle)]) {
      const r = await p.step('proof', { proofUrl: bad });
      assert.ok(r.http >= 400 && typeof r.body.error === 'string', `proof "${bad}" is rejected with an error code (got ${r.http} ${JSON.stringify(r.body).slice(0, 120)})`);
      assert.equal((await p.step('view')).body.status, 'awaiting_public_proof', `proof "${bad}" leaves the step unchanged`);
    }
    const review = await p.step('proof', { proofUrl: proofFor(handle) });
    assert.equal(review.body.status, 'review');
    assert.equal(review.body.username, handle);
    const asked = await p.step('request');
    assert.equal(asked.body.walletRequest.method, kind === 'github' ? 'addGithubIdentity' : 'addTwitterIdentity');
    assert.deepEqual(asked.body.walletRequest.params, [proofFor(handle)]);
    // Not yet observed: a wallet "success" without chain evidence is not completion.
    const early = await p.step('report', { outcome: { success: true, dataSha256: 'b'.repeat(64) } });
    assert.notEqual(early.body.status, 'association_observed', 'a wallet success report alone is not an observed association');
    h.chain.seedWeb2Identity(address, kind, { username: handle, proof: proofFor(handle) }); // SIMULATED wallet broadcast lands
    assert.equal((await p.step('view')).body.status, 'association_observed');
    assert.deepEqual(observedHandles(await ok(h, user, 'get_identities'), address, kind), [handle]);

    // Remove: a handle that is not linked is an ordinary input error; the linked one is accepted.
    const notLinked = await call(h, user, 'start_identity_action', { idempotencyKey: unique('oa-rm0'), action: 'remove', kind, username: 'someone_else' });
    assert.equal(notLinked.code, 'identity_not_associated');
    const rm = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-rm'), action: 'remove', kind, username: handle });
    const r = identityPortal(h, rm);
    await r.step('view');
    assert.equal((await r.step('connected', { address })).body.status, 'review');
    const rmAsked = await r.step('request');
    assert.deepEqual(rmAsked.body.walletRequest, { method: 'removeWeb2Identity', params: [{ context: kind, username: handle }] });
    h.chain.removeWeb2Identity(address, kind, handle); // SIMULATED wallet broadcast lands
    const removed = await r.step('report', { outcome: { success: true } });
    assert.equal(removed.body.status, 'removal_observed');
    assert.deepEqual(observedHandles(await ok(h, user, 'get_identities'), address, kind), []);
    const account = await ok(h, user, 'get_account_status');
    assert.deepEqual(account.wallets.map((w) => w.address), [address], 'removal does not unlink the wallet');
  });
}

test('OA-N3b a rejected identity approval is rejected_before_send and changes nothing; invalid handle input is refused', async () => {
  const user = await linkedUser(h, IDENTITY_WRITE_SCOPE);
  const start = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-rej'), action: 'add', kind: 'twitter' });
  const p = identityPortal(h, start);
  await p.step('view');
  await p.step('connected', { address: user.wallet.address });
  await p.step('proof', { proofUrl: 'https://x.com/oa_rejecter/status/42' });
  await p.step('request');
  const rejected = await p.step('report', { outcome: { success: false, code: 'USER_REJECTED', message: 'User rejected' } });
  assert.equal(rejected.body.status, 'rejected_before_send');
  assert.deepEqual(observedHandles(await ok(h, user, 'get_identities'), user.wallet.address, 'twitter'), []);
  // Input errors for the remove handle: schema-invalid characters and empty, vs a valid control.
  for (const username of ['bad handle!', '', 'x'.repeat(40)]) {
    const r = await call(h, user, 'start_identity_action', { idempotencyKey: unique('oa-badh'), action: 'remove', kind: 'twitter', username });
    assert.ok(isInputRejection(r), `username ${JSON.stringify(username)} rejected as input (got ${r.kind} ${r.code})`);
  }
  const control = await call(h, user, 'start_identity_action', { idempotencyKey: unique('oa-badh'), action: 'remove', kind: 'twitter', username: 'valid_but_absent' });
  assert.equal(control.code, 'identity_not_associated', 'a well-formed handle passes input validation and reaches the domain check');
});

// C5 at the API level: interruptions and restarts never duplicate or invent outcomes.
test('OA-N4a restart during payment handoff: same payload re-issued, one transfer, settled only after readback', async () => {
  const s = createEphemeralWallet();
  const listingId = unique('oa-rst');
  seedSellerListing(h, s, { listingId, price: '1.2' });
  const buyer = await linkedUser(h);
  const key = unique('oa-rst-buy');
  const prepared = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: s.claim, idempotencyKey: key });
  const token = tokenFrom(prepared.approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${prepared.operationId}/challenge`, { token, address: buyer.wallet.address });
  const approved = await portal(h, `/portal/api/purchase/${prepared.operationId}/approve`, { token, challengeId: challenge.challengeId, signature: buyer.wallet.signHex(challenge.message) });
  assert.equal(approved.status, 'payment_handoff');

  await h.restart();
  const mid = await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  assert.equal(mid.status, 'payment_handoff', 'state survives restart; not settled');
  assert.equal(mid.settlement, null);
  const again = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: s.claim, idempotencyKey: key });
  assert.equal(again.operationId, prepared.operationId, 'same key returns the same operation after restart');
  assert.equal(again.created, false);
  const reissued = await portal(h, `/portal/api/purchase/${prepared.operationId}/handoff`, { token });
  assert.deepEqual(reissued.payload, approved.payload, 'the identical payload is re-issued, not a new one');

  const txHash = h.chain.walletBroadcast(reissued.payload);
  await h.restart(); // the wallet's report is lost with the restart
  const unreported = await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  assert.notEqual(unreported.status, 'settled_verified', 'an unreported broadcast is not shown as settled before readback');
  const verified = await ok(h, buyer, 'verify_deal', { operationId: prepared.operationId, txHash });
  assert.equal(verified.status, 'settled_verified');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 1, 'exactly one transfer');
  const afterHandoff = await portal(h, `/portal/api/purchase/${prepared.operationId}/handoff`, { token });
  assert.equal(afterHandoff.payload ?? null, null, 'no second payload once settled');
});

test('OA-N4b wallet rejection and cancellation are terminal and truthful across restart', async () => {
  const s = createEphemeralWallet();
  const listingId = unique('oa-cxl');
  seedSellerListing(h, s, { listingId, price: '0.4' });
  const buyer = await linkedUser(h);
  const prepared = await ok(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: s.claim, idempotencyKey: unique('oa-cxl-buy') });
  const token = tokenFrom(prepared.approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${prepared.operationId}/challenge`, { token, address: buyer.wallet.address });
  await portal(h, `/portal/api/purchase/${prepared.operationId}/approve`, { token, challengeId: challenge.challengeId, signature: buyer.wallet.signHex(challenge.message) });
  // The person rejects the transfer in the wallet.
  await portal(h, `/portal/api/purchase/${prepared.operationId}/report`, { token, walletError: 'User rejected the request' });
  const rejected = await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  assert.notEqual(rejected.status, 'settled_verified');
  assert.equal(rejected.settlement, null);
  const cancelled = await ok(h, buyer, 'cancel_wallet_handoff', { operationId: prepared.operationId });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, 'cancelled');
  await h.restart();
  const later = await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  assert.equal(later.status, 'cancelled');
  assert.equal(later.approvalUrl, null);
  const reopen = await portal(h, `/portal/api/purchase/${prepared.operationId}/handoff`, { token });
  assert.ok(!reopen.payload, 'a cancelled purchase hands out no payload');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 0, 'nothing was sent');
  // A typo'd transaction hash is an input error and changes nothing.
  const typo = await call(h, buyer, 'verify_deal', { operationId: prepared.operationId, txHash: 'abc123' });
  assert.ok(isInputRejection(typo), `typo hash rejected as input (got ${typo.kind} ${typo.code})`);
  assert.equal((await ok(h, buyer, 'get_purchase_status', { operationId: prepared.operationId })).status, 'cancelled');
});

test('OA-N5b prepare_purchase: short key, unknown listing, reused key and self-purchase are refused; the valid control prepares', async () => {
  const s = await linkedUser(h);
  const listingId = unique('oa-in');
  seedSellerListing(h, s.wallet, { listingId, price: '0.3' });
  const buyer = await linkedUser(h);
  const args = (o = {}) => ({ listingId, version: 1, seller: s.wallet.claim, idempotencyKey: unique('oa-in-buy'), ...o });
  assert.ok(isInputRejection(await call(h, buyer, 'prepare_purchase', args({ idempotencyKey: 'short' }))), 'a 5-character key is refused');
  assert.equal((await call(h, buyer, 'prepare_purchase', args({ listingId: unique('oa-none') }))).code, 'listing_not_transactable');
  assert.equal((await call(h, buyer, 'prepare_purchase', args({ version: 2 }))).code, 'listing_not_transactable');
  assert.equal((await call(h, s, 'prepare_purchase', args())).code, 'self_purchase');
  const key = unique('oa-in-key');
  const control = await ok(h, buyer, 'prepare_purchase', args({ idempotencyKey: key }));
  assert.equal(control.status, 'awaiting_approval');
  assert.equal(control.created, true);
  const other = createEphemeralWallet();
  const otherId = unique('oa-in2');
  seedSellerListing(h, other, { listingId: otherId, price: '0.3' });
  assert.equal((await call(h, buyer, 'prepare_purchase', { listingId: otherId, version: 1, seller: other.claim, idempotencyKey: key })).code, 'idempotency_conflict');
  const replay = await ok(h, buyer, 'prepare_purchase', args({ idempotencyKey: key }));
  assert.equal(replay.operationId, control.operationId);
  assert.equal(replay.created, false);
});
