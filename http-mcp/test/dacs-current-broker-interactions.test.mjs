// Current-baseline broker/journal interaction coverage after the second-purchase
// repair (input 63b482a9...). Two operations X (first) and Y (second) on one
// linked wallet, actual OAuth/MCP + portal + opt-in loopback broker over a
// reopened SQLite durable journal (opt-in harness wiring only; no application
// default constructs it). Packaged SDK signatures are real; approvals in the
// Node cases are synthetic consent; chain/seller observations are simulated.
// Not security acceptance, not Listing/Vet/finality evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeBrokerSetup, reopenableJournal, createKey } from './helpers/current-broker-interactions.mjs';
import { browserBrokerSetup, signThroughSession } from './helpers/current-broker-interactions-browser.mjs';
import { startInteropSeller } from './helpers/current-broker-interactions-interop.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import { addSeller } from './dacs-loopback-fixture.test.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const outcome = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: e.code ?? e.message }));
const delivered = (w) => w.calls.filter((c) => c.route === 'claim' && c.delivered).length;

test('X unknown after apply fences fresh Y; reopened journal; X exact readback releases lane; reconnected Y queues and anchors once', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await x.approveOne()).state, 'uncertain');
  w.chain.wire.faults.dropAfterApply = false;
  assert.equal(w.chain.wire.record.accepted.length, 1, 'the fixture applied X; only the answer was lost');
  await y.authenticate();
  const fenced = (await y.submit()).evidence.protocol;
  assert.equal(fenced.stage, 'agreement-signing'); assert.match(fenced.lastAttempt.reason, /wallet-fenced/);
  assert.equal(y.anchor(), null, 'fresh Y fenced before any plan is explicitly unsent');
  assert.equal(await y.record(), undefined);
  await w.store.reopen();
  assert.deepEqual(await w.store.lanes(), [{ stage: 'broadcast-started', nonce: 1, logicalAddress: x.logicalAddress }]);
  assert.equal((await x.record()).stage, 'uncertain');
  // Readback unavailable: X stays indeterminate and Y stays fenced.
  w.chain.faults.unavailable = true;
  assert.equal((await x.verify()).protocol.lastAttempt.outcome, 'indeterminate');
  w.chain.faults.unavailable = false;
  assert.match(sellerValue((await y.verify()).protocol.lastAttempt.reason), /wallet-fenced/, 'unknown X lane is not released by Y recheck');
  assert.equal(await y.record(), undefined);
  // Accepting control: exact native readback anchors X and releases the lane.
  assert.equal((await x.verify()).protocol.stage, 'agreement-anchored');
  assert.equal((await x.record()).stage, 'uncertain', 'readback observation never rewrites the CREATE delivery record');
  await y.authenticate(); // account/session reconnect: a fresh wallet-authenticated session for Y
  const queued = (await y.verify()).protocol;
  assert.equal(queued.stage, 'agreement-signing', JSON.stringify(queued.lastAttempt));
  assert.equal((await y.record()).stage, 'queued');
  assert.equal(w.broadcasts(), 1); assert.equal(w.createApprovals(), 1);
  assert.equal((await y.verify()).protocol.stage, 'agreement-signing');
  assert.equal((await y.record()).stage, 'queued', 'repeat recheck does not re-plan or requeue');
  assert.equal((await y.approveOne()).state, 'completed');
  assert.equal((await y.verify()).protocol.stage, 'agreement-anchored');
  await w.store.reopen();
  assert.deepEqual(await w.store.lanes(), [{ stage: 'broadcast-accepted', nonce: 2, logicalAddress: y.logicalAddress }]);
  assert.deepEqual(w.chain.wire.record.accepted.map((tx) => Number(tx.content.nonce)), [1, 2]);
  await assert.rejects(x.approveOne(), /uncertain.*no replay/);
  await assert.rejects(y.approveOne(), /completed.*no replay/);
  await x.verify(); await y.verify();
  assert.equal(w.broadcasts(), 2); assert.equal(w.createApprovals(), 2);
  assert.equal(delivered(w), 2, 'exactly one delivered CREATE per operation');
  t.diagnostic(JSON.stringify({ reopens: w.store.reopens(), broadcasts: w.broadcasts(), deliveredClaims: delivered(w), claims: w.calls.filter((c) => c.route === 'claim').map((c) => c.state) }));
});

// Test-effectiveness witness (test-only fault, no runtime change): if the
// journal silently lost pre-reopen records, the reopen oracles above would be
// violated (Y would queue while X is still unknown). Do NOT approve Y here.
test('witness: a journal that forgets pre-reopen records would let fresh Y queue while X is unknown; the reopen oracle detects it', async (t) => {
  const w = await nodeBrokerSetup(t, runtime, { lossyReopen: true });
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await x.approveOne()).state, 'uncertain');
  w.chain.wire.faults.dropAfterApply = false;
  await y.authenticate();
  assert.match((await y.submit()).evidence.protocol.lastAttempt.reason, /wallet-fenced/);
  await w.store.reopen();
  assert.deepEqual(await w.store.lanes(), [], 'witness fault: the unknown X lane is no longer visible');
  const py = (await y.verify()).protocol;
  const record = await y.record();
  t.diagnostic(JSON.stringify({ yStage: py.stage, yReason: py.lastAttempt?.reason, yRecord: record?.stage ?? null }));
  assert.doesNotMatch(py.lastAttempt?.reason ? sellerValue(py.lastAttempt.reason) : '', /wallet-fenced/);
  assert.equal(record?.stage, 'queued', 'the durable-journal oracle (Y stays fenced, no Y record) is violated under record loss');
  assert.equal(w.broadcasts(), 1, 'witness never approves or broadcasts Y');
});

test('X delivered but never answered (issued-to-browser) stays retained and keeps fencing fresh Y across restart; nothing requeued or redelivered', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  const claimed = await x.claimOnly();
  assert.equal(claimed.state, 'issued-to-browser'); assert.ok(claimed.request);
  await y.authenticate();
  assert.match((await y.submit()).evidence.protocol.lastAttempt.reason, /wallet-fenced/);
  assert.equal(y.anchor(), null);
  const xAnchor = x.anchor();
  assert.ok(xAnchor);
  await w.restart();
  for (let n = 0; n < 2; n++) {
    const px = await x.recheck();
    assert.equal(px.stage, 'agreement-signing');
    assert.equal(x.anchor().receiptContentHash, xAnchor.receiptContentHash, 'issued X intent retained');
    assert.equal((await x.record()).stage, 'issued-to-browser');
  }
  // Restarted Y has no broker session; its explicit unsent state cannot start a CREATE.
  const ry = await outcome(y.recheck());
  t.diagnostic(`restarted unsent Y recheck: ${JSON.stringify(ry.error ?? ry.ok.lastAttempt)}`);
  assert.equal(y.anchor(), null);
  assert.equal(await y.record(), undefined);
  assert.deepEqual(await w.store.lanes(), [], 'no signed intent exists for either operation');
  assert.equal(w.broadcasts(), 0); assert.equal(w.createApprovals(), 0);
  assert.equal(delivered(w), 0, 'claimOnly used a raw session; the client delivered nothing');
});

// I4 after the F1 repair. Before the repair, Y stayed permanently wallet-fenced
// by X's `handoff-issued` plan; this test is the acceptance condition.
test('X explicit denial is retained as rejected across restart; its provably unsigned handoff is retired and fresh Y queues once and anchors at nonce 1', async (t) => {
  const w = await nodeBrokerSetup(t, runtime);
  const x = await w.operation('x'), y = await w.operation('y');
  await x.authenticate(); await x.submit();
  w.decision.allow = false;
  assert.equal((await x.approveOne()).state, 'denied');
  w.decision.allow = true;
  assert.equal((await x.verify()).protocol.stage, 'agreement-rejected');
  assert.deepEqual(await w.store.lanes(), [], 'denied CREATE recorded no signed intent');
  const adaptersAfterDenial = await w.store.adapters();
  assert.deepEqual(adaptersAfterDenial, [{ logicalAddress: x.logicalAddress, stage: 'denied-unsigned' }], 'the denied X plan is retained as terminal, not deleted');
  await w.store.reopen();
  await y.authenticate();
  const py = (await y.submit()).evidence.protocol;
  t.diagnostic(JSON.stringify({ adaptersAfterDenial, yStage: py.stage, yReason: py.lastAttempt?.reason, yRecord: (await y.record())?.stage ?? null }));
  assert.equal(py.stage, 'agreement-signing'); assert.match(py.lastAttempt.reason, /outcome_unknown/);
  assert.equal((await y.record()).stage, 'queued');
  assert.equal((await y.verify()).protocol.stage, 'agreement-signing');
  assert.equal((await y.record()).stage, 'queued', 'repeat recheck does not requeue');
  assert.equal((await y.approveOne()).state, 'completed');
  assert.equal((await y.verify()).protocol.stage, 'agreement-anchored');
  await assert.rejects(x.approveOne(), /a planned, pending offline Agreement is required/, 'rejected X can never be claimed or redelivered');
  await w.restart();
  assert.equal((await x.recheck()).stage, 'agreement-rejected');
  assert.equal((await x.record()).stage, 'denied');
  assert.ok(x.anchor(), 'rejection retains the attempted scope');
  assert.equal((await y.recheck()).stage, 'agreement-anchored');
  const adapters = await w.store.adapters();
  assert.deepEqual(adapters.find((a) => a.logicalAddress === x.logicalAddress), { logicalAddress: x.logicalAddress, stage: 'denied-unsigned' });
  assert.deepEqual(adapters.find((a) => a.logicalAddress === y.logicalAddress), { logicalAddress: y.logicalAddress, stage: 'verified' });
  assert.deepEqual(await w.store.lanes(), [{ stage: 'broadcast-accepted', nonce: 1, logicalAddress: y.logicalAddress }]);
  assert.deepEqual(w.chain.wire.record.accepted.map((tx) => Number(tx.content.nonce)), [1]);
  assert.equal(w.broadcasts(), 1); assert.equal(w.createApprovals(), 2);
  assert.equal(delivered(w), 2, 'X delivered once (denied), Y delivered once; X never redelivered');
});

// Interop gap (READ-ONLY witness, Linux-adapted helper): the unchanged Demo
// context refuses the plugin's placeholder-Vet plan before any CREATE. This
// checks the broker/journal consequence only; it is not interop acceptance.
test('interop: Demo seller-context refusal of X leaves no CREATE or adapter fence; fresh fixture-seller Y on the same wallet anchors once over the reopened journal', async (t) => {
  const nowMs = Date.now();
  const w = await nodeBrokerSetup(t, runtime, { now: () => nowMs });
  const x = await w.operation('x', { seller: (h, listingId) => startInteropSeller(t, h, { listingId, nowMs }),
    beforeSign: (op, seller) => seller.installOperatorFacts({ jobId: op.terms.protocol.jobId, buyerBundle: op.state.protocol.buyerBundle }) });
  await x.authenticate();
  await x.submit();
  assert.equal(x.seller.progress.length, 1);
  const refusal = x.seller.progress[0];
  assert.deepEqual([refusal.disposition, refusal.stage, refusal.reason], ['rejected', 'context', 'proposal plan differs from the independently derived seller agreement']);
  assert.deepEqual(x.seller.verifiedVets.map((v) => v.status), ['valid', 'valid']);
  assert.deepEqual(x.seller.signed, []); assert.deepEqual(x.seller.published, []);
  const vx = (await x.verify()).protocol;
  assert.equal(vx.stage, 'agreement-rejected'); assert.equal(vx.limits.payment, 'held');
  assert.equal(x.anchor(), undefined, 'refused before any CREATE intent');
  assert.equal(await x.record(), undefined);
  assert.deepEqual(await w.store.adapters(), [], 'no adapter plan, so nothing fences the wallet lane');
  await assert.rejects(x.approveOne(), /a planned, pending offline Agreement is required/);
  await w.store.reopen();
  // The harness clock is pinned (as in the interop witness); stamp Y's fixture Listing with it.
  const y = await w.operation('y', { seller: (h, listingId) => addSeller(h, { listingId, listingNow: nowMs, now: () => nowMs }) });
  await y.authenticate();
  assert.equal((await y.submit()).evidence.protocol.stage, 'agreement-signing');
  assert.equal((await y.record()).stage, 'queued', 'fresh Y is not fenced by the refused X');
  assert.equal((await y.approveOne()).state, 'completed');
  assert.equal((await y.verify()).protocol.stage, 'agreement-anchored');
  await w.store.reopen();
  assert.deepEqual(await w.store.lanes(), [{ stage: 'broadcast-accepted', nonce: 1, logicalAddress: y.logicalAddress }]);
  assert.equal(w.broadcasts(), 1); assert.equal(w.createApprovals(), 1); assert.equal(delivered(w), 1);
  t.diagnostic(`interop refusal ${refusal.stage}: ${refusal.reason}; Y anchored nonce 1; broker calls ${JSON.stringify(w.calls.map((c) => `${c.route}:${c.state ?? c.error ?? c.http}`))}`);
});

// The role instructions name the known Chrome; launchTestChrome never falls back.
process.env.DACS_TEST_CHROME ??= '/usr/bin/chromium-browser';
test('Chrome packaged wallet: X issued fences Y in a second tab; X trusted approval + readback releases lane; reopened journal; Y re-sign queues and anchors once', { timeout: 180000 }, async (t) => {
  const store = await reopenableJournal(t);
  const w = await browserBrokerSetup(t, store);
  const account = w.h.app.services.accounts.walletOwner(w.address);
  const anchorOf = (op) => w.h.app.services.ops.get(account, op.id).state.protocol.walletAnchor;
  const broadcasts = () => w.chain.wire.record.broadcastAttempts.length;
  const x = await w.prepare('x'), y = await w.prepare('y');
  await w.open(w.page, x);
  const xCreate = await signThroughSession(w.page, x, w.address, { expectCreate: true });
  assert.equal((await store.journal.get(createKey(x.id))).stage, 'issued-to-browser');
  const second = await w.newPage();
  await w.open(second.page, y);
  await signThroughSession(second.page, y, w.address, { expectCreate: false });
  assert.equal(await store.journal.get(createKey(y.id)), undefined, 'guard witness: no Y CREATE while X is issued');
  assert.equal(anchorOf(y), null);
  assert.match(sellerValue((await y.verify()).protocol.lastAttempt.reason), /wallet-fenced/);
  assert.equal(broadcasts(), 0);
  // Accepting control: X trusted click, then the UI recheck reads X back natively.
  await xCreate.dialog.getByRole('button', { name: UI.approve }).click();
  await w.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const vx = (await x.verify()).protocol;
  assert.equal(vx.stage, 'agreement-anchored'); assert.equal(vx.agreement.hash, xCreate.shown.contentHash); assert.equal(vx.limits.payment, 'held');
  assert.equal(broadcasts(), 1);
  await store.reopen();
  assert.deepEqual(await store.lanes(), [{ stage: 'broadcast-accepted', nonce: 1, logicalAddress: x.logicalAddress }]);
  assert.equal((await store.journal.get(createKey(x.id))).stage, 'completed');
  assert.equal(await store.journal.get(createKey(y.id)), undefined);
  // Same Y tab: re-sign continues from Y's saved plan (no identity presentation), opens a fresh session and queues Y once.
  const yCreate = await signThroughSession(second.page, y, w.address, { expectCreate: true, savedPlan: true });
  assert.equal((await store.journal.get(createKey(y.id))).stage, 'issued-to-browser');
  assert.notEqual(yCreate.shown.contentHash, xCreate.shown.contentHash);
  assert.equal(broadcasts(), 1);
  await yCreate.dialog.getByRole('button', { name: UI.approve }).click();
  await second.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const vy = (await y.verify()).protocol;
  assert.equal(vy.stage, 'agreement-anchored'); assert.equal(vy.agreement.hash, yCreate.shown.contentHash); assert.equal(vy.limits.payment, 'held');
  await store.reopen();
  assert.deepEqual(await store.lanes(), [{ stage: 'broadcast-accepted', nonce: 2, logicalAddress: y.logicalAddress }]);
  assert.equal((await store.journal.get(createKey(y.id))).stage, 'completed');
  assert.deepEqual(w.chain.wire.record.accepted.map((tx) => Number(tx.content.nonce)), [1, 2]);
  // Repeats only observe.
  await second.page.locator('#dacs-recheck').click();
  await x.verify(); await y.verify();
  assert.equal(broadcasts(), 2);
  const claims = w.broker.filter((r) => r.route === 'claim');
  assert.deepEqual(claims.filter((c) => c.delivered).map((c) => c.id), [x.id, y.id], 'one delivered CREATE per operation');
  assert.deepEqual(claims.filter((c) => c.id === y.id).map((c) => c.state), ['absent', 'issued-to-browser']);
  assert.deepEqual(w.broker.filter((r) => r.route === 'complete').map((r) => [r.id, r.state]), [[x.id, 'completed'], [y.id, 'completed']]);
  assert.deepEqual(store.inspectLocks(), []);
  assert.ok(w.requests.every((r) => new URL(r.url).origin === w.h.origin));
  assertNoSecrets(w.requests, [w.password], 'browser HTTP requests'); assertNoSecrets(w.h.logs, [w.password], 'server logs');
  assert.deepEqual(w.consoleErrors, []); assert.deepEqual(second.errors, []);
  t.diagnostic(JSON.stringify({ profile: 'loopback-test-only', reopens: store.reopens(), broadcasts: broadcasts(), trustedCreateApprovals: 2, broker: w.broker.map((r) => `${r.id === x.id ? 'X' : 'Y'}:${r.route}:${r.state ?? r.error ?? r.http}`) }));
});

test('all current broker interaction connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
