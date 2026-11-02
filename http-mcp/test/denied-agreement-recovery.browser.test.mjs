// Real Chrome (DACS_TEST_CHROME only), portal UI, packaged embedded wallet with
// trusted clicks, OAuth/MCP, loopback broker over a reopenable SQLite journal.
// X's CREATE is explicitly denied in the wallet dialog; the same wallet then
// anchors fresh Y once. Local simulated chain/seller only; payment held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reopenableJournal, createKey } from './helpers/current-broker-interactions.mjs';
import { browserBrokerSetup, signThroughSession } from './helpers/current-broker-interactions-browser.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

installLoopbackOnlyGuard();

test('Chrome: trusted denial of X retires only its unsigned handoff; fresh Y on the same wallet queues once, trusted approval anchors at nonce 1 over the reopened journal', { timeout: 180000 }, async (t) => {
  const store = await reopenableJournal(t);
  const w = await browserBrokerSetup(t, store);
  const broadcasts = () => w.chain.wire.record.broadcastAttempts.length;
  const adapters = async () => Object.fromEntries((await store.adapters()).map((a) => [a.logicalAddress, a.stage]));
  const x = await w.prepare('x'), y = await w.prepare('y');
  await w.open(w.page, x);
  const xCreate = await signThroughSession(w.page, x, w.address, { expectCreate: true });
  await xCreate.dialog.getByRole('button', { name: UI.reject }).click();
  await w.page.locator('#flow').getByText(/The DACS Agreement was refused/).waitFor({ timeout: 25000 });
  const vx = (await x.verify()).protocol;
  assert.equal(vx.stage, 'agreement-rejected'); assert.equal(vx.agreement, null);
  assert.equal((await store.journal.get(createKey(x.id))).stage, 'denied');
  assert.equal((await adapters())[x.logicalAddress], 'denied-unsigned');
  assert.deepEqual(await store.lanes(), []); assert.equal(broadcasts(), 0);
  await store.reopen();
  const second = await w.newPage();
  await w.open(second.page, y);
  const yCreate = await signThroughSession(second.page, y, w.address, { expectCreate: true });
  assert.equal((await store.journal.get(createKey(y.id))).stage, 'issued-to-browser');
  assert.notEqual(yCreate.shown.contentHash, xCreate.shown.contentHash);
  await yCreate.dialog.getByRole('button', { name: UI.approve }).click();
  await second.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const vy = (await y.verify()).protocol;
  assert.equal(vy.stage, 'agreement-anchored'); assert.equal(vy.agreement.hash, yCreate.shown.contentHash); assert.equal(vy.limits.payment, 'held');
  await store.reopen();
  assert.deepEqual(await store.lanes(), [{ stage: 'broadcast-accepted', nonce: 1, logicalAddress: y.logicalAddress }]);
  assert.deepEqual(await adapters(), { [x.logicalAddress]: 'denied-unsigned', [y.logicalAddress]: 'verified' });
  assert.equal((await store.journal.get(createKey(x.id))).stage, 'denied', 'X denial retained, never redelivered');
  assert.deepEqual(w.chain.wire.record.accepted.map((tx) => Number(tx.content.nonce)), [1]);
  await second.page.locator('#dacs-recheck').click(); await x.verify(); await y.verify();
  assert.equal(broadcasts(), 1);
  const claims = w.broker.filter((r) => r.route === 'claim');
  assert.deepEqual(claims.filter((c) => c.delivered).map((c) => c.id), [x.id, y.id], 'one delivered CREATE per operation');
  assert.deepEqual(w.broker.filter((r) => r.route === 'complete').map((r) => [r.id, r.state]), [[x.id, 'denied'], [y.id, 'completed']]);
  assert.deepEqual(store.inspectLocks(), []);
  assert.ok(w.requests.every((r) => new URL(r.url).origin === w.h.origin));
  assertNoSecrets(w.requests, [w.password], 'browser HTTP requests'); assertNoSecrets(w.h.logs, [w.password], 'server logs');
  t.diagnostic(JSON.stringify({ chrome: w.launched?.version, x: 'denied/agreement-rejected/denied-unsigned', y: vy.stage, broadcasts: broadcasts(), nonces: [1] }));
});

test('Chrome denial recovery connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
