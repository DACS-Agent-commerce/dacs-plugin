import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_PROFILE, createCoordinateStore, createProtocolPurchases, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
import { openDatabase } from '../../src/store/database.mjs';
import { createAgreementCreateDelivery, CREATE_JOURNAL_HEADER } from '../../src/portal/agreement-create-delivery.mjs';
import { createAgreementCreateRouter } from '../../src/portal/agreement-create-routes.mjs';
import { createPortalRouter } from '../../src/portal/routes.mjs';
import { createChallengeService } from '../../src/wallet/challenges.mjs';
import { createRelayAccess } from '../../src/wallet/relay-access.mjs';
import { createStartIntents } from '../../src/portal/start-intent.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { seedPurchase, testClock, recordingLogger, PUBLIC_ORIGIN, HOUR } from './relay-world.mjs';

export const hashOf = (value) => createHash('sha256').update(value).digest('hex');
export const SIGNED_HASH = 'd3'.repeat(32);
export const signedHistory = [{ seq: 1, kind: 'signed', passId: 'approval' }];

/** A real app database and challenge service, with purchase and gate inputs controlled by the test. */
export function deliveryWorld({ path = ':memory:', wallet = createEphemeralWallet(), clock = testClock(), seed = true } = {}) {
  const db = openDatabase(path), logger = recordingLogger();
  if (seed) seedPurchase(db, { operationId: 'purchase', wallet: wallet.address });
  if (seed) {
    const terms = { buyer: { accountId: 'acct-relay', wallet: wallet.address }, network: 'testnet', protocol: { jobId: 'job-purchase' } };
    db.prepare("UPDATE operations SET status = 'agreement_pending', terms = ?, job_id = ?, state = ? WHERE id = 'purchase'")
      .run(JSON.stringify(terms), terms.protocol.jobId, JSON.stringify({ protocol: { stage: 'agreement-signing', planned: { draft: {}, plan: { agreementHash: 'agreement-hash' } } } }));
    db.prepare("INSERT INTO wallets VALUES (?, 'acct-relay', 'ed25519', ?, 'link-challenge')").run(wallet.address, new Date(clock.now()).toISOString());
  }
  const load = (id = 'purchase') => {
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
    return row && { id: row.id, accountId: row.account_id, status: row.status, terms: JSON.parse(row.terms), termsHash: row.terms_hash,
      state: JSON.parse(row.state), expiresAt: row.expires_at };
  };
  const purchases = {
    portalOperation(id, token) {
      const row = db.prepare('SELECT handoff_token_hash FROM operations WHERE id = ?').get(id);
      if (!row || typeof token !== 'string' || row.handoff_token_hash !== hashOf(token)) throw Object.assign(new Error('not found'), { code: 'not_found' });
      return load(id);
    },
    portalEvidence: () => ({ protocol: { stage: 'agreement-signing' } }),
    status: () => ({ history: [] }),
  };
  const accounts = { walletOwner: (address) => db.prepare('SELECT account_id FROM wallets WHERE address = ?').get(address)?.account_id };
  const starts = createStartIntents({ purchases, accounts, now: clock.now });
  const gateState = { on: true, cause: null, stopped: false };
  const gates = { purchasesOn: () => gateState.on, bindingCause: () => gateState.cause, stopped: () => gateState.stopped };
  const delivery = createAgreementCreateDelivery({ db, starts, gates, now: clock.now });
  const challenges = createChallengeService({ db, origin: PUBLIC_ORIGIN, ttlSeconds: 60, now: clock.now });
  const relayAccess = createRelayAccess({ db, now: clock.now });
  const start = () => starts.issue(load(), wallet.address);
  const request = { kind: DEVNET_AGREEMENT_KIND, profile: DEVNET_AGREEMENT_PROFILE, network: 'testnet', owner: `did:demos:agent:${wallet.address.slice(2)}`,
    artifactKind: 'Agreement', jobId: 'job-purchase', logicalAddress: 'agreement', contentHash: 'content', envelopeHash: 'envelope', transaction: { content: ['exact request'] } };
  const send = (value = request) => delivery.walletFactoryFor('purchase')({ anchorJournal: null }).request({ method: 'sendTransaction', params: [value] });
  let closed = false;
  return { db, logger, load, wallet, clock, purchases, accounts, starts, start, gateState, gates, delivery, challenges, relayAccess, request, send, close: () => { if (!closed) { closed = true; db.close(); } } };
}

/** Mounts both the standalone effect router and the existing purchase view on loopback. */
export async function serveDelivery(t, world) {
  const app = express();
  app.use(createAgreementCreateRouter({ ...world, config: { publicOrigin: PUBLIC_ORIGIN }, now: world.clock.now }));
  app.use(createPortalRouter({ ...world, createDelivery: world.delivery, config: { publicOrigin: PUBLIC_ORIGIN }, now: world.clock.now, timeline: { record() {} } }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = async (action, body, { id = 'purchase', journal, raw = false } = {}) => {
    const path = action === 'view' ? 'view' : `agreement-create/${action}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/portal/api/purchase/${id}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(journal ? { [CREATE_JOURNAL_HEADER]: journal } : {}) },
      body: raw ? body : canonicalize(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return post;
}

/** Issues and signs a challenge from the mounted real service. */
export async function signedClaim(post, world, record = world.start()) {
  const challenge = await post('challenge', { token: 'purchase', start: record.id });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  return { token: 'purchase', challengeId: challenge.body.challengeId, signature: world.wallet.signHex(challenge.body.message) };
}

/** Constructs the installed client's protocol with the same factory the host composes. */
export function installedProtocol(world, held, walletFactory = world.delivery.walletFactoryFor('purchase'), journal = held.journal) {
  return createProtocolPurchases({ admission: held.admission, db: world.db,
    ops: { get: world.load, getByHandoff: () => world.load(), history: () => [], transition: () => world.load() },
    coordinates: createCoordinateStore({ db: world.db }), store: createSqlitePurchaseStore(),
    dacsProtocol: { sellerEndpoint: () => 'https://seller.test/', walletAgreement: { rpcUrl: 'https://node.test/', network: 'testnet', journal,
      walletFactory, sourceCapability: held.transport, signer: null } } });
}

export { HOUR };
