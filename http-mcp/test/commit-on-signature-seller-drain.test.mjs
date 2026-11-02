import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { failOnLeftoverListeners } from './helpers/listener-guard.mjs';
import { shutdownClock } from './helpers/shutdown-clock.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

// Existing shutdown tests pause after taking the connection. Here the real,
// authenticated HTTP request is admitted, but its seller method has not yet
// reserved the connection. Past the 30 s app grace, drain must preserve that
// seller reservation; closing the owner at that point strands the request.
test('operator close drains an admitted seller request that still needs the connection after the app grace', { timeout: 300000 }, async t => {
  const entered = deferred(), release = deferred();
  let walletError, earlyEnded = false;
  const clock = shutdownClock({ autoLanes: true, laneMs: 10000 });
  const h = await startOperatorPurchaseNode2({
    shutdownTimer: clock,
    authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true,
    wrapSellerWalletFactory: factory => options => {
      const wallet = factory(options);
      return { ...wallet, async request(input) {
        if (input.params?.[0]?.artifactKind === 'FinalityCommitmentRecord') {
          entered.resolve(); await release.promise;
        }
        const answer = await wallet.request(input);
        if (!answer?.success) walletError = answer?.error;
        return answer;
      } };
    },
    beforeAttach: ({ composition }) => {
      const agent = composition.sellerAgent, early = agent.commitOnSignature;
      agent.commitOnSignature = async input => {
        try { return await early(input); }
        finally { earlyEnded = true; }
      };
    },
  });
  t.after(async () => {
    release.resolve();
    if (await h.close().then(() => true, () => false)) return;
    for (const stop of [() => h.running?.close?.(), () => h.application?.close?.(), () => h.composition?.sellerAgent?.close?.(), () => h.operator?.close?.()]) await Promise.resolve().then(stop).catch(() => {});
    await h.node2.close(); await rm(h.root, { recursive: true, force: true });
  });
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'seller-request-drain-before-fence-001' }).then(value => ({ value }), error => ({ error }));
  await bounded(entered.promise, 120000, 'authenticated early request was never admitted');
  let closed = false;
  const closing = h.operator.close().then(() => ({}), error => ({ error })).finally(() => { closed = true; });
  await bounded(clock.waiting(clock.graceMs), 10000, 'request drain never started its grace');
  await clock.advance(clock.graceMs);
  const waiting = !closed && !earlyEnded;
  release.resolve();
  const outcome = await bounded(closing, 60000, 'seller drain did not finish');
  await bounded(purchase, 60000, 'buyer did not finish after seller drain');
  assert.ok(waiting, 'operator close remains pending while the admitted seller request is in flight');
  assert.equal(outcome.error, undefined, String(outcome.error?.stack ?? outcome.error));
  assert.equal(earlyEnded, true, 'seller method ends before close resolves');
  assert.equal(walletError, undefined, JSON.stringify(walletError));
  assert.equal(h.node2.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 1, 'the drained seller request reserves the connection and completes its one CREATE');
});

// Switch on: a refusal keeps the
// app DB open, cuts listeners and is memoized; a clean close keeps the DB open
// through the lane wait and closes it after.
for (const refuse of [true, false]) test(`switch-on close ${refuse ? 'refuses a held lane, cuts listeners and keeps the app DB' : 'keeps the app DB open through the lane wait, then closes it'}`, { timeout: 120000 }, async t => {
  const clock = shutdownClock({ graceMs: 30, laneMs: 100 });
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, shutdownTimer: clock });
  const release = deferred(), entered = deferred();
  t.after(async () => {
    release.resolve();
    if (!await h.close().then(() => true, () => false)) {
      for (const stop of [() => h.application?.close?.(), () => h.composition?.sellerAgent?.close?.()]) await Promise.resolve().then(stop).catch(() => {});
      await h.node2.close(); await rm(h.root, { recursive: true, force: true });
    }
    await failOnLeftoverListeners();
  });
  const locks = () => {
    const db = new DatabaseSync(join(h.config.stateDirectory, 'node2-transport.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT key FROM locks ORDER BY key').all().map(row => row.key); } finally { db.close(); }
  };
  const key = `plugin/agreement/switch-on-${refuse ? 'refused' : 'clean'}`;
  const holder = h.prepared.devnetAgreementTransport.journal.withWalletLock(key, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const closing = h.operator.close(), outcome = closing.then(() => ({}), error => ({ error }));
  await bounded(clock.waiting(50), 10000, 'lane polling never started');
  assert.equal(h.application.db.prepare('SELECT 1 AS alive').get().alive, 1, 'app DB open during the lane wait');
  const mcp = await fetch(`${h.config.publicOrigin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 503);
  if (refuse) {
    await clock.advance(50, clock.laneMs);
    const { error } = await bounded(outcome, 10000, 'refusal did not settle');
    assert.equal(error?.code, 'journal-busy');
    await assert.rejects(fetch(`${h.config.publicOrigin}/portal/api/devnet-native-wallet-rpc`), 'a refused close cuts the remaining listener');
    assert.equal(h.application.db.prepare('SELECT 1 AS alive').get().alive, 1);
    assert.strictEqual(h.running.close(), closing);
    assert.deepEqual(locks(), [key]);
    release.resolve(); await holder;
  } else {
    release.resolve(); await holder; await clock.advance(50);
    assert.equal((await bounded(outcome, 10000, 'clean close did not settle')).error, undefined);
    assert.throws(() => h.application.db.prepare('SELECT 1'), /database is not open/);
    assert.deepEqual(locks(), []);
  }
});
