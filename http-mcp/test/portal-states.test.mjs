// Regressions for the source-blind functional findings F1-F10 (2026-10-01
// 15:14 UTC): truthful evidence labels, validation, link states, status text,
// eligibility fields, saved coordinates, receipts, pre-signature re-checks and
// full seller review data. SIMULATED fixture chain/directory/wallet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, toolRaw, portal, seedSellerListing, approvePurchase, reportPurchase, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { linkToken } from '../src/portal/routes.mjs';
import { readFileSync } from 'node:fs';

let h;
let seller;
let n = 0;
const key = (l) => `fx-${l}-${++n}-${Date.now()}`;
before(async () => {
  h = await startHarness();
  seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'fx-report', price: '3' });
});
after(async () => h.close());
const coords = (listingId = 'fx-report') => ({ listingId, version: 1, seller: seller.claim });

test('portal shell is byte-identical while off and advertises report rendering only when enabled', async (t) => {
  const page = readFileSync(new URL('../public/portal/index.html', import.meta.url), 'utf8');
  assert.equal(await fetch(`${h.origin}/portal/purchase/TEST`).then((r) => r.text()), page);
  const on = await startHarness({ env: { DACS_SHOWCASE_REPORT_VIEW: '1' } }); t.after(() => on.close());
  assert.equal(await fetch(`${on.origin}/portal/purchase/TEST`).then((r) => r.text()), page.replace('<body>', '<body data-showcase-report-view="1">'));
  const asset = await fetch(`${on.origin}/portal/assets/purchased-report.mjs`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /export function renderPurchasedReport/);
});

test('F1/F8: purchase portal views carry recorded evidence and a real receipt', async () => {
  const u = await linkedUser(h);
  const p = await tool(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: key('receipt') });
  const before = await portal(h, `/portal/api/purchase/${p.operationId}/view`, { token: tokenFrom(p.approvalUrl) });
  assert.equal(before.evidence.listingMode, 'simulated-fixture');
  assert.equal(before.evidence.simulated, true);
  assert.equal(before.evidence.receipt, null);
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, u.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  const settled = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(settled.status, 'settled_verified');
  assert.equal(settled.evidence.receipt.txHash, hash);
  assert.equal(settled.evidence.receipt.chainMode, 'simulated-fixture');
  assert.equal(settled.evidence.receipt.amountOs, '3000000000');
  assert.ok(Number.isInteger(settled.evidence.receipt.blockNumber));
  assert.match(settled.evidence.next, /SIMULATED/);
  assert.equal(settled.evidence.actionable, false);
});

test('F4: replays of non-actionable purchases never re-invite approval or payment', async () => {
  const u = await linkedUser(h);
  const k = key('replay-cancel');
  const p = await tool(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  assert.equal((await tool(h, u, 'cancel_wallet_handoff', { operationId: p.operationId })).status, 'cancelled');
  const replay = await toolRaw(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  assert.equal(replay.structuredContent.status, 'cancelled');
  assert.equal(replay.structuredContent.approvalUrl, null);
  assert.doesNotMatch(replay.content[0].text, /Prepared|not approved|Approve/i);
  assert.match(replay.content[0].text, /Existing purchase .* is cancelled/);

  const k2 = key('replay-reported');
  const q = await tool(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: k2 });
  const { approved, token } = await approvePurchase(h, q.operationId, q.approvalUrl, u.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  h.chain.faults.pendingHashes.add(hash);
  assert.equal((await reportPurchase(h, q.operationId, token, { txHash: hash })).status, 'broadcast_reported');
  const replay2 = await toolRaw(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: k2 });
  assert.equal(replay2.structuredContent.status, 'broadcast_reported');
  assert.equal(replay2.structuredContent.approvalUrl, null);
  assert.doesNotMatch(replay2.content[0].text, /Approve in your wallet/);
  assert.equal((await tool(h, u, 'get_purchase_status', { operationId: q.operationId })).approvalUrl, null);
  h.chain.faults.pendingHashes.delete(hash);
  assert.equal((await tool(h, u, 'verify_deal', { operationId: q.operationId })).status, 'settled_verified');
});

test('F5: application eligibility is explicit and separate from the SDK reader disposition', async () => {
  const other = createEphemeralWallet();
  const { listing, locator } = seedSellerListing(h, other, { listingId: 'fx-foreign-owner' });
  h.chain.seedStorage(locator, { data: listing, owner: createEphemeralWallet().address });
  const v = await toolRaw(h, null, 'get_listing', { listingId: 'fx-foreign-owner', version: 1, seller: other.claim });
  const out = v.structuredContent;
  assert.equal(out.transactable, false);
  assert.equal(out.eligibility, 'not-transactable');
  assert.equal(out.standardReaderInput, 'chain-readback');
  assert.ok(out.checks.find((c) => c.name === 'chain-anchor-owner-is-seller' && !c.ok));
  assert.match(v.content[0].text, /^Not transactable: .*is not purchase eligibility/);
  const ok = (await toolRaw(h, null, 'get_listing', coords())).structuredContent;
  assert.equal(ok.eligibility, 'transactable');
  assert.equal(ok.disposition, 'verified');
});

test('F9: a price change before approval returns terms_changed without issuing a challenge', async () => {
  const u = await linkedUser(h);
  const { listing, locator } = seedSellerListing(h, seller, { listingId: 'fx-volatile', price: '2' });
  const p = await tool(h, u, 'prepare_purchase', { ...coords('fx-volatile'), idempotencyKey: key('preflight') });
  h.chain.faults.alterStorage.set(locator, { ...listing, pricing: { kind: 'fixed', price: { amount: '20', currency: 'DEM' } } });
  const token = tokenFrom(p.approvalUrl);
  const c = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token, address: u.wallet.address });
  assert.equal(c.error, 'terms_changed');
  assert.equal(c.challengeId, undefined);
  assert.equal(h.app.db.prepare("SELECT COUNT(*) AS c FROM challenges WHERE purpose = 'approve-purchase' AND binding LIKE ?").get(`%${p.operationId}%`).c, 0);
  assert.equal((await portal(h, `/portal/api/purchase/${p.operationId}/view`, { token })).status, 'terms_changed');
  h.chain.faults.alterStorage.delete(locator);
  // Unavailability during the preflight changes nothing and signs nothing.
  const q = await tool(h, u, 'prepare_purchase', { ...coords(), idempotencyKey: key('preflight-down') });
  h.chain.faults.unavailable = true;
  try {
    const d = await portal(h, `/portal/api/purchase/${q.operationId}/challenge`, { token: tokenFrom(q.approvalUrl), address: u.wallet.address });
    assert.equal(d.error, 'listing_recheck_unavailable');
  } finally {
    h.chain.faults.unavailable = false;
  }
  assert.equal((await portal(h, `/portal/api/purchase/${q.operationId}/view`, { token: tokenFrom(q.approvalUrl) })).status, 'awaiting_approval');
});

test('F3: link status is truthful for valid, used, expired and invalid links', async () => {
  const u = await linkedUser(h);
  const link = (await tool(h, u, 'start_wallet_link')).linkUrl;
  const f = new URLSearchParams(new URL(link).hash.slice(1));
  const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
  const valid = await portal(h, '/portal/api/link/view', body);
  assert.equal(valid.state, 'valid');
  assert.equal(valid.accountId, body.accountId);
  const w = createEphemeralWallet();
  const c = await portal(h, '/portal/api/link/challenge', { ...body, address: w.address });
  assert.equal((await portal(h, '/portal/api/link/complete', { ...body, challengeId: c.challengeId, signature: w.signHex(c.message) })).status, 200);
  const used = await portal(h, '/portal/api/link/view', body);
  assert.deepEqual(used, { status: 200, state: 'used' }, 'no account or expiry is echoed for a used link');
  assert.equal((await portal(h, '/portal/api/link/view', { ...body, token: 'x'.repeat(43) })).state, 'invalid');
  assert.equal((await portal(h, '/portal/api/link/view', {})).state, 'invalid');
  const past = Date.now() - 1000;
  const nonce = 'A'.repeat(22);
  const expired = await portal(h, '/portal/api/link/view', { accountId: body.accountId, expires: past, nonce, token: linkToken(h.app.services.linkSecret, body.accountId, past, nonce) });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.accountId, undefined);
});
