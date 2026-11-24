// SDK purchases on: which buyer session a purchase call reaches. A session is an account and one of its linked wallets,
// proven by the wallet-link challenge. A call whose credential has expired, or whose purchase names a wallet the account
// has not proven, answers not_found before any session or node read. The node is a scripted double on an .invalid
// origin; the client holds every purchase action, so a call that reaches it is refused profile_not_admitted with no cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedUser, tool } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { FIXTURE_CHAIN, NODE_ORIGIN, accountOf, postJson, prepareArgs, seedHandoffPurchase, switchOnHarness, tp1Node } from './helpers/switch-on-world.mjs';

const HELD = (error) => error.code === 'profile_not_admitted' && error.cause === undefined;
const refusedWith = (code) => (error) => error.code === code;
const PASSIVE = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning'];
// Every purchase action except prepare, each called with a purchase id and its handoff token.
const ACTIONS = ['issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane', 'reportWalletResult', 'cancel', 'agreementIdentity',
  'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each passive reader of `purchases` refuses not_configured naming the missing passive reader, as with purchases off. */
function assertPassiveAsOff(purchases, purchase, label) {
  for (const name of PASSIVE) {
    assert.throws(() => purchases[name](purchase.id, purchase.token), (error) => error.code === 'not_configured' && error.message === 'sdk_part_missing: P19', `${label}: ${name}`);
  }
}

test('a portal purchase action whose stored handoff expiry has passed, is missing or is malformed answers 404 not_found before any buyer session or node read, never a server error', async (t) => {
  const { h, node } = await switchOnHarness(t);
  const user = await linkedUser(h);
  const accountId = accountOf(h, user);
  const reads = node.reads.length;
  for (const [label, handoffExpiresAt] of [['expired', new Date(Date.now() - 1000).toISOString()], ['missing', null], ['malformed', 'bad']]) {
    const purchase = seedHandoffPurchase(h, { accountId, wallet: user.wallet.address, key: label, handoffExpiresAt });
    const answer = await postJson(h, `/portal/api/purchase/${purchase.id}/approve`, { token: purchase.token, challengeId: 'c', signature: 's' });
    assert.deepEqual([answer.status, answer.body.error], [404, 'not_found'], label);
    await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: purchase.id, token: purchase.token }), refusedWith('not_found'), label);
  }
  assert.equal(node.reads.length, reads, 'no buyer session was bound');
  const open = seedHandoffPurchase(h, { accountId, wallet: user.wallet.address, key: 'open' });
  await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: open.id, token: open.token }), HELD, 'an open handoff reaches the client');
});

test('an expired MCP bearer token is refused 401 before any purchase session lookup or node read', async (t) => {
  const { h, node } = await switchOnHarness(t);
  const user = await linkedUser(h);
  const reads = node.reads.length;
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prepare_purchase', arguments: { listingId: 'fixture-report', version: 1, seller: user.wallet.claim, idempotencyKey: 'expired' } } };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + DAY_MS });
  let response;
  try {
    response = await fetch(h.mcpUrl, { method: 'POST', body: JSON.stringify(call),
      headers: { authorization: `Bearer ${user.token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /expired/);
  assert.equal(node.reads.length, reads);
});

test("account A's purchase naming B's linked wallet is refused not_found on the MCP and portal paths before B's reader or any effect", async (t) => {
  const { h, node } = await switchOnHarness(t);
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, b, 'b-1')), HELD, 'B\'s session is bound');
  const crossed = seedHandoffPurchase(h, { accountId: accountOf(h, a), wallet: b.wallet.address, key: 'crossed' });
  const reads = node.reads.length;
  const rows = databaseRows(h.app.db);
  assert.equal((await tool(h, a, 'cancel_wallet_handoff', { operationId: crossed.id })).error, 'not_found', 'MCP');
  const portal = await postJson(h, `/portal/api/purchase/${crossed.id}/handoff`, { token: crossed.token });
  assert.deepEqual([portal.status, portal.body.error], [404, 'not_found'], 'portal');
  assert.equal(node.reads.length, reads, 'neither B\'s reader nor a new one was used');
  assert.equal(databaseRows(h.app.db), rows);
});

test("the purchase facade routes every member by startup state and buyer session: the five passive readers refuse as with purchases off in every state, and each action answers the startup code, not_found without a proven session, or the client's hold with one", async (t) => {
  const failed = (await switchOnHarness(t, { node: tp1Node({ chainIdentity: FIXTURE_CHAIN }) })).h;
  const failedUser = await linkedUser(failed);
  const failedPurchase = seedHandoffPurchase(failed, { accountId: accountOf(failed, failedUser), wallet: failedUser.wallet.address });
  assertPassiveAsOff(failed.app.services.purchases, failedPurchase, 'startup failed');
  await assert.rejects(failed.app.services.purchases.prepare(prepareArgs(failed, failedUser)), refusedWith('tp1_connection_unverified'), 'startup failed: prepare');
  for (const name of ACTIONS) {
    await assert.rejects(failed.app.services.purchases[name]({ operationId: failedPurchase.id, token: failedPurchase.token }), refusedWith('tp1_connection_unverified'), `startup failed: ${name}`);
  }

  const { h } = await switchOnHarness(t);
  const { purchases } = h.app.services;
  const user = await linkedUser(h);
  const proven = seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: user.wallet.address, key: 'proven' });
  const unproven = seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: `0x${'cd'.repeat(32)}`, key: 'unproven' });
  assertPassiveAsOff(purchases, proven, 'bound');
  await assert.rejects(purchases.prepare({ ...prepareArgs(h, user), accountId: 'acct_without_wallets' }), refusedWith('not_found'), 'no proven session: prepare');
  await assert.rejects(purchases.prepare(prepareArgs(h, user)), HELD, 'proven session: prepare');
  for (const name of ACTIONS) {
    await assert.rejects(purchases[name]({ operationId: unproven.id, token: unproven.token }), refusedWith('not_found'), `no proven session: ${name}`);
    await assert.rejects(purchases[name]({ operationId: proven.id, token: proven.token }), HELD, `proven session: ${name}`);
  }

  h.app.db.prepare('DELETE FROM wallets WHERE address = ?').run(user.wallet.address);
  for (const name of ACTIONS) await assert.rejects(purchases[name]({ operationId: proven.id, token: proven.token }), refusedWith('not_found'), `unlinked: ${name}`);
  assertPassiveAsOff(purchases, proven, 'unlinked');
});

test("after buyer session A ends by unlinking its wallet, A's next action refuses not_found before a bind, node read or write, and B's bound session still reaches the client's hold", async (t) => {
  const { h, node } = await switchOnHarness(t);
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  const purchaseOfA = seedHandoffPurchase(h, { accountId: accountOf(h, a), wallet: a.wallet.address, key: 'a' });
  await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: purchaseOfA.id, token: purchaseOfA.token }), HELD, 'A\'s session is bound');
  await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, b, 'b-1')), HELD, 'B\'s session is bound');
  h.app.db.prepare('DELETE FROM wallets WHERE address = ?').run(a.wallet.address);
  const reads = node.reads.length;
  const rows = databaseRows(h.app.db);
  await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: purchaseOfA.id, token: purchaseOfA.token }), refusedWith('not_found'));
  await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, a, 'a-after-end')), refusedWith('not_found'));
  assert.equal(node.reads.length, reads, 'the ended session bound nothing and read nothing');
  assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM agreement_create_events').get().n, 0);
  assert.equal(databaseRows(h.app.db), rows);
  await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, b, 'b-2')), HELD, 'B is still served by its own session');
  assert.equal(node.reads.length, reads, 'B reused its binding');
});

test('a restart after a buyer session bound and before any effect sends and writes nothing on its own, and the reopened app binds a session again only on the next action', async (t) => {
  const origins = [];
  const { h, node } = await switchOnHarness(t, { origins });
  const user = await linkedUser(h);
  const purchase = seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: user.wallet.address });
  await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: purchase.id, token: purchase.token }), HELD);
  const rows = databaseRows(h.app.db);
  await h.restart();
  const reads = node.reads.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node.reads.length, reads, 'the restarted app bound no session on its own');
  assert.equal(databaseRows(h.app.db), rows, 'nothing was written on its own');
  assert.deepEqual(origins.filter((origin) => ![NODE_ORIGIN, h.chain.url, h.directory.url].includes(origin)), [], 'no seller request');
  await assert.rejects(h.app.services.purchases.prepareHandoff({ operationId: purchase.id, token: purchase.token }), HELD);
  assert.ok(node.reads.length > reads, 'the next action bound a new session');
});
