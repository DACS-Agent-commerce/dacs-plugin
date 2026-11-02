import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import tls from 'node:tls';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

// The built-in operator reads the switch from its environment when created;
// this file runs in its own process.
process.env.DACS_COMMIT_ON_SIGNATURE = 'on';

test('switch-on operator registers the early route and completes one purchase with one commitment CREATE', { timeout: 300000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  const post = async path => (await h.fetchImpl(`${h.config.sellerOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  assert.equal(await post('/dacs/v1/commitments/unknown'), 404);
  assert.notEqual(await post('/dacs/v1/commitments/signature'), 404, 'the enabled operator serves the early route');
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'operator-signature-overlap-001' });
  assert.equal(result.status, 'delivery-ready', JSON.stringify(result));
  const kinds = h.node2.chain.wire.record.accepted.map(tx => tx.content.data[1].metadata.artifactKind);
  assert.equal(kinds.filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  assert.equal(kinds.filter(kind => kind === 'Agreement').length, 1);
  assert.equal(h.node2.chain.record.accepted.length, 1, 'one native DEM transfer');
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const kindsOf = h => h.node2.chain.wire.record.accepted.map(tx => tx.content?.data?.[1]?.metadata?.artifactKind);
const broadcastKind = body => body?.method === 'execute' && body?.params?.[0]?.extra === 'broadcastTx'
  ? body.params[0].data?.response?.data?.transaction?.content?.data?.[1]?.metadata?.artifactKind : undefined;
const heldLocks = h => {
  const db = new DatabaseSync(join(h.config.stateDirectory, 'node2-transport.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT key FROM locks').all().map(row => row.key); } finally { db.close(); }
};

// Pauses the seller's nonce read for its early commitment (the first one after
// the buyer's Agreement lands), or with afterIntent its publication right after
// the durable no-resend intent, or with pendingInclusion lets the commitment
// broadcast and reports it pending, starts shutdown, then lets it continue
// holdMs later. With buyerHoldUntilMs, the buyer's next chain read after that
// (its step takes the released connection) is held until that long after
// shutdown started. After a restart the buyer's verify_deal must reach payment
// approval by reading the one commitment back.
async function shutdownDuringEarlyCommitment(t, key, shutdown, { holdMs = 100, afterIntent = false, pendingInclusion = false, buyerHoldUntilMs = 0 } = {}) {
  const entered = deferred(), release = deferred();
  let h, paused = false, released = false, commitment = null, started = null, buyerHeldAt = null;
  void release.promise.then(() => { released = true; });
  const pause = async () => { paused = true; entered.resolve(); await release.promise; };
  const rpcFault = async ({ body }) => {
    if (pendingInclusion) {
      if (!commitment && h && broadcastKind(body) === 'FinalityCommitmentRecord') { commitment = body.params[0].data.response.data.transaction.hash; entered.resolve(); }
      if (commitment && !released && body?.params?.[0]?.message === 'getTransactionStatus' && body.params[0].data?.hash === commitment)
        return new Response(JSON.stringify({ result: 200, response: { state: 'pending' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (buyerHoldUntilMs && released && buyerHeldAt === null && body?.params?.[0]?.message === 'getTransactionStatus' && body.params[0].data?.hash !== commitment) {
        buyerHeldAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, Math.max(0, started + buyerHoldUntilMs - buyerHeldAt)));
      }
      return null;
    }
    if (!afterIntent && !paused && h && kindsOf(h).includes('Agreement') && body?.params?.[0]?.message === 'getAddressNonce') await pause();
    return null;
  };
  const wrapPublicJournal = afterIntent ? journal => ({ ...journal, async put(name, value) {
    await journal.put(name, value);
    if (!paused && value?.stage === 'intent' && value?.input?.artifactKind === 'FinalityCommitmentRecord') await pause();
  } }) : null;
  h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, rpcFault, wrapPublicJournal });
  // A failed shutdown must not keep the process alive.
  t.after(async () => {
    release.resolve();
    if (await h.close().then(() => true, () => false)) return;
    for (const stop of [() => h.running?.close?.(), () => h.application?.close?.(), () => h.composition?.sellerAgent?.close?.(), () => h.operator?.close?.()]) await Promise.resolve().then(stop).catch(() => {});
    await h.node2.close().catch(() => {});
    await rm(h.root, { recursive: true, force: true });
  });
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: key }).then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('seller pause point was not reached')), 60000))]);
  started = Date.now();
  const closing = shutdown(h).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, holdMs));
  release.resolve();
  const closed = await closing;
  t.diagnostic(`shutdown took ${Date.now() - started} ms with the seller held ${holdMs} ms`);
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  assert.ok(Date.now() - started >= holdMs, 'shutdown waited for the held seller request');
  if (buyerHoldUntilMs) assert.ok(buyerHeldAt !== null && buyerHeldAt - started < 30000, `the buyer took the connection before the grace (${buyerHeldAt === null ? 'never' : buyerHeldAt - started} ms)`);
  if (!closed.value?.restarted) assert.deepEqual(heldLocks(h), [], 'shutdown leaves no durable lane lock behind');
  await purchase;
  assert.equal(kindsOf(h).filter(kind => kind === 'FinalityCommitmentRecord').length, 1, 'the admitted seller commitment completes before seller state closes');
  if (!closed.value?.restarted) await h.restart();
  const records = (await h.prepared.composition.publicJournal.entries()).map(([, value]) => value).filter(value => value?.input?.artifactKind === 'FinalityCommitmentRecord');
  assert.equal(records.length, 1);
  assert.match(records[0].hash ?? '', /^[0-9a-f]{64}$/, 'the retained commitment has a transaction to read back');
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
  await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  const after = h.application.db.prepare("SELECT status, json_extract(state, '$.protocol.stage') AS stage FROM operations WHERE id = ?").get(row.id);
  assert.deepEqual({ ...after }, { status: 'awaiting_approval', stage: 'seller-committed' });
  const kinds = kindsOf(h);
  assert.equal(kinds.filter(kind => kind === 'FinalityCommitmentRecord').length, 1, 'restart reads the commitment back; it is not sent again');
  assert.equal(kinds.filter(kind => kind === 'Agreement').length, 1);
}

test('operator close during an early commitment waits for it and leaves the purchase recoverable', { timeout: 300000 }, t =>
  shutdownDuringEarlyCommitment(t, 'operator-signature-shutdown-close-001', h => h.operator.close()));

// The scripts stop the listener, the app, the seller agent and then the operator.
test('the scripts\' shutdown order during an early commitment waits for it before closing seller state', { timeout: 300000 }, t =>
  shutdownDuringEarlyCommitment(t, 'operator-signature-shutdown-stop-001', async h => { await h.restart(); return { restarted: true }; }));

// Held past the operator's 30 s shutdown grace after the no-resend intent: the
// commitment's queued reservation must still be granted, or it is never sent.
test('operator close past the shutdown grace still sends an early commitment held after its intent', { timeout: 300000 }, t =>
  shutdownDuringEarlyCommitment(t, 'operator-signature-shutdown-grace-001', h => h.operator.close(), { holdMs: 31000, afterIntent: true }));

// The commitment is sent but stays pending past the grace, so the seller holds
// the connection while buyer work queues behind it. That buyer work is cut at
// the grace: it must not be granted the connection when the seller releases it
// and then outlive shutdown holding its durable lane locks.
test('operator close past the shutdown grace does not hand the connection to buyer work queued behind the seller', { timeout: 300000 }, t =>
  shutdownDuringEarlyCommitment(t, 'operator-signature-shutdown-inclusion-001', h => h.operator.close(), { holdMs: 35000, pendingInclusion: true }));

// The seller releases the connection 25 s into shutdown and the buyer's queued
// step takes it, then holds it past the 30 s grace and past the 10 s lane-lock
// wait after it. The grace keeps a current holder, so that step must fail once
// the source closes and release its durable lane locks before the journals close.
test('operator close lets buyer work that holds the connection at the grace unwind before the journals close', { timeout: 300000 }, t =>
  shutdownDuringEarlyCommitment(t, 'operator-signature-shutdown-holder-001', h => h.operator.close(), { holdMs: 25000, pendingInclusion: true, buyerHoldUntilMs: 45000 }));

// A lane lock this process holds in the source journal when close starts: close
// waits for it before closing the journals, for at most 10 s.
async function laneLockAtClose(t, holdMs) {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  const release = deferred();
  t.after(async () => {
    release.resolve();
    if (await h.close().then(() => true, () => false)) return;
    for (const stop of [() => h.running?.close?.(), () => h.application?.close?.(), () => h.composition?.sellerAgent?.close?.()]) await Promise.resolve().then(stop).catch(() => {});
    await h.node2.close().catch(() => {});
    await rm(h.root, { recursive: true, force: true });
  });
  const entered = deferred();
  const holder = h.prepared.devnetAgreementTransport.journal.withWalletLock('plugin/agreement/lane-lock-at-close', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  if (Number.isFinite(holdMs)) setTimeout(release.resolve, holdMs);
  const started = Date.now();
  const closed = await Promise.race([h.operator.close().then(() => ({}), error => ({ error })),
    new Promise(resolve => setTimeout(() => resolve({ error: new Error('close did not settle within 20 s') }), 20000))]);
  const elapsed = Date.now() - started;
  release.resolve(); await holder;
  return { closed, elapsed, locks: heldLocks(h) };
}

test('operator close waits for this process\'s lane locks before closing the journals', { timeout: 300000 }, async t => {
  const { closed, elapsed, locks } = await laneLockAtClose(t, 3000);
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  assert.ok(elapsed >= 3000, `close waited for the lane lock (${elapsed} ms)`);
  assert.deepEqual(locks, []);
});

test('operator close waits at most 10 s for a lane lock that is never released', { timeout: 300000 }, async t => {
  const { closed, elapsed, locks } = await laneLockAtClose(t, Infinity);
  assert.equal(closed.error?.code, 'journal-busy', String(closed.error?.stack ?? closed.error));
  assert.ok(elapsed >= 10000 && elapsed < 20000, `close gave up after the bounded wait (${elapsed} ms)`);
  assert.deepEqual(locks, [], 'the holder released its lock once it ended');
});

test('shutdown answers an admitted seller request on its connection and refuses the next one', { timeout: 300000 }, async t => {
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  const port = Number(new URL(h.config.sellerOrigin).port), connect = () => tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
  const socket = connect(); await once(socket, 'secureConnect');
  let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { text += chunk; });
  const ended = once(socket, 'close');
  const request = `POST /dacs/v1/commitments/signature HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n`;
  socket.write(request); // admitted: the seller handler now waits for the body
  await new Promise(resolve => setTimeout(resolve, 300));
  const closing = h.operator.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  const fresh = await new Promise(resolve => { const s = connect(); s.once('secureConnect', () => { s.destroy(); resolve('connected'); }); s.once('error', error => resolve(error.code)); });
  assert.equal(fresh, 'ECONNREFUSED', 'shutdown stops accepting seller connections');
  socket.write(`{}${request}{}`); // the rest of the admitted body, then a second request on the same connection
  await closing; await ended;
  const statuses = [...text.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map(match => Number(match[1]));
  assert.equal(statuses.length, 2, text);
  assert.notEqual(statuses[0], 503, 'the admitted request is answered by the seller handler');
  assert.equal(statuses[1], 503);
  assert.match(text, /"error":"operator_stopping"/);
});
