// With SDK purchases off, routes and tools get a refusal object in place of the client's purchase service: it keeps
// the service's member names, its passive readers answer not_configured and every purchase action sdk_purchases_off.
// With the switch on and the startup binding refused or timed out, the same object answers every purchase action
// with the binding's own tp1_* code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { startHarness } from './helpers/harness.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { FIXTURE_CHAIN, NODE_ORIGIN, routedFetch, switchOnHarness, switchedOn, tp1Node } from './helpers/switch-on-world.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';

// The client purchase service's passive readers (named in its createPurchaseService documentation) and its other
// members, every one a purchase action.
const PASSIVE = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning'];
const ACTIVE = ['prepare', 'issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane', 'reportWalletResult', 'cancel',
  'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck'];
// Members of the client's protocol object, which the off composition does not hand on at all.
const ABSENT = ['holdChainReadback', 'assertBuyerAccess', 'readIssued', 'readIssuedPayment', 'observeReportedPayment'];
const PURCHASE = { operationId: 'pur_AAAAAAAAAAAAAAAA', token: 'handoff-token', accountId: 'acct_1' };

test('the object the off composition passes to routes and tools has exactly the client\'s passive purchase methods; every active name (cancel, reportWalletResult, protocolRecheck, holdChainReadback and the rest of the inventory) is absent or refuses sdk_purchases_off with zero state change', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { purchases } = h.app.services;
  assert.ok(Object.isFrozen(purchases));
  assert.deepEqual(Object.keys(purchases).sort(), [...PASSIVE, ...ACTIVE].sort(), 'no member beyond the client service\'s own');
  for (const name of ABSENT) assert.equal(purchases[name], undefined, name);

  const before = databaseRows(h.app.db);
  for (const name of PASSIVE) {
    assert.throws(() => purchases[name](PURCHASE.operationId, PURCHASE.token), (error) => error.code === 'not_configured' && error.message === 'sdk_part_missing: P19', name);
  }
  for (const name of ACTIVE) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(purchases[name](PURCHASE), (error) => error.code === 'sdk_purchases_off', `${name}, call ${attempt + 1}`);
    }
  }
  assert.equal(databaseRows(h.app.db), before, 'no refusal changed the database');
  assert.deepEqual(Object.keys(purchases).sort(), [...PASSIVE, ...ACTIVE].sort(), 'refusing changes nothing on the object');
});

// The portal routes whose first call is a purchase action, and the Agreement CREATE effect routes with their exact members.
const PORTAL_ACTIONS = ['challenge', 'approve', 'handoff', 'native-payment/lane', 'report', 'agreement/identity', 'agreement/plan', 'agreement/sign',
  'completion/request', 'completion/countersign'];
const CREATE_ROUTES = { challenge: { start: 's', token: 't' }, claim: { challengeId: 'c', signature: 's', token: 't' }, pass: { hash: 'h', history: [], start: 's', token: 't' } };

/** Every effect route of the app at `origin` (public origin `publicOrigin`) answers 409 with exactly `code`, and nothing is written. */
async function assertEffectRoutesRefuse({ origin, publicOrigin = origin, db, purchases }, code) {
  const before = databaseRows(db);
  const post = async (path, body) => {
    const response = await fetch(`${origin}/portal/api/purchase/${PURCHASE.operationId}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: publicOrigin }, body: canonicalize(body) });
    return [response.status, (await response.json()).error];
  };
  const actionBody = { token: PURCHASE.token, address: `0x${'ab'.repeat(32)}`, challengeId: 'challenge', signature: 'signature', key: 'lane' };
  for (const action of PORTAL_ACTIONS) assert.deepEqual(await post(action, actionBody), [409, code], action);
  for (const [route, body] of Object.entries(CREATE_ROUTES)) assert.deepEqual(await post(`agreement-create/${route}`, body), [409, code], route);
  for (const name of ['prepare', 'cancel']) await assert.rejects(purchases[name](PURCHASE), (error) => error.code === code, name);
  assert.equal(databaseRows(db), before);
}

test('with the switch on and the startup binding refused or timed out, every effect route refuses with the binding\'s own tp1 code, not profile_not_admitted', async (t) => {
  // Refused: the node answers the SDK's refused fixture chain.
  const { h } = await switchOnHarness(t, { node: tp1Node({ chainIdentity: FIXTURE_CHAIN }), env: { DACS_INTENT_APPROVAL: 'on' } });
  await assertEffectRoutesRefuse({ origin: h.origin, db: h.app.db, purchases: h.app.services.purchases }, 'tp1_connection_unverified');
  const user = await linkedUser(h);
  const prepared = await tool(h, user, 'prepare_purchase', { listingId: 'fixture-report', version: 1, seller: user.wallet.claim, idempotencyKey: 'startup-refused' });
  assert.equal(prepared.error, 'tp1_connection_unverified', prepared.message);

  // Timed out: the node never answers, and the 10 s deadline passes on a mock clock.
  const dataDir = mkdtempSync(join(tmpdir(), 'binding-timeout-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir, DACS_INTENT_APPROVAL: 'on' };
  const config = switchedOn({ chain: { rpcUrl: NODE_ORIGIN, network: 'demos-testnet', timeoutMs: 1000 } })(loadConfig(env));
  const node = tp1Node({ mode: 'gated' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = createApp({ config, fetchImpl: routedFetch(node), logger: createLogger({ level: 'error', sink: () => {} }) });
  await node.requested;
  t.mock.timers.tick(10_000);
  const app = await starting;
  t.mock.timers.reset();
  t.after(() => app.close());
  const server = http.createServer(app.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assertEffectRoutesRefuse({ origin, publicOrigin: config.publicOrigin, db: app.db, purchases: app.services.purchases }, 'tp1_authority_timeout');
  // The node's late answer changes nothing until a restart.
  node.release();
  await new Promise((resolve) => setImmediate(resolve));
  await assertEffectRoutesRefuse({ origin, publicOrigin: config.publicOrigin, db: app.db, purchases: app.services.purchases }, 'tp1_authority_timeout');
});
