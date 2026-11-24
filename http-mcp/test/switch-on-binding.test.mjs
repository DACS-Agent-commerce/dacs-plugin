// SDK purchases on: what each purchase route answers after the startup TP-1 binding. A failed binding is latched, and
// every purchase action answers its bare tp1_* code; the wallet report answers 503 naming that code. After a successful
// binding, routes that first read the purchase through the passive reader answer its 503 not_configured, as with
// purchases off. The node is a scripted double on an .invalid origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedUser, tool } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { FIXTURE_CHAIN, accountOf, postJson, seedHandoffPurchase, switchOnHarness, tp1Node } from './helpers/switch-on-world.mjs';

// Portal routes whose handler reads the purchase through the passive reader before any action.
const PASSIVE_FIRST_ROUTES = ['protocol/recheck', 'intent/start', 'intent/plan', 'intent/sign'];
const TX_HASH = `0x${'ab'.repeat(32)}`;
const passiveRefusal = (answer) => [answer.status, answer.body.error, answer.body.message];
const PASSIVE_REFUSAL = [503, 'not_configured', 'sdk_part_missing: P19'];

/** A data directory whose participant enrollment file cannot be read (it is a directory). Removed after the test. */
function unreadableEnrollment(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'switch-on-enrollment-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'participant-enrollment.json'));
  return dataDir;
}

/** A linked user of `h` and one of their purchases with an open handoff. */
async function buyerWithPurchase(h) {
  const user = await linkedUser(h);
  return { user, purchase: seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: user.wallet.address }) };
}

test('with the switch on, a node that cannot be reached at startup latches tp1_authority_failed and an unreadable participant enrollment file tp1_enrollment_unreadable; purchase tools answer that code and the wallet report answers 503 naming it, with nothing written', async (t) => {
  for (const [label, options, code] of [['unreachable node', { node: tp1Node({ mode: 'unreachable' }) }, 'tp1_authority_failed'],
    ['unreadable enrollment', { env: { DACS_DATA_DIR: unreadableEnrollment(t) } }, 'tp1_enrollment_unreadable']]) {
    const { h } = await switchOnHarness(t, options);
    const { startupResult } = h.app.services.switchOn;
    assert.deepEqual(startupResult, { ok: false, binding: null, failureCode: code }, label);
    assert.ok(Object.isFrozen(startupResult), 'the startup result cannot change');
    const { user, purchase } = await buyerWithPurchase(h);
    const rows = databaseRows(h.app.db);
    const prepared = await tool(h, user, 'prepare_purchase', { listingId: 'fixture-report', version: 1, seller: user.wallet.claim, idempotencyKey: 'startup-failed' });
    assert.equal(prepared.error, code, `${label}: prepare_purchase`);
    assert.equal((await tool(h, user, 'cancel_wallet_handoff', { operationId: purchase.id })).error, code, `${label}: cancel_wallet_handoff`);
    const report = await postJson(h, `/portal/api/purchase/${purchase.id}/report`, { token: purchase.token, txHash: TX_HASH });
    assert.deepEqual([report.status, report.body.error, report.body.details?.reason], [503, 'not_configured', code], `${label}: report`);
    assert.equal(databaseRows(h.app.db), rows, label);
  }
});

test('with the switch on and the startup binding refused, the recheck and Start routes answer the binding\'s bare tp1 code once the handoff token authenticates, before the passive reader or any Start, and a wrong token gets the passive refusal as with purchases off', async (t) => {
  const { h } = await switchOnHarness(t, { node: tp1Node({ chainIdentity: FIXTURE_CHAIN }), env: { DACS_INTENT_APPROVAL: 'on' } });
  const { user, purchase } = await buyerWithPurchase(h);
  const rows = databaseRows(h.app.db);
  const body = { address: user.wallet.address, intent: 'intent', signature: 'signature', agreementSignature: 'signature', anchorSignature: 'signature' };
  for (const route of PASSIVE_FIRST_ROUTES) {
    const refused = await postJson(h, `/portal/api/purchase/${purchase.id}/${route}`, { ...body, token: purchase.token });
    assert.deepEqual([refused.status, refused.body.error], [409, 'tp1_connection_unverified'], route);
    const unauthenticated = await postJson(h, `/portal/api/purchase/${purchase.id}/${route}`, { ...body, token: 'x'.repeat(43) });
    assert.deepEqual(passiveRefusal(unauthenticated), PASSIVE_REFUSAL, `${route} with a wrong token`);
  }
  assert.throws(() => h.app.services.purchases.portalOperation(purchase.id, purchase.token), (error) => error.code === 'not_configured' && error.message === 'sdk_part_missing: P19',
    'the passive reader itself answers as with purchases off');
  assert.equal(databaseRows(h.app.db), rows);
});

test('after a successful startup binding, the recheck and Start routes and the CREATE challenge, claim and pass answer the passive reader\'s 503 not_configured before any Start, buyer session, relay capability or write', async (t) => {
  const { h, node } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' } });
  const { user, purchase } = await buyerWithPurchase(h);
  const reads = node.reads.length;
  const rows = databaseRows(h.app.db);
  for (const route of PASSIVE_FIRST_ROUTES) {
    const answer = await postJson(h, `/portal/api/purchase/${purchase.id}/${route}`, { token: purchase.token, address: user.wallet.address, intent: 'intent', signature: 'signature' });
    assert.deepEqual(passiveRefusal(answer), PASSIVE_REFUSAL, route);
  }
  const createBodies = { challenge: { start: 's', token: purchase.token }, claim: { challengeId: 'c', signature: 's', token: purchase.token },
    pass: { hash: 'h', history: [], start: 's', token: purchase.token } };
  for (const [route, body] of Object.entries(createBodies)) {
    const answer = await postJson(h, `/portal/api/purchase/${purchase.id}/agreement-create/${route}`, body);
    assert.deepEqual([answer.status, answer.body.error], [503, 'not_configured'], `CREATE ${route}`);
  }
  assert.equal(node.reads.length, reads, 'no buyer session was bound');
  assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM relay_capabilities').get().n, 0, 'no relay capability was minted');
  assert.equal(databaseRows(h.app.db), rows);
});

test('after a successful startup binding, the wallet report answers 503 not_configured naming the client\'s hold, and 404 not_found for a purchase with no proven buyer session, with nothing written', async (t) => {
  const { h } = await switchOnHarness(t);
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  const own = seedHandoffPurchase(h, { accountId: accountOf(h, a), wallet: a.wallet.address, key: 'own' });
  const crossed = seedHandoffPurchase(h, { accountId: accountOf(h, a), wallet: b.wallet.address, key: 'crossed' });
  const rows = databaseRows(h.app.db);
  const held = await postJson(h, `/portal/api/purchase/${own.id}/report`, { token: own.token, txHash: TX_HASH });
  assert.deepEqual([held.status, held.body.error, held.body.details?.reason], [503, 'not_configured', 'profile_not_admitted']);
  const unproven = await postJson(h, `/portal/api/purchase/${crossed.id}/report`, { token: crossed.token, txHash: TX_HASH });
  assert.deepEqual([unproven.status, unproven.body.error], [404, 'not_found']);
  assert.equal(databaseRows(h.app.db), rows);
});
