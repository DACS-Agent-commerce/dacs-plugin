// Concurrency and multi-process durability of idempotency and approvals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, portal, seedSellerListing, tokenFrom, approvePurchase } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const run = promisify(execFile);
let h;
let seller;
let buyer;
before(async () => {
  h = await startHarness({ env: { DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '2', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '2' } });
  seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'durable-report', price: '1' });
  buyer = await linkedUser(h);
});
after(async () => h.close());

test('concurrent prepare_purchase with one idempotency key yields exactly one operation', async () => {
  const args = { listingId: 'durable-report', version: 1, seller: seller.claim, idempotencyKey: `race-${Date.now()}` };
  const results = await Promise.all(Array.from({ length: 6 }, () => tool(h, buyer, 'prepare_purchase', args)));
  const ids = new Set(results.map((r) => r.operationId));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
});

test('racing approvals with one signed challenge produce exactly one approval', async () => {
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'durable-report', version: 1, seller: seller.claim, idempotencyKey: `race-approve-${Date.now()}` });
  const token = tokenFrom(p.approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token, address: buyer.wallet.address });
  const body = { token, challengeId: challenge.challengeId, signature: buyer.wallet.signHex(challenge.message) };
  const results = await Promise.all(Array.from({ length: 5 }, () => portal(h, `/portal/api/purchase/${p.operationId}/approve`, body)));
  assert.equal(results.filter((r) => r.status === 'payment_handoff').length, 1, JSON.stringify(results.map((r) => r.status ?? r.error)));
  assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE operation_id = ?').get(p.operationId).n, 1);
  assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM write_coordinates WHERE operation_id = ?').get(p.operationId).n, 1);
});

test('two OS processes racing on the same database file agree on one operation', async () => {
  const dbPath = h.config.databasePath;
  const worker = fileURLToPath(new URL('./fixtures/store-worker.mjs', import.meta.url));
  const account = h.app.db.prepare('SELECT id FROM accounts LIMIT 1').get().id;
  const secret = 's'.repeat(40);
  const key = `xproc-${Date.now()}`;
  const runs = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--disable-warning=ExperimentalWarning', worker, dbPath, secret, account, key, '25'])));
  const ids = new Set(runs.flatMap((r) => JSON.parse(r.stdout)));
  assert.equal(ids.size, 1, `processes created ${ids.size} operations`);
  assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?').get(key).n, 1);
});

test('concurrent verify_deal calls all report the settled state', async () => {
  // The earlier race test left `buyer` with an open handoff, which (correctly) blocks new purchases.
  assert.equal((await tool(h, buyer, 'prepare_purchase', { listingId: 'durable-report', version: 1, seller: seller.claim, idempotencyKey: `blocked-${Date.now()}` })).error, 'unresolved_payment');
  const fresh = await linkedUser(h);
  const p = await tool(h, fresh, 'prepare_purchase', { listingId: 'durable-report', version: 1, seller: seller.claim, idempotencyKey: `race-verify-${Date.now()}` });
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, fresh.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  const results = await Promise.all(Array.from({ length: 5 }, () => tool(h, fresh, 'verify_deal', { operationId: p.operationId, txHash: hash })));
  for (const r of results) assert.equal(r.status, 'settled_verified', JSON.stringify(r));
});
