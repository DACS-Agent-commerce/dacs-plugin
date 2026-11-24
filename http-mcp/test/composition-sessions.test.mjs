// SDK purchases on: the startup binding's inputs and the buyer sessions. Each session is an account and one of its
// linked wallets, bound over the node on its first purchase action and never shared. The node is a scripted double
// on an .invalid origin; the client holds every purchase action, so a call that reaches it is refused
// profile_not_admitted with no cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { linkedUser } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { FIXTURE_CHAIN, accountOf, prepareArgs, switchOnHarness, tp1Node } from './helpers/switch-on-world.mjs';

const HELD = (error) => error.code === 'profile_not_admitted' && error.cause === undefined;
const healthOf = async (h) => (await (await fetch(`${h.origin}/health`)).json()).sdkPurchases;
const prepare = (h, user, key, extra = {}) => h.app.services.purchases.prepare({ ...prepareArgs(h, user, key), ...extra });

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'switch-on-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('with the switch on, a missing or invalid DACS_TP1_TRANSPORT_AUTHORITY refuses the startup binding tp1_local_binding_invalid before any node read, and every purchase action refuses that code', async (t) => {
  for (const tp1TransportAuthority of [null, 'not a token!']) {
    const { h, node } = await switchOnHarness(t, { settings: { tp1TransportAuthority } });
    assert.deepEqual((await healthOf(h)).binding, { state: 'refused', code: 'tp1_local_binding_invalid' }, String(tp1TransportAuthority));
    await assert.rejects(h.app.services.purchases.cancel({ accountId: 'acct_1', operationId: 'pur_AAAAAAAAAAAAAAAA' }), (error) => error.code === 'tp1_local_binding_invalid');
    assert.deepEqual(node.reads, []);
  }
});

test('with the switch on, an invalid participant enrollment file refuses the startup binding with its own tp1 code', async (t) => {
  const dataDir = scratchDir(t);
  writeFileSync(join(dataDir, 'participant-enrollment.json'), '{"format":"dacs-participant-enrollment/v1","entries":[{}]}');
  const { h } = await switchOnHarness(t, { env: { DACS_DATA_DIR: dataDir } });
  assert.deepEqual((await healthOf(h)).binding, { state: 'refused', code: 'tp1_enrollment_invalid' });
  await assert.rejects(h.app.services.purchases.prepare({ accountId: 'acct_1', listingId: 'fixture-report', version: 1 }), (error) => error.code === 'tp1_enrollment_invalid');
});

test('each buyer session binds once on its own first purchase action, and session B\'s request cannot reach session A\'s reader', async (t) => {
  const { h, node } = await switchOnHarness(t);
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  const startup = node.reads.length;
  await assert.rejects(prepare(h, a, 'a-1'), HELD);
  const afterA = node.reads.length;
  assert.ok(afterA > startup, 'session A bound');
  await assert.rejects(prepare(h, a, 'a-2'), HELD);
  assert.equal(node.reads.length, afterA, 'session A reuses its own binding');
  await assert.rejects(prepare(h, b, 'b-1'), HELD);
  assert.ok(node.reads.length > afterA, 'session B bound for itself, never on A\'s reader');
  const bound = node.reads.length;
  const purchaseOfA = 'pur_AAAAAAAAAAAAAAAA';
  seedPurchase(h, { id: purchaseOfA, accountId: accountOf(h, a), wallet: a.wallet.address });
  await assert.rejects(h.app.services.purchases.cancel({ accountId: accountOf(h, b), operationId: purchaseOfA }), (error) => error.code === 'not_found');
  await assert.rejects(h.app.services.purchases.approve({ operationId: purchaseOfA, token: 'x'.repeat(43), challengeId: 'c', signature: 's' }), (error) => error.code === 'not_found');
  assert.equal(node.reads.length, bound, 'no session was built for B\'s requests naming A\'s purchase');
});

test('account A\'s request naming wallet B, which is B\'s linked wallet, is refused and never reaches B\'s reader', async (t) => {
  const { h, node } = await switchOnHarness(t);
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  await assert.rejects(prepare(h, b, 'b-1'), HELD);
  const reads = node.reads.length;
  const rows = databaseRows(h.app.db);
  await assert.rejects(prepare(h, a, 'a-names-b', { walletAddress: b.wallet.address }), (error) => error.code === 'not_found');
  assert.equal(node.reads.length, reads, 'neither B\'s session nor a new one was used');
  assert.equal(databaseRows(h.app.db), rows);
});

test('a purchase session that ends mid-operation lets the call in flight finish on its own objects and starts no new operation', async (t) => {
  const node = tp1Node();
  const { h } = await switchOnHarness(t, { node });
  const user = await linkedUser(h);
  node.mode = 'gated';
  node.reset();
  const inFlight = prepare(h, user, 'in-flight');
  await node.requested;
  h.app.db.prepare('DELETE FROM wallets WHERE address = ?').run(user.wallet.address);
  node.release();
  node.mode = 'answer';
  await assert.rejects(inFlight, HELD, 'the call in flight reached the client on its session\'s objects');
  const reads = node.reads.length;
  await assert.rejects(prepare(h, user, 'after-end'), (error) => error.code === 'not_found');
  assert.equal(node.reads.length, reads, 'the ended session bound nothing new');
});

test('a process restart while a purchase session is binding loses nothing, and the next call binds a fresh session that reaches the client', async (t) => {
  const node = tp1Node();
  const { h } = await switchOnHarness(t, { node });
  const user = await linkedUser(h);
  const rows = databaseRows(h.app.db);
  node.mode = 'gated';
  node.reset();
  const interrupted = prepare(h, user, 'interrupted').catch((error) => error);
  await node.requested;
  node.mode = 'answer';
  await h.restart();
  node.release();
  assert.notEqual(await interrupted, undefined, 'the interrupted call did not complete');
  const reads = node.reads.length;
  await assert.rejects(prepare(h, user, 'after-restart'), HELD);
  assert.ok(node.reads.length > reads, 'the new process bound a new session');
  assert.equal(databaseRows(h.app.db), rows, 'the interrupted call wrote nothing');
});

test('a buyer session whose binding is refused rejects with the refusal\'s own bare tp1 code, keeps nothing, and the next call binds again', async (t) => {
  const node = tp1Node();
  const { h } = await switchOnHarness(t, { node });
  const user = await linkedUser(h);
  node.chainIdentity = FIXTURE_CHAIN;
  await assert.rejects(prepare(h, user, 'refused-session'), (error) => error.code === 'tp1_connection_unverified');
  node.chainIdentity = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
  const reads = node.reads.length;
  await assert.rejects(prepare(h, user, 'rebound-session'), HELD);
  assert.ok(node.reads.length > reads, 'the refused session was not kept, so the next call bound a new one');
});

test('the operation store finds a saved purchase by its job id, writes nothing, and answers null for an unknown job', async (t) => {
  const { h } = await switchOnHarness(t);
  const user = await linkedUser(h);
  seedPurchase(h, { id: 'pur_BBBBBBBBBBBBBBBB', accountId: accountOf(h, user), wallet: user.wallet.address, jobId: 'job-1' });
  const rows = databaseRows(h.app.db);
  const { ops } = h.app.services;
  assert.deepEqual([ops.findByJobId('job-1').id, ops.findByJobId('job-1').terms.buyer.wallet], ['pur_BBBBBBBBBBBBBBBB', user.wallet.address]);
  assert.equal(ops.findByJobId('job-unknown'), null);
  assert.equal(ops.findByJobId(null), null);
  assert.equal(databaseRows(h.app.db), rows);
});

test('with the switch on, a KILL file in the data directory makes the CREATE routes refuse writes_stopped', async (t) => {
  const { h } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' } });
  const challenge = () => fetch(`${h.origin}/portal/api/purchase/pur_AAAAAAAAAAAAAAAA/agreement-create/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalize({ start: 'start', token: 'token' }) }).then((r) => r.json());
  assert.equal((await challenge()).error, 'not_configured', 'without KILL the route reaches the passive purchase reader');
  writeFileSync(join(h.dataDir, 'KILL'), '');
  assert.equal((await challenge()).error, 'writes_stopped');
});

/** Saves a purchase of `wallet` for `accountId` directly, as the client would have. */
function seedPurchase(h, { id, accountId, wallet, jobId = null }) {
  const at = new Date().toISOString();
  h.app.db.prepare(`INSERT INTO operations (id, account_id, kind, idempotency_key, request_hash, status, terms, terms_hash, state, handoff_token_hash, handoff_expires_at, job_id, expires_at, created_at, updated_at)
    VALUES (?, ?, 'purchase', ?, 'request', 'awaiting_approval', ?, 'terms', '{}', 'hash', ?, ?, ?, ?, ?)`)
    .run(id, accountId, id, JSON.stringify({ buyer: { accountId, wallet }, protocol: { jobId } }), at, jobId, at, at, at);
}
