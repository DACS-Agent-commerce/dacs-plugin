// Closure acceptance (F1): finished purchases stay visible on the guided
// dashboard and in the evidence download when the buyer prepares another one.
// Node consumer of the dashboard's PUBLIC HTTP interface (/tester/api/*), the
// purchase portal API and the fixture chain's public RPC on the offline
// launcher. SIMULATED fixtures only; the buyer "wallet" is a synthetic
// extension-wallet stand-in (labelled). Source-aware ordinary functional
// testing: NOT a security review, NOT live Demos testnet, NOT ChatGPT, NOT
// full v0.1 acceptance.
//
// Expected results come from the behaviour contract (C5: terminal
// completed/cancelled states stay truthful and are not duplicated; C7: the
// evidence file reflects the actual user actions and carries no secrets) and
// docs/OVERNIGHT-UI.md C5 step 3 / C7: after a settled purchase, Prepare again
// starts a NEW purchase (new Operation id); the settled one, with its receipt
// (payer, payee, transaction), stays listed under "Finished purchases kept from
// this sign-in" and in the evidence download (buyer.completedPurchases); a
// cancelled or failed purchase is kept there too, never with a receipt; the
// evidence has no password, cookie, token, portal link (#t=) or idempotency
// key. Start over keeps the earlier session "as last observed" under earlier
// (docs/TESTER-DASHBOARD.md), including its finished purchases.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOfflineTester } from '../bin/offline-fixtures/operator.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { act, dashState, evidence, signIn, payFromPortal, txByHash } from './helpers/overnight-acceptance-dashboard.mjs';

let h;
after(async () => h?.stop());

const hex = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');
const entryFor = (list, operationId) => (list ?? []).find((p) => p.operationId === operationId);

async function prepare() {
  const r = await act(h, 'prepare-purchase');
  assert.equal(r.ok, true, `prepare-purchase: ${r.error}`);
  assert.equal(typeof r.state.purchase.idempotencyKey, 'string', 'the dashboard state names its idempotency key (to check the evidence never does)');
  assert.ok(r.state.purchase.idempotencyKey.length >= 8);
  return r.state.purchase;
}

test('CA-F1 settled and cancelled purchases are kept (state + evidence) when the next purchase is prepared; pending Prepare is not duplicated; Start over carries them into earlier', { timeout: 120_000 }, async () => {
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  const buyerKey = createEphemeralWallet();
  await signIn(h, 'buyer', buyerKey);
  const found = await act(h, 'find-listing');
  assert.equal(found.state.listing.verification.transactable, true);
  const keys = [];

  // Accepting control 1: a pending purchase is returned again by Prepare (same operation).
  const p1 = await prepare();
  keys.push(p1.idempotencyKey);
  assert.equal(p1.status, 'awaiting_approval');
  assert.equal(p1.receipt, null);
  const p1again = await prepare();
  assert.equal(p1again.operationId, p1.operationId, 'pending repeat Prepare returns the same purchase');

  // Accepting control 2: the settled purchase shows its receipt after Refresh receipt.
  const paid = await payFromPortal(h, buyerKey, p1.approvalUrl);
  assert.equal(paid.report.status, 'settled_verified');
  const settled = (await act(h, 'refresh-receipt')).state.purchase;
  assert.equal(settled.operationId, p1.operationId);
  assert.equal(settled.status, 'settled_verified');
  assert.ok(settled.receipt, 'receipt shown');
  assert.equal(hex(settled.receipt.payer), hex(buyerKey.address));
  const tx = await txByHash(h.fixtures.chain, paid.sent.txHash);
  assert.equal(hex(tx.content.from), hex(buyerKey.address), 'independent chain readback of the transfer');
  const txHash = hex(paid.sent.txHash);
  assert.ok(JSON.stringify(settled.receipt).toLowerCase().includes(txHash), 'the receipt names the transaction');

  // F1: Prepare after the settled purchase -> a NEW purchase; the settled one is kept with its receipt.
  const p2 = await prepare();
  keys.push(p2.idempotencyKey);
  assert.notEqual(p2.operationId, p1.operationId, 'a new purchase, not the settled one');
  assert.equal(p2.status, 'awaiting_approval');
  assert.equal(p2.receipt, null, 'the new purchase has no receipt');
  let st = await dashState(h);
  let kept = entryFor(st.completedPurchases, p1.operationId);
  assert.ok(kept, 'the settled purchase is still on the dashboard after Prepare');
  assert.equal(kept.status, 'settled_verified');
  assert.deepEqual(kept.receipt, settled.receipt, 'with the same receipt (payer, payee, transaction)');

  // Accepting control 3: pending repeat Prepare still returns the same new purchase and keeps nothing twice.
  assert.equal((await prepare()).operationId, p2.operationId);
  st = await dashState(h);
  assert.equal(st.completedPurchases.filter((p) => p.operationId === p1.operationId).length, 1, 'kept once');
  assert.equal(entryFor(st.completedPurchases, p2.operationId), undefined, 'a pending purchase is not "finished"');

  // Cancel: stays cancelled with no receipt, and is kept as cancelled when the next one is prepared.
  const cancelled = (await act(h, 'cancel-purchase')).state.purchase;
  assert.equal(cancelled.operationId, p2.operationId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.receipt, null);
  assert.equal((await act(h, 'refresh-receipt')).state.purchase.status, 'cancelled', 'cancel stays cancelled');
  const p3 = await prepare();
  keys.push(p3.idempotencyKey);
  assert.ok(![p1.operationId, p2.operationId].includes(p3.operationId), 'a third, new purchase');
  st = await dashState(h);
  const keptCancel = entryFor(st.completedPurchases, p2.operationId);
  assert.equal(keptCancel?.status, 'cancelled');
  assert.ok(!keptCancel.receipt, 'a cancelled purchase never acquires a receipt');
  assert.equal(entryFor(st.completedPurchases, p1.operationId)?.status, 'settled_verified', 'the settled one is still kept');
  for (const p of st.completedPurchases) {
    assert.equal(p.idempotencyKey, undefined, 'kept entries carry no idempotency key');
    assert.ok(!JSON.stringify(p).includes('#t='), 'kept entries carry no portal link');
  }

  // Evidence download (C7): reflects all three purchases truthfully, no secrets.
  const ev = await evidence(h);
  assert.equal(ev.http, 200);
  const e = ev.json.evidence;
  assert.equal(e.kind, 'dacs-offline-tester-evidence');
  assert.equal(e.simulation.evidence, 'simulated-fixture');
  assert.equal(e.buyer.purchase.operationId, p3.operationId, 'the current purchase is the new one');
  const evSettled = entryFor(e.buyer.completedPurchases, p1.operationId);
  assert.equal(evSettled?.status, 'settled_verified', 'evidence keeps the settled purchase');
  assert.equal(evSettled.receipt?.observed, true, 'with its observed receipt');
  assert.ok(JSON.stringify(evSettled).toLowerCase().includes(txHash), 'and its transaction hash');
  const evCancel = entryFor(e.buyer.completedPurchases, p2.operationId);
  assert.equal(evCancel?.status, 'cancelled');
  assert.notEqual(evCancel.receipt?.observed, true, 'cancelled is never shown with a receipt');
  for (const s of ['#t=', 'access_token', 'refresh_token', 'Bearer ', 'idempotencyKey', '/portal/', ...keys]) {
    assert.ok(!ev.text.includes(s), `evidence carries no "${String(s).slice(0, 14)}…"`);
  }

  // Start over: the earlier session keeps its finished purchases, as last observed.
  const over = await act(h, 'buyer-start-over');
  assert.equal(over.ok, true, over.error);
  st = over.state;
  assert.equal(st.signIn.status, 'signed_out');
  const earlier = st.earlier.buyer.at(-1);
  assert.ok(earlier, 'the earlier buyer session is listed');
  assert.equal(entryFor(earlier.completedPurchases, p1.operationId)?.status, 'settled_verified', 'Start over keeps the settled purchase under earlier');
  assert.equal(entryFor(earlier.completedPurchases, p2.operationId)?.status, 'cancelled');
  const ev2 = await evidence(h);
  const evEarlier = ev2.json.evidence.earlier.buyer.at(-1);
  const evEarlierSettled = entryFor(evEarlier?.completedPurchases, p1.operationId);
  assert.equal(evEarlierSettled?.status, 'settled_verified', 'evidence earlier keeps the settled purchase');
  for (const s of ['#t=', 'access_token', 'refresh_token', 'Bearer ', 'idempotencyKey', '/portal/', ...keys]) {
    assert.ok(!ev2.text.includes(s), `evidence after Start over carries no "${String(s).slice(0, 14)}…"`);
  }
});
