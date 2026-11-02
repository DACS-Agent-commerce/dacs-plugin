import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, seedSellerListing, approvePurchase } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { SCOPES } from '../src/auth/scopes.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { createLegacyPublicationService } from '../src/legacy-publications.mjs';

const REMOVED_PUBLICATION_WRITERS = ['submitIdentitySignature', 'submitListingSignature', 'prepareHandoff', 'reportWalletResult',
  'registrationRequest', 'submitRegistration', 'verifyPublication', 'verifyByHandoff'];

function historicalPublication(h, user, status = 'publication_handoff') {
  const { ops, coordinates } = h.app.services;
  const accountId = h.app.services.accounts.walletOwner(user.wallet.address);
  const { operation } = ops.createIdempotent({
    accountId, kind: 'listing_publication', idempotencyKey: 'TEST-abandoned-publication', request: {}, status,
    terms: { wallet: user.wallet.address, network: 'demos-testnet' }, termsHash: 'ab'.repeat(32), state: {},
    expiresAt: new Date(0).toISOString(),
  });
  coordinates.save({ operationId: operation.id, kind: 'storage-program-create', network: 'demos-testnet',
    from: user.wallet.address, nonceFence: 0, expectedNonce: 1, target: 'TEST-original-storage', payload: {} });
  return operation;
}

test('an abandoned v1 publication survives restart, can be cancelled by its owner and releases the next purchase', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const owner = await linkedUser(h), other = await linkedUser(h);
  const publication = historicalPublication(h, owner);
  const reservation = h.app.services.coordinates.get(publication.id);
  const seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'recovered-report' });
  const purchase = await tool(h, owner, 'prepare_purchase', {
    listingId: 'recovered-report', version: 1, seller: seller.claim, idempotencyKey: 'TEST-after-publication',
  });
  assert.equal(purchase.error, 'legacy_publication_unresolved');
  assert.equal(h.chain.nonceOf(owner.wallet.address), 0);
  await h.restart();
  const foreign = await tool(h, other, 'cancel_wallet_handoff', { operationId: publication.id });
  assert.equal(h.app.services.ops.get(publication.accountId, publication.id).status, 'publication_handoff');
  const cancelled = await tool(h, owner, 'cancel_wallet_handoff', { operationId: publication.id });
  assert.deepEqual(cancelled, { operationId: publication.id, status: 'cancelled', cancelled: true });
  assert.equal(foreign.error, 'not_found');
  assert.deepEqual(h.app.services.coordinates.get(publication.id), reservation, 'retain original coordinates for late readback');
  assert.equal(h.chain.nonceOf(owner.wallet.address), 0, 'cancellation sent nothing');
  const health = opsHealth({ databasePath: h.config.databasePath, now: Date.parse(publication.createdAt) + 600000 });
  assert.equal(health.healthy, true, 'a cancelled unread handoff does not leave a permanent health failure');
  assert.equal(health.legacyPublications.find(row => row.operationId === publication.id).status, 'cancelled');
  await h.restart();
  const history = h.app.services.ops.history(publication.id);
  assert.equal((await tool(h, owner, 'cancel_wallet_handoff', { operationId: publication.id })).error, 'invalid_state');
  assert.deepEqual(h.app.services.ops.history(publication.id), history, 'repeated cancellation has no second effect');
  const next = await tool(h, owner, 'prepare_purchase', {
    listingId: 'recovered-report', version: 1, seller: seller.claim, idempotencyKey: 'TEST-recovered-purchase',
  });
  const handoff = await approvePurchase(h, next.operationId, next.approvalUrl, owner.wallet);
  assert.equal(handoff.approved.status, 'payment_handoff');
  assert.equal(handoff.approved.payload.content.nonce, 1, 'the original unused slot is available');
  assert.equal(h.chain.nonceOf(owner.wallet.address), 0, 'preparing the next purchase sent nothing');
});

for (const state of ['nonce advanced', 'broadcast_reported', 'publication_uncertain']) {
  test(`legacy publication cancellation retains the reservation when ${state}`, async t => {
    const h = await startHarness(); t.after(() => h.close());
    const owner = await linkedUser(h);
    const publication = historicalPublication(h, owner, state === 'nonce advanced' ? 'publication_handoff' : state);
    if (state === 'nonce advanced') h.chain.setNonce(owner.wallet.address, 1);
    const before = h.app.services.ops.get(publication.accountId, publication.id);
    const reservation = h.app.services.coordinates.get(publication.id);
    const result = await tool(h, owner, 'cancel_wallet_handoff', { operationId: publication.id });
    assert.equal(result.error, 'invalid_state');
    assert.deepEqual(h.app.services.ops.get(publication.accountId, publication.id), before);
    assert.deepEqual(h.app.services.coordinates.get(publication.id), reservation);
  });
}

test('legacy publication cancellation requires the agent scope before invoking a service', async t => {
  let calls = 0;
  const server = createMcpServerFactory({ config: { publicOrigin: 'https://plugin.example' }, services: {
    accounts: { resolveFromToken: () => ({ id: 'TEST-owner' }) },
    agents: { cancel() { calls++; throw new Error('must require the agent scope'); } },
    purchases: { cancel() { calls++; throw new Error('must not route to purchases'); } },
  }, logger: { info() {}, error() {} } })();
  t.after(() => server.close());
  for (const scopes of [[], [SCOPES.PURCHASES_WRITE]]) {
    const result = await server._registeredTools.cancel_wallet_handoff.handler({ operationId: `pub_${'A'.repeat(16)}` }, {
      http: { authInfo: { scopes, extra: { issuer: 'TEST', subject: 'TEST' } } },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result._meta), /insufficient_scope/);
    assert.match(JSON.stringify(result._meta), /dacs\.agents\.write/);
  }
  assert.equal(calls, 0);
});

test('the app wires callable historical list and cancel, and the recovery service keeps no publication writers', async t => {
  const h = await startHarness(); t.after(() => h.close());
  for (const method of ['list', 'cancel']) assert.equal(typeof h.app.services.agents[method], 'function', `agents.${method} is wired`);
  const { ops, coordinates, chain } = h.app.services;
  const service = createLegacyPublicationService({ db: h.app.db, ops, coordinates, chain });
  for (const kept of ['list', 'cancel']) assert.equal(typeof service[kept], 'function', `${kept} is kept`);
  for (const removed of REMOVED_PUBLICATION_WRITERS) assert.equal(removed in service, false, `${removed} is removed`);
});

test('an owner still sees historical agents and their publication status after the publication service is deleted', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const owner = await linkedUser(h), other = await linkedUser(h);
  const publication = historicalPublication(h, owner);
  h.app.db.prepare(`INSERT INTO agents (id, account_id, wallet_address, listing_id, profile, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('agt_TEST-historical', publication.accountId, owner.wallet.address, 'historical-report', '{}', 'onboarding', publication.createdAt, publication.createdAt);
  h.app.db.prepare('UPDATE operations SET subject_id = ? WHERE id = ?').run('agt_TEST-historical', publication.id);
  await h.restart();
  const status = await tool(h, owner, 'get_account_status', {});
  assert.deepEqual(status.agents, [{ agentId: 'agt_TEST-historical', listingId: 'historical-report', status: 'onboarding', publicationStatus: 'publication_handoff' }]);
  assert.deepEqual((await tool(h, other, 'get_account_status', {})).agents, []);
});
