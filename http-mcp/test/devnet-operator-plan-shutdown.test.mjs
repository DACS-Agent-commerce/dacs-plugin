import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async check => {
  const deadline = Date.now() + 60000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'shutdown observation reached within 60 s');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('shutdown drains admitted requests before closing the Vet store, even with a plan waiting for seller approval and a busy artifact journal', { timeout: 180000 }, async t => {
  const approval = deferred(), prompted = deferred(), admitted = deferred(), releaseRequest = deferred();
  const h = await startOperatorPurchaseNode2({
    authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request }) => {
      if (request.content?.artifactKind === 'CompositeVerificationRecord') { prompted.resolve(); return approval.promise; }
      return true;
    },
  });
  const originalFetch = globalThis.fetch;
  // The purchase as the plan started it. The operator's owned close also closes
  // the application database, so later checks use this object and the file.
  let planResponse, purchase, planned;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    approval.resolve(false); releaseRequest.resolve();
    await purchase;
    // A rejected operator close is cached. Release the fixture's remaining
    // resources explicitly after its background plan has unwound.
    if (planned) await until(() => !h.application.services.protocol.planRunning(planned));
    for (const stop of [() => h.running.close(), () => h.application.close(), () => h.composition.sellerAgent.close(),
      () => h.operator.close(), () => h.prepared.composition.publicJournal.close(), () => h.node2.close()]) {
      await Promise.resolve().then(stop).catch(() => {});
    }
    await rm(h.root, { recursive: true, force: true });
  });
  const operation = () => {
    const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
    return row && h.application.services.ops.get(row.account_id, row.id);
  };
  const responseSeen = deferred(), buyerStopped = new Error('TEST buyer stops after the plan response');
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (new URL(url).pathname.endsWith('/agreement/plan')) {
      planResponse = { status: response.status, body: await response.clone().json() };
      responseSeen.resolve();
      throw buyerStopped;
    }
    return response;
  };
  purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'shutdown-waiting-plan' })
    .then(value => ({ value }), error => ({ error }));
  await prompted.promise;
  await responseSeen.promise;
  assert.equal((await purchase).error, buyerStopped);
  globalThis.fetch = originalFetch;
  assert.equal(planResponse.status, 202);
  assert.equal(planResponse.body.error, 'plan_in_progress');
  planned = operation();
  assert.equal(h.application.services.protocol.planRunning(planned), true);

  // Hold one admitted app request so the drain's ordering can be observed.
  const app = h.application.app;
  h.application.app = (req, res) => {
    if (req.url === '/test-shutdown-drain') { admitted.resolve(); void releaseRequest.promise.then(() => res.end('done')); }
    else app(req, res);
  };
  const heldRequest = originalFetch(`${h.config.publicOrigin}/test-shutdown-drain`);
  await admitted.promise;
  const store = h.prepared.composition.partyVetStore;
  const [[key, retained]] = await store.entries();
  const closing = h.operator.close().then(() => ({}), error => ({ error }));
  await until(async () => (await originalFetch(`${h.config.publicOrigin}/health`)).status === 503);
  try {
    assert.deepEqual(await store.update(key, () => undefined), retained, 'the store remains open during the request drain');
  } finally {
    releaseRequest.resolve(); await heldRequest;
  }
  const closed = await closing;
  assert.ok(!closed.error || closed.error.code === 'journal-busy', String(closed.error?.stack ?? closed.error));
  assert.throws(() => store.usage(), { code: 'journal-closed' }, 'shutdown closes the store even if a journal is busy');
  let changed = false;
  await assert.rejects(store.update(key, () => { changed = true; return retained; }), { code: 'journal-closed' });
  assert.equal(changed, false, 'a later write fails before its change callback');
  approval.resolve(false);
  await until(() => !h.application.services.protocol.planRunning(planned));
  const saved = new DatabaseSync(h.prepared.config.databasePath, { readOnly: true });
  try {
    assert.equal(JSON.parse(saved.prepare('SELECT state FROM operations WHERE id = ?').get(planned.id).state).protocol.planned, undefined, 'the interrupted flight saves no plan');
  } finally { saved.close(); }
  assert.equal(h.node2.chain.wire.record.accepted.filter(tx => tx.content?.data?.[1]?.metadata?.artifactKind === 'CompositeVerificationRecord').length, 0, 'the denied approval sends no Vet CREATE after shutdown');
});
