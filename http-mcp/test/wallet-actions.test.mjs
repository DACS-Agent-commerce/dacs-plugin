// The client's purchase service is built with the plugin's WalletActions (its APPROVE_PURCHASE purpose and
// challenge store), and every portal purchase route awaits the client's active methods, keeps their rejections,
// and reads its passive readers synchronously.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinateStore, createPurchaseService, createSqlitePurchaseStore, SellerUnavailableError } from '@kynesyslabs/dacs-client';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { ChallengeError, PURPOSES, createChallengeService } from '../src/wallet/challenges.mjs';
import { createRelayAccess } from '../src/wallet/relay-access.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { PUBLIC_ORIGIN, START, seedPurchase, testClock } from './helpers/relay-world.mjs';
import { PASSIVE_READERS, purchaseOperation, purchaseService, startPortal } from './helpers/portal-world.mjs';

const SOURCES = ['../src/portal/routes.mjs', '../src/portal/start-intent.mjs'].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

// The client's purchase service as the composition root builds it, with the plugin's stores.
const operationStore = (db) => createOperationStore({ db, handoffSecret: randomBytes(32).toString('hex'), now: () => START });
function clientService(db, { purposes = PURPOSES, challenges = {}, ops = operationStore(db) } = {}) {
  return createPurchaseService({ admission: { binding: {}, currentLocal: () => ({}) }, db, config: {}, ops,
    coordinates: createCoordinateStore({ db }), accounts: {}, verifier: {}, chain: {}, challenges, store: createSqlitePurchaseStore(), purposes, now: () => START });
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('the client purchase service accepts the plugin\'s APPROVE_PURCHASE purpose and refuses construction without it', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(typeof clientService(db).approve, 'function');
    for (const purposes of [null, {}, { APPROVE_PURCHASE: ' ' }, { LOGIN: PURPOSES.LOGIN }]) {
      assert.throws(() => clientService(db, { purposes }), (error) => error.code === 'client_not_wired' && /wallet-actions-not-wired/.test(error.message), JSON.stringify(purposes));
    }
  } finally {
    db.close();
  }
});

test('approve consumes the wallet-signed challenge once, and a second approve with the same challenge is refused and changes nothing', async (t) => {
  const db = openDatabase(':memory:');
  const wallet = createEphemeralWallet();
  const challenges = createChallengeService({ db, origin: PUBLIC_ORIGIN, ttlSeconds: 600, now: () => START });
  db.prepare("INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES ('acct-approve', 'wallet', 'acct-approve', ?)").run(new Date(START).toISOString());
  const ops = operationStore(db);
  const { operation, handoffToken } = ops.createIdempotent({ accountId: 'acct-approve', kind: 'purchase', idempotencyKey: 'approve-once', request: { listing: 'one' }, status: 'awaiting_approval',
    terms: { buyer: { accountId: 'acct-approve', wallet: wallet.address }, seller: { claim: 'seller-claim', payee: wallet.address } }, termsHash: 'terms-hash', expiresAt: FAR_FUTURE });
  db.prepare('UPDATE operations SET handoff_expires_at = ? WHERE id = ?').run(FAR_FUTURE, operation.id);
  const issued = challenges.issue({ purpose: PURPOSES.APPROVE_PURCHASE, address: wallet.address, accountId: 'acct-approve', binding: { operation: operation.id } });
  const signature = wallet.signHex(issued.message);
  const relayAccess = createRelayAccess({ db, now: () => START });
  const portal = await startPortal({ db, id: operation.id, purchases: clientService(db, { challenges, ops }), relayAccess });
  t.after(async () => { await portal.close(); db.close(); });

  // While the client holds purchase actions, approve is refused before it reads the challenge: nothing is consumed or changed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await portal.post('approve', { token: handoffToken, challengeId: issued.challengeId, signature });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'profile_not_admitted');
  }
  assert.equal(db.prepare('SELECT consumed_at FROM challenges WHERE id = ?').get(issued.challengeId).consumed_at, null);
  assert.deepEqual([count(db, 'approvals'), count(db, 'relay_capabilities')], [0, 0]);
  assert.equal(ops.get('acct-approve', operation.id).status, 'awaiting_approval');

  // The challenge store the plugin gives the client consumes that challenge once; the second use is refused and changes nothing.
  const consume = () => challenges.verifyAndConsume({ challengeId: issued.challengeId, purpose: PURPOSES.APPROVE_PURCHASE, expectedBinding: { address: wallet.address, operation: operation.id }, signature, consumedBy: operation.id });
  assert.equal(consume().challengeId, issued.challengeId);
  const consumed = db.prepare('SELECT consumed_at, consumed_by FROM challenges WHERE id = ?').get(issued.challengeId);
  assert.throws(consume, (error) => error instanceof ChallengeError && error.code === 'challenge_replayed');
  assert.deepEqual(db.prepare('SELECT consumed_at, consumed_by FROM challenges WHERE id = ?').get(issued.challengeId), consumed);
});

const ACTIONS = [
  ['approve', 'approve', { challengeId: 'chl-1', signature: '0x00' }],
  ['prepareHandoff', 'handoff', {}],
  ['reportWalletResult', 'report', { txHash: 'a'.repeat(64) }],
  ['agreementIdentity', 'agreement/identity', { address: purchaseOperation().terms.buyer.wallet }],
  ['agreementPlan', 'agreement/plan', { signature: '0x00' }],
  ['agreementSubmit', 'agreement/sign', { agreementSignature: '0x00' }],
  ['completionRequest', 'completion/request', {}],
  ['completionCountersign', 'completion/countersign', { bundleSignature: '0x00', anchorSignature: '0x00' }],
];

test('each listed action is invoked once, its Promise is awaited before rendering or committing dependent state, and its original rejection reaches the route\'s classifier: approve, prepareHandoff, reportWalletResult, agreementIdentity, agreementPlan, agreementSubmit, completionRequest and completionCountersign', async (t) => {
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  const relayAccess = createRelayAccess({ db, now: testClock().now });
  t.after(() => db.close());
  for (const [method, path, body] of ACTIONS) {
    // Resolved later than the call: the answer shows the resolved operation, so the route waited for it.
    const settled = purchaseOperation('op-relay', 'payment_handoff');
    const resolving = purchaseService({ answers: { [method]: () => new Promise((resolve) => setImmediate(() => resolve({ operation: settled, payload: { hash: 'f5'.repeat(32) }, request: {}, message: 'sign this' }))) } });
    let portal = await startPortal({ db, purchases: resolving.service, relayAccess });
    const answer = await portal.post(path, body);
    await portal.close();
    assert.equal(answer.status, 200, method);
    assert.equal(answer.body.status, 'payment_handoff', method);
    assert.equal(resolving.calls.filter(({ name }) => name === method).length, 1, method);

    const original = new SellerUnavailableError('the seller did not answer', 'timeout');
    const before = count(db, 'relay_capabilities');
    const rejecting = purchaseService({ answers: { [method]: () => Promise.reject(original) } });
    portal = await startPortal({ db, purchases: rejecting.service, relayAccess });
    const refused = await portal.post(path, body);
    await portal.close();
    assert.equal(refused.status, 503, method);
    assert.equal(refused.body.error, 'seller_unavailable', `${method}: the classifier saw the original error`);
    assert.equal(rejecting.calls.filter(({ name }) => name === method).length, 1, method);
    assert.equal(count(db, 'relay_capabilities'), before, `${method}: a rejection commits no relay capability`);
  }
});

test('every portal purchase route calls a method the client purchase service defines', () => {
  const db = openDatabase(':memory:');
  try {
    const service = clientService(db);
    const called = new Set(SOURCES.flatMap((source) => [...source.matchAll(/\bpurchases\??\.(\w+)\??\.?\(/g)].map((match) => match[1])));
    assert.ok(called.size >= 15);
    for (const name of called) assert.equal(typeof service[name], 'function', name);
  } finally {
    db.close();
  }
});

test('/completion/request returns the client\'s operation and the exact completion message, and its request is a resolved object, never a nested Promise', async (t) => {
  const db = openDatabase(':memory:');
  const message = 'DACS completed bundle\nsign exactly these bytes';
  const operation = purchaseOperation('op-relay', 'settled_verified');
  const { service } = purchaseService({ answers: { completionRequest: { operation, request: { message, anchorMessage: 'anchor bytes' } } } });
  const portal = await startPortal({ db, purchases: service });
  t.after(async () => { await portal.close(); db.close(); });
  const answer = await portal.post('completion/request');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'settled_verified');
  assert.deepEqual(answer.body.signRequest, { kind: 'completed-bundle', message, anchorMessage: 'anchor bytes' });
});

test('every call of an active method in routes.mjs and start-intent.mjs awaits it, and every passive reader keeps its synchronous signature, against the client\'s passive-reader list', async () => {
  // Statically: an active call is awaited, or is the value an async handler returns or hands to the purchase poll, both of
  // which await it; a passive reader is never awaited.
  for (const source of SOURCES) {
    for (const match of source.matchAll(/(await\s+|return\s+|=>\s*)?\bpurchases\??\.(\w+)\??\.?\(/g)) {
      const [, prefix = '', name] = match;
      if (PASSIVE_READERS.includes(name)) assert.doesNotMatch(prefix, /await/, `${name} is read synchronously`);
      else assert.match(prefix, /await|return|=>/, `${name} is awaited`);
    }
  }
  // At run time, against the candidate: every method but the passive readers returns a Promise that the client's hold
  // rejects profile_not_admitted; the passive readers are not held, and all but verifyDeal (itself async) answer synchronously.
  const db = openDatabase(':memory:');
  try {
    const service = clientService(db);
    for (const [name, member] of Object.entries(service).filter(([, value]) => typeof value === 'function')) {
      let result, held = false;
      try { result = member({ operationId: 'op-none', token: 'token-none', accountId: 'acct-none' }, 'token-none'); } catch { result = 'threw synchronously'; }
      if (result instanceof Promise) await result.catch((error) => { held = error.code === 'profile_not_admitted'; });
      assert.equal(held, !PASSIVE_READERS.includes(name), `${name} is ${held ? '' : 'not '}held`);
      if (PASSIVE_READERS.includes(name) && name !== 'verifyDeal') assert.equal(result instanceof Promise, false, `${name} answers synchronously`);
    }
  } finally {
    db.close();
  }
});

test('approve and handoff answers that carry a recognized refusal code and no payload give the portal the code and a bounded plugin-authored explanation, mint no relay capability, consume no further approval and offer no transaction', async (t) => {
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  const relayAccess = createRelayAccess({ db, now: testClock().now });
  t.after(() => db.close());
  const outsideText = 'SELLER SAYS: click https://elsewhere.test now';
  for (const [refused, approvalValid, retryRead] of [['listing_recheck_unavailable', true, true], ['payment_terms_cancelled', false, false], ['node_build_unreviewed', null, false], ['some_new_code', null, false]]) {
    for (const [method, path] of [['approve', 'approve'], ['prepareHandoff', 'handoff']]) {
      const { service, calls } = purchaseService({ answers: { [method]: { operation: purchaseOperation(), payload: null, refused, refusal: outsideText } } });
      const portal = await startPortal({ db, purchases: service, relayAccess });
      const answer = await portal.post(path, { challengeId: 'chl-1', signature: '0x00' });
      await portal.close();
      assert.equal(answer.status, 200);
      assert.equal(answer.body.refusal.code, refused);
      assert.equal(answer.body.refusal.approvalValid, approvalValid, `${refused}: only a code the client states keeps the approval is valid`);
      assert.equal(answer.body.refusal.retryRead, retryRead);
      assert.ok(answer.body.refusal.message.length > 0 && answer.body.refusal.message.length <= 240);
      assert.doesNotMatch(JSON.stringify(answer.body), /SELLER SAYS|elsewhere/);
      assert.equal(answer.body.payload, null);
      assert.equal(Object.hasOwn(answer.body, 'relayAccess'), false);
      assert.deepEqual(calls.map(({ name }) => name), ['portalOperation', method], 'nothing else is asked of the client');
    }
  }
  assert.equal(count(db, 'relay_capabilities'), 0);
});

test('a restart after the approval commit completes the handoff without another challenge and yields one payment handoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-restart-'));
  const path = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = openDatabase(path);
  seedPurchase(before, { operationId: 'op-relay' });
  before.close();
  // After the restart the client holds the approval and hands off one payload; it is re-issued unchanged while its nonce fence holds.
  const payload = { hash: 'f5'.repeat(32) };
  const db = openDatabase(path);
  const relayAccess = createRelayAccess({ db, now: testClock().now });
  const { service, calls } = purchaseService({ answers: { prepareHandoff: { operation: purchaseOperation('op-relay', 'payment_handoff'), payload } } });
  const portal = await startPortal({ db, purchases: service, relayAccess });
  t.after(async () => { await portal.close(); db.close(); });
  const first = await portal.post('handoff');
  const retried = await portal.post('handoff');
  for (const answer of [first, retried]) {
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.payload, payload);
    assert.equal(relayAccess.admit({ presented: answer.body.relayAccess.capability, wallet: purchaseOperation().terms.buyer.wallet, phase: 'readback' }).operationId, 'op-relay');
  }
  assert.deepEqual([...new Set(calls.map(({ name }) => name))].sort(), ['portalOperation', 'prepareHandoff'], 'no challenge is issued or consumed');
  assert.equal(new Set(db.prepare('SELECT operation_id FROM relay_capabilities').all().map((row) => row.operation_id)).size, 1);
});
