import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import tls from 'node:tls';
import { failOnLeftoverListeners, openListeners } from './helpers/listener-guard.mjs';
import { shutdownClock } from './helpers/shutdown-clock.mjs';
import { stopDevnetDemo } from '../src/devnet-demo/stop.mjs';
import { createNode2TransportOwner } from '../src/devnet-demo/operator-network.mjs';
import { holdFreePorts, startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

process.env.DACS_COMMIT_ON_SIGNATURE = 'off';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mcpRequest = h => fetch(`${h.config.publicOrigin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const locks = (h, file = 'node2-transport.sqlite') => {
  const db = new DatabaseSync(join(h.config.stateDirectory, file), { readOnly: true });
  try { return db.prepare('SELECT key FROM locks ORDER BY key').all().map(row => row.key); } finally { db.close(); }
};
const refusedConnection = (origin, connect = net.connect) => new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port), rejectUnauthorized: false });
  socket.once(connect === tls.connect ? 'secureConnect' : 'connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('error', error => resolve(error.code));
});
// A refused close keeps its memoized refusal, so the helper's close fails too.
// Whatever the outcome, a listener still open afterwards fails the test now
// instead of keeping the file alive until the runner's timeout.
function cleanup(t, h, release) {
  t.after(async () => {
    release.resolve();
    if (!await h.close().then(() => true, () => false)) {
      for (const stop of [() => h.running?.close?.(), () => h.application?.close?.(), () => h.composition?.sellerAgent?.close?.(), () => h.operator?.close?.()]) await Promise.resolve().then(stop).catch(() => {});
      await h.node2.close();
      await rm(h.root, { recursive: true, force: true });
    }
    await failOnLeftoverListeners();
  });
}

// A buyer holder at close: the Agreement was sent, and verify_deal holds both buyer lanes during readback.
for (const path of ['direct', 'old live order', 'shared script stop']) test(`switch-off ${path} lets a held buyer unwind, then restart reads the original Agreement only`, { timeout: 300000 }, async t => {
  const entered = deferred(), release = deferred(), unwinding = deferred(), unwindRelease = deferred();
  const broadcasts = [];
  let h, agreementSent = false, held = false;
  const rpcFault = async ({ body }) => {
    const tx = body?.params?.[0]?.data?.response?.data?.transaction;
    if (body?.method === 'execute' && body.params[0].extra === 'broadcastTx') {
      broadcasts.push(tx.hash);
      if (tx.content?.data?.[1]?.metadata?.artifactKind === 'Agreement') agreementSent = true;
    }
    if (!h) return null;
    if (!held && agreementSent && body?.method === 'nodeCall' && body.params?.[0]?.message && locks(h).some(key => key.startsWith('plugin/agreement/'))) {
      held = true; entered.resolve(); await release.promise;
    }
    return null;
  };
  h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, rpcFault });
  cleanup(t, h, { resolve() { release.resolve(); unwindRelease.resolve(); } });
  // Keep the real outer buyer lane alive briefly after its source work ends.
  // This distinguishes source closure alone from waiting for lane release.
  const journal = h.prepared.devnetAgreementTransport.journal, lock = journal.withWalletLock;
  journal.withWalletLock = (key, work) => lock(key, async () => {
    try { return await work(); }
    finally {
      if (held && key.startsWith('plugin/native-payment/')) {
        unwinding.resolve(); await unwindRelease.promise;
      }
    }
  });
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: `buyer-holder-shutdown-off-${path.replace(/\W+/g, '-')}` }).then(value => ({ value }), error => ({ error }));
  await bounded(entered.promise, 120000, 'buyer readback never held its lanes');
  assert.ok(locks(h).some(key => key.startsWith('plugin/agreement/')));
  assert.ok(locks(h).some(key => key.startsWith('plugin/native-payment/')));
  const started = Date.now();
  let settled = false;
  const stop = async () => {
    if (path === 'old live order') { await h.running.close(); await h.application.close(); h.composition.sellerAgent.close(); await h.prepared.close(); }
    else if (path === 'shared script stop') assert.equal(await stopDevnetDemo(h.prepared), 0);
    else await h.operator.close();
  };
  const closing = stop().then(() => ({}), error => ({ error })).finally(() => { settled = true; });
  await sleep(300);
  let appAlive;
  try { appAlive = h.application.db.prepare('SELECT 1 AS alive').get().alive; } catch { appAlive = false; }
  // Always release the source before asserting so a broken old live order exits.
  await sleep(6700); release.resolve();
  await bounded(unwinding.promise, 20000, 'buyer lane did not reach its unwind');
  await sleep(300);
  const waitedForLane = !settled;
  unwindRelease.resolve();
  const closed = await bounded(closing, 20000, 'buyer shutdown did not settle');
  await bounded(purchase, 60000, 'buyer did not unwind');
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  assert.equal(waitedForLane, true, 'source closure alone does not finish close before the buyer lane releases');
  assert.ok(Date.now() - started >= 7000, 'close waited for the buyer holder');
  assert.equal(appAlive, 1, 'the application database stays open until the source and buyer lanes unwind');
  assert.throws(() => h.application.db.prepare('SELECT 1'), /database is not open/, 'the owned shutdown closes the app database after the unwind');
  assert.deepEqual(locks(h), [], 'both buyer lane rows are released before close resolves');
  const original = h.node2.chain.wire.record.accepted.map(tx => tx.hash);
  await h.restart();
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
  // Existing signed work stays readback-only; fresh seller work can proceed.
  await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  const after = h.application.db.prepare("SELECT status, json_extract(state, '$.protocol.stage') AS stage FROM operations WHERE id = ?").get(row.id);
  assert.deepEqual({ ...after }, { status: 'awaiting_approval', stage: 'seller-committed' });
  for (const hash of original) assert.equal(broadcasts.filter(sent => sent === hash).length, 1, 'restart never resends signed bytes, including rejected duplicate sends');
  assert.equal(h.node2.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'Agreement').length, 1);
  assert.equal(h.node2.chain.record.accepted.length, 0, 'shutdown and readback do not send a native payment');
});

test('switch-off close stops the source while the app and a live buyer lane can still unwind', { timeout: 300000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  const release = deferred(), entered = deferred(); cleanup(t, h, release);
  const holder = h.prepared.devnetAgreementTransport.journal.withWalletLock('plugin/agreement/shutdown-source-order', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const closing = h.operator.close().then(() => ({}), error => ({ error })).finally(() => { settled = true; });
  await sleep(300);
  try {
    assert.equal(settled, false, 'close is waiting for the live lane');
    await assert.rejects(h.prepared.devnetAgreementTransport.readRpc('/'), error => error.code === 'transport_closed', 'source closes before waiting for lane release');
    assert.equal((await fetch(`${h.config.publicOrigin}/portal/api/devnet-native-wallet-rpc`)).status, 200, 'wallet relay stays available during unwind');
    assert.equal((await mcpRequest(h)).status, 503, 'direct close refuses new MCP actions during the lane wait');
  } finally { release.resolve(); await holder; }
  assert.equal((await closing).error, undefined);
  assert.deepEqual(locks(h), []);
});

test('switch-off close refuses a never-ending lane at the injected deadline and memoizes its refusal', { timeout: 120000 }, async t => {
  const clock = shutdownClock();
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, shutdownTimer: clock });
  const release = deferred(), entered = deferred(); cleanup(t, h, release);
  const holder = h.prepared.devnetAgreementTransport.journal.withWalletLock('plugin/agreement/shutdown-dead-holder', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const closing = h.operator.close();
  const outcome = closing.catch(error => error);
  await bounded(clock.waiting(50), 10000, 'lane polling never started');
  await clock.advance(50, clock.laneMs);
  const error = await bounded(outcome, 10000, 'close exceeded its injected deadline');
  assert.equal(error.code, 'journal-busy');
  await assert.rejects(fetch(`${h.config.publicOrigin}/portal/api/devnet-native-wallet-rpc`), 'a refused close also cuts the remaining listener');
  assert.equal(h.application.db.prepare('SELECT 1 AS alive').get().alive, 1, 'refusal keeps the app database open');
  assert.deepEqual(locks(h), ['plugin/agreement/shutdown-dead-holder']);
  assert.strictEqual(h.operator.close(), closing, 'a second close returns exactly the memoized promise');
  assert.strictEqual(h.running.close(), closing, 'listener close owns the same shutdown');
  assert.strictEqual(h.prepared.close(), closing, 'prepared close owns the same shutdown');
  assert.strictEqual(await h.operator.close().catch(error => error), error);
  assert.deepEqual(locks(h), ['plugin/agreement/shutdown-dead-holder'], 'retry deletes nothing');
  release.resolve(); await holder;
  assert.strictEqual(await h.operator.close().catch(error => error), error, 'even after release there is no same-process retry');
  assert.deepEqual(locks(h), []);
});

test('switch-off close waits for its seller-artifacts lane and refuses seller and directory connections', { timeout: 120000 }, async t => {
  const clock = shutdownClock();
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, shutdownTimer: clock });
  const release = deferred(), entered = deferred(); cleanup(t, h, release);
  const holder = h.prepared.composition.publicJournal.withWalletLock('sr2/adapter/shutdown-held', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const closing = h.operator.close().then(() => ({}), error => ({ error })).finally(() => { settled = true; });
  await bounded(clock.waiting(50), 10000, 'seller journal was omitted from lane wait');
  try {
    assert.equal(settled, false);
    assert.equal(await refusedConnection(h.config.sellerOrigin, tls.connect), 'ECONNREFUSED');
    assert.equal(await refusedConnection(h.config.directoryOrigin), 'ECONNREFUSED', 'the directory closes first, before the drain and lane wait');
    assert.equal((await mcpRequest(h)).status, 503);
  } finally {
    release.resolve(); await holder;
    await clock.advance(50);
  }
  assert.equal((await closing).error, undefined);
  const read = new DatabaseSync(join(h.config.stateDirectory, 'seller-artifacts.sqlite'), { readOnly: true });
  try { assert.deepEqual(read.prepare('SELECT key FROM locks').all(), []); } finally { read.close(); }
});

test('switch-off close ignores and preserves a foreign-instance lock row', { timeout: 120000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  cleanup(t, h, { resolve() {} });
  const db = new DatabaseSync(join(h.config.stateDirectory, 'node2-transport.sqlite'));
  db.prepare("INSERT INTO locks (key, token, instance, pid, fence, acquired_at) VALUES ('plugin/agreement/probe-dead', 'deadtoken', 'dead-instance', 999999, 999999, '2026-10-01T00:00:00.000Z')").run(); db.close();
  const started = Date.now();
  await h.operator.close();
  assert.ok(Date.now() - started < 5000, 'a foreign lock does not consume the 10 s lane budget');
  const read = new DatabaseSync(join(h.config.stateDirectory, 'node2-transport.sqlite'), { readOnly: true });
  try { assert.deepEqual(read.prepare('SELECT key, instance FROM locks').all().map(row => ({ ...row })), [{ key: 'plugin/agreement/probe-dead', instance: 'dead-instance' }]); } finally { read.close(); }
});

// No injected clock: this pins the production switch-off grace. A relay
// request admitted before close, whose body arrives a second later, still
// reaches the open source and is answered before the source closes.
test('switch-off close gives an admitted app request its production grace before the source closes', { timeout: 120000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  cleanup(t, h, { resolve() {} });
  const request = http.request(new URL('/portal/api/devnet-native-wallet-rpc', h.config.publicOrigin), { method: 'POST', headers: { 'content-type': 'application/json' } });
  const answered = new Promise((resolve, reject) => {
    request.once('response', response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.once('end', () => resolve({ status: response.statusCode, text })); });
    request.once('error', reject);
  });
  request.flushHeaders();
  await sleep(300);
  const started = Date.now();
  const closing = h.operator.close().then(() => ({}), error => ({ error }));
  await sleep(1000);
  request.end(JSON.stringify({ method: 'nodeCall', params: [{ message: 'getNetworkInfo', data: {} }] }));
  const { status, text } = await bounded(answered, 20000, 'the admitted relay request was never answered');
  assert.equal(status, 200, text);
  assert.equal((await bounded(closing, 30000, 'close did not settle')).error, undefined);
  assert.ok(Date.now() - started >= 1000, 'close waited for the admitted request');
});

// The seller's first CREATE after
// the Agreement stays "pending" at Node2 throughout. With the switch off, close
// waits for that admitted seller request only for the grace, then closes the
// source, which ends the inclusion wait; the accepted hash stays readback-only.
// The buyer's MCP request to the app waits on that seller request. When the
// buyer's app connection is cut first, only the seller request itself is
// admitted, and it alone must hold the grace.
for (const buyerGone of [false, true]) test(`switch-off close bounds an admitted seller CREATE in its inclusion wait by the grace${buyerGone ? ' after the buyer app connection is cut' : ''}`, { timeout: 300000 }, async t => {
  const inInclusion = deferred(), broadcasts = [];
  let h, agreementSent = false, target = null, faking = true, polls = 0;
  const rpcFault = async ({ body }) => {
    const tx = body?.params?.[0]?.data?.response?.data?.transaction;
    if (body?.method === 'execute' && body.params[0].extra === 'broadcastTx') {
      broadcasts.push(tx.hash);
      if (tx.content?.data?.[1]?.metadata?.artifactKind === 'Agreement') agreementSent = true;
      else if (h && agreementSent && !target && `did:demos:agent:${tx.content.from.replace(/^0x/, '')}` === h.prepared.operatorEvidence.seller) target = tx.hash;
    }
    if (target && faking && body?.method === 'nodeCall' && body.params?.[0]?.message === 'getTransactionStatus' && body.params[0].data?.hash === target) {
      polls++; inInclusion.resolve();
      return new Response(JSON.stringify({ result: 200, response: { state: 'pending' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return null;
  };
  const clock = shutdownClock({ autoLanes: true, laneMs: 10000 });
  h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, rpcFault, shutdownTimer: clock });
  cleanup(t, h, { resolve() { faking = false; } });
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: `seller-inclusion-off-grace-${buyerGone}` }).then(value => ({ value }), error => ({ error }));
  await bounded(inInclusion.promise, 120000, 'no seller CREATE reached its inclusion wait');
  if (buyerGone) {
    const port = Number(new URL(h.config.publicOrigin).port);
    openListeners().find(server => server.address()?.port === port).closeAllConnections();
  }
  let settled = false;
  const closing = h.operator.close().then(() => ({}), error => ({ error })).finally(() => { settled = true; });
  await bounded(clock.waiting(clock.graceMs), 10000, 'request drain never started its grace');
  const atGrace = polls;
  await sleep(1500);
  assert.equal(settled, false, 'close waits for the admitted seller request during the grace');
  assert.ok(polls - atGrace >= 2, `the seller keeps its inclusion wait during the grace (${polls - atGrace} polls)`);
  const released = Date.now(), atRelease = polls;
  await clock.advance(clock.graceMs);
  const outcome = await bounded(closing, 20000, 'close waited out the seller inclusion wait after the grace');
  const closeMs = Date.now() - released;
  assert.equal(outcome.error, undefined, String(outcome.error?.stack ?? outcome.error));
  assert.ok(closeMs < 5000, `close ended within 5 s of the grace, not after the inclusion wait (${closeMs} ms)`);
  assert.ok(polls - atRelease <= 1, `the source close ended the inclusion wait (${polls - atRelease} polls after the grace)`);
  faking = false;
  await bounded(purchase, 60000, 'purchase never settled');
  assert.equal(broadcasts.filter(hash => hash === target).length, 1, 'the seller CREATE was sent once');
  for (const file of ['node2-transport.sqlite', 'seller-artifacts.sqlite', 'seller-wallet.sqlite']) assert.deepEqual(locks(h, file), [], `${file} has no lock rows left`);
});

// Admitted app work can take a lane after the lane wait (locking needs no
// source). Close must refuse before the application database closes.
test('switch-off close refuses a lane taken after the wait while the app database is still open', { timeout: 120000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  const release = deferred(), entered = deferred(); cleanup(t, h, release);
  const port = Number(new URL(h.config.publicOrigin).port);
  const appServer = openListeners().find(server => server.address()?.port === port);
  assert.ok(appServer, 'the app listener is visible to the test');
  let holder;
  appServer.once('close', () => { holder = h.prepared.devnetAgreementTransport.journal.withWalletLock('plugin/agreement/after-lane-wait', async () => { entered.resolve(); await release.promise; }); });
  const error = await bounded(h.operator.close().catch(error => error), 20000, 'close did not settle');
  await bounded(entered.promise, 10000, 'the late holder never took its lane');
  assert.equal(error?.code, 'journal-busy', String(error?.stack ?? error));
  assert.equal(h.application.db.prepare('SELECT 1 AS alive').get().alive, 1, 'the app database stays open on this refusal');
  assert.deepEqual(locks(h), ['plugin/agreement/after-lane-wait'], 'the late holder keeps its row');
  release.resolve(); await holder;
  assert.deepEqual(locks(h), []);
});

test('switch-off connection owner refuses new fences once shutdown drains it, and contention is unchanged', async () => {
  const admission = { network: 'n', endpoint: 'https://node2.invalid/', transportAuthority: 'a' };
  const owner = createNode2TransportOwner({ admission });
  const first = await owner.acquireConnectionFence({ address: 'buyer' });
  await assert.rejects(owner.acquireConnectionFence({ address: 'seller' }), /already fenced/, 'contention is refused as on main');
  first.release();
  owner.drain({ keep: claim => claim?.address === 'seller' });
  await assert.rejects(owner.acquireConnectionFence({ address: 'buyer' }), /unavailable/);
  (await owner.acquireConnectionFence({ address: 'seller' })).release();
  owner.drain();
  await assert.rejects(owner.acquireConnectionFence({ address: 'seller' }), /unavailable/);
});

// The OS may hand a just-released port to the next bind. Modelled here: a
// probe socket gets the lowest pool port that no other probe holds right then.
test('operator purchase helper allocates distinct ports even when a released port is reused at once', { timeout: 120000 }, async t => {
  const real = net.createServer, holders = [];
  for (let i = 0; i < 3; i++) { const server = real(); holders.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
  const pool = holders.map(server => server.address().port);
  await Promise.all(holders.map(server => new Promise(resolve => server.close(resolve))));
  const held = new Set();
  net.createServer = () => {
    const probe = new EventEmitter();
    let port = null;
    probe.listen = (_port, _host, ready) => { setImmediate(() => { port = pool.find(candidate => !held.has(candidate)); held.add(port); ready(); }); return probe; };
    probe.address = () => ({ address: '127.0.0.1', family: 'IPv4', port });
    probe.close = done => { held.delete(port); setImmediate(() => done?.()); return probe; };
    return probe;
  };
  let h;
  try { h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true }); }
  finally { net.createServer = real; }
  cleanup(t, h, { resolve() {} });
  const ports = [h.config.publicOrigin, h.config.sellerOrigin, h.config.directoryOrigin].map(origin => Number(new URL(origin).port));
  assert.deepEqual([...ports].sort(), [...pool].sort());
});

// Another test process can still take a probed port in the gap before the
// operator binds it. Modelled here: the first port set names a port a blocker
// holds. The app port fails the operator's construction; the seller port fails
// its attachment, after the app and agent are built.
async function takenPort(t) {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const free = () => new Promise(resolve => blocker.listening ? blocker.close(() => resolve()) : resolve());
  t.after(free);
  return { blocker, taken: blocker.address().port, free };
}
for (const [name, index] of [['app', 0], ['seller', 1]]) {
  test(`operator purchase helper retries construction with a fresh complete port set when its ${name} port is taken (EADDRINUSE)`, { timeout: 120000 }, async t => {
    const { taken, free } = await takenPort(t), sets = [], clock = shutdownClock(), sourceCloses = [];
    clock.beforeSourceClose = () => sourceCloses.push('source');
    const allocatePorts = async count => { const held = await holdFreePorts(count); if (!sets.length) held.ports[index] = taken; sets.push([...held.ports]); return held; };
    const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, allocatePorts, shutdownTimer: clock });
    await free();
    cleanup(t, h, { resolve() {} });
    assert.equal(sets.length, 2, 'one retry');
    assert.equal(sets[0][index], taken);
    const ports = [h.config.publicOrigin, h.config.sellerOrigin, h.config.directoryOrigin].map(origin => Number(new URL(origin).port));
    assert.deepEqual(ports, sets[1], 'the operator runs on the fresh complete port set');
    assert.equal(ports.includes(taken), false);
    assert.deepEqual([await refusedConnection(h.config.publicOrigin), await refusedConnection(h.config.sellerOrigin, tls.connect), await refusedConnection(h.config.directoryOrigin)], ['connected', 'connected', 'connected']);
    // The discarded attempt's cleanup close did not touch the test's shutdown clock.
    assert.deepEqual(sourceCloses, []);
    assert.equal(await Promise.race([clock.waiting(30).then(() => 'grace sleep pending'), sleep(50).then(() => 'clock untouched')]), 'clock untouched');
  });
}

// Each attempt makes its state root here, so a test sees what a failed attempt leaves.
async function stateParent(t) {
  const parent = await mkdtemp(join(tmpdir(), 'operator-purchase-helper-state-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

test('operator purchase helper gives up after three taken port sets with the EADDRINUSE error and leaves nothing listening', { timeout: 120000 }, async t => {
  const { blocker, taken } = await takenPort(t), parent = await stateParent(t);
  let sets = 0;
  const allocatePorts = async count => { const held = await holdFreePorts(count); held.ports[0] = taken; sets++; return held; };
  await assert.rejects(startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, allocatePorts, stateParent: parent }), { code: 'EADDRINUSE' });
  assert.equal(sets, 3);
  assert.deepEqual(await readdir(parent), [], 'no failed attempt leaves its state directory');
  assert.deepEqual(openListeners().filter(server => server !== blocker), [], 'no Node2 fixture, port probe or operator listener is left open');
});

test('operator purchase helper does not retry a construction error other than EADDRINUSE', { timeout: 120000 }, async t => {
  const parent = await stateParent(t), failure = Object.assign(new Error('TEST construction fails before attach'), { code: 'TEST-construction' });
  let sets = 0;
  const allocatePorts = async count => { sets++; return holdFreePorts(count); };
  await assert.rejects(startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, allocatePorts, stateParent: parent, beforeAttach: () => { throw failure; } }), error => error === failure);
  assert.equal(sets, 1, 'exactly one attempt');
  assert.equal(failure.suppressed, undefined, 'its cleanup succeeded');
  assert.deepEqual(await readdir(parent), [], 'the attempt removed its state directory');
  assert.deepEqual(openListeners(), [], 'no Node2 fixture, port probe or operator listener is left open');
});

// The discarded attempt still holds an artifact lane when its operator closes,
// so that close is refused (journal-busy). The remaining cleanup still runs,
// and the EADDRINUSE then carries the refusal and is not retried.
test('operator purchase helper: a failed attempt whose operator close is refused still closes Node2 and removes its state, and is not retried', { timeout: 120000 }, async t => {
  const { blocker, taken } = await takenPort(t), parent = await stateParent(t), release = deferred();
  t.after(() => release.resolve());
  let sets = 0, boots = 0, journal = null;
  const allocatePorts = async count => { const held = await holdFreePorts(count); if (!sets) held.ports[1] = taken; sets++; return held; };
  const error = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, allocatePorts, stateParent: parent,
    wrapPublicJournal: j => { journal = j; return j; },
    beforeAttach: async () => {
      if (++boots > 1) return;
      const entered = deferred();
      journal.withWalletLock('plugin/agreement/held-at-discard', async () => { entered.resolve(); await release.promise; }).catch(() => {});
      await entered.promise;
    } }).then(() => null, e => e);
  assert.equal(error?.code, 'EADDRINUSE', String(error?.stack ?? error));
  // The failed attachment closes its own operator first, which attaches that
  // refusal; the helper's own close then gets the same memoized refusal.
  const [byOperator, byHelper, ...more] = error.suppressed?.errors ?? [];
  assert.deepEqual(byOperator?.errors?.map(e => e.code), ['journal-busy'], 'the refused close is attached, not dropped');
  assert.equal(byHelper, byOperator.errors[0], 'the helper attaches the same refusal');
  assert.deepEqual(more, []);
  assert.equal(sets, 1, 'an attempt whose cleanup failed is not retried');
  assert.deepEqual(await readdir(parent), [], 'the state directory is removed although the operator close threw');
  assert.deepEqual(openListeners().filter(server => server !== blocker), [], 'Node2 and every operator listener are closed');
});
