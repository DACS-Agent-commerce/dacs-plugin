// The native wallet relay's test world: the client's own held transport facade (a node-wallet session built
// from the client's public entries) over a node double that records every request and answers none, the app
// database with purchases in it, a test clock, and the relay mounted on a loopback server.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { DEVNET_NATIVE_BINDING_PATH, DEVNET_NATIVE_RPC_PATH } from '@kynesyslabs/dacs-client';
import { createNodeTransportOwner, createNodeWalletSession } from '@kynesyslabs/dacs-client/node-wallet';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { createWalletRpcRouter } from '../../src/portal/wallet-rpc.mjs';
import { RELAY_ACCESS_HEADER, createRelayAccess } from '../../src/wallet/relay-access.mjs';

export const PUBLIC_ORIGIN = 'https://plugin.test';
export const BUYER = `0x${'b1'.repeat(32)}`;
export const OTHER_WALLET = `0x${'c2'.repeat(32)}`;
export const TX_HASH = 'd3'.repeat(32);
export const START = Date.parse('2026-11-21T12:00:00.000Z');
export const HOUR = 3600_000;
export { DEVNET_NATIVE_BINDING_PATH as BINDING_PATH, DEVNET_NATIVE_RPC_PATH as RPC_PATH };
// The standard BIP-39 test phrase: the session needs a wallet, and the relay never signs with it.
const TEST_PHRASE = Array(11).fill('abandon').concat('about').join(' ');

/** A clock the test moves by hand. */
export function testClock(at = START) {
  const clock = { at, now: () => clock.at };
  return clock;
}

/** The relay's request bodies. */
export const readback = (address = BUYER) => ({ phase: 'readback', address, hash: TX_HASH });
export const release = (address = BUYER) => ({ phase: 'release', address });
export const nodeRead = { method: 'nodeCall', params: [{ message: 'getNetworkInfo', data: {} }] };

/** Adds an account and a purchase in its payment handoff, bound to `wallet`, with its handoff open until `handoffExpiresAt`. */
export function seedPurchase(db, { operationId, accountId = 'acct-relay', wallet = BUYER, handoffExpiresAt = START + HOUR }) {
  const at = new Date(START).toISOString(), until = new Date(handoffExpiresAt).toISOString();
  db.prepare("INSERT OR IGNORE INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES (?, 'wallet', ?, ?)").run(accountId, accountId, at);
  db.prepare(`INSERT INTO operations (id, account_id, kind, idempotency_key, request_hash, status, terms, terms_hash, handoff_token_hash, handoff_expires_at, expires_at, created_at, updated_at)
    VALUES (?, ?, 'purchase', ?, 'request', 'payment_handoff', ?, 'terms', ?, ?, ?, ?, ?)`)
    .run(operationId, accountId, operationId, JSON.stringify({ buyer: { accountId, wallet } }), createHash('sha256').update(operationId).digest('hex'), until, until, at, at);
}

/**
 * Opens the client's held transport facade from its public entries, with the admission it was built under.
 * `nodeRequests` lists every request the transport sent to the node double.
 */
export async function openHeldTransport() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-transport-'));
  const nodeRequests = [];
  const owner = createNodeTransportOwner({ endpoint: 'https://node.test/', transportAuthority: 'node-test', fetchImpl: async (input, init) => {
    nodeRequests.push({ url: String(input), body: init?.body ?? null });
    throw new Error('the node double answers nothing');
  } });
  const local = owner.currentLocal();
  const readAuthority = async () => ({ local, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'relay-test', sessionId: null, participants: [] });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority });
  const journal = openDurableWalletJournal({ path: join(dir, 'journal.db'), mode: 'create' });
  const admission = { binding, currentLocal: owner.currentLocal };
  const session = await createNodeWalletSession({ admission, owner, journal,
    key: new TextEncoder().encode(TEST_PHRASE), approve: async () => false, stopped: () => false, feeCeilingOs: '1' });
  return {
    transport: session.transport, admission, owner, nodeRequests,
    async close() { await session.close(); journal.close(); owner.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Collects every logger call as one JSON line per call. */
export function recordingLogger() {
  const lines = [];
  const write = (level) => (event, fields) => lines.push(JSON.stringify({ level, event, fields }));
  return { lines, debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** Mounts the native relay on loopback. `post(path, body, capability)` sends the capability in the relay header when given. */
export async function startRelay({ db, transport, clock, logger = recordingLogger(), relayAccess = createRelayAccess({ db, now: clock.now }) }) {
  const app = express();
  const requestTargets = [];
  app.use((req, _res, next) => { requestTargets.push(req.originalUrl); next(); });
  app.use(createWalletRpcRouter({ config: { publicOrigin: PUBLIC_ORIGIN }, logger, nativeTransport: transport, relayAccess }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body, capability, headers = {}) {
    const response = await fetch(origin + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(capability === undefined ? {} : { [RELAY_ACCESS_HEADER]: capability }), ...headers } });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* an error page */ }
    return { status: response.status, body: parsed };
  }
  return {
    origin, post, relayAccess, logger, requestTargets,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
