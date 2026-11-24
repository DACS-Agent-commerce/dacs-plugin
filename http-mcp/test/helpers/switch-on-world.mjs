// A test world for the SDK purchases on composition: the usual harness (chain and directory fixtures, OAuth, MCP)
// with the switch turned on after loadConfig, a remote node RPC origin and a scripted TP-1 node double behind it.
// The node double answers the chain-identity block reads the client's authority reader sends; every other request
// fails. Requests to any other origin go to the real fixtures.
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { canonicalize } from '@kynesyslabs/dacs';
import { startHarness } from './harness.mjs';

export const NODE_ORIGIN = 'https://node.chain.invalid';
export const TRANSPORT_AUTHORITY = 'tp1-node';
export const HELD = 'profile_not_admitted from @kynesyslabs/dacs-client@0.1.0-alpha.0';

const answer = (response) => new Response(JSON.stringify({ result: 200, response, require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } });

/**
 * A scripted node. `chainIdentity` is the identity its blocks name; `mode` is `answer`, `silent` (never answers),
 * `gated` (answers once `release()` is called) or `unreachable` (every request fails as a refused connection). `reads`
 * lists the node message of every request it received; `requested` resolves at the first request after it was last reset.
 */
export function tp1Node({ chainIdentity = TP1_APPROVED_IDENTITY_RECORD.chainIdentity, mode = 'answer' } = {}) {
  const node = { chainIdentity, mode, reads: [], releases: [] };
  let notify;
  node.reset = () => { node.requested = new Promise((resolve) => { notify = resolve; }); };
  node.reset();
  node.release = () => { for (const release of node.releases.splice(0)) release(); };
  node.fetch = async (_input, init) => {
    const call = JSON.parse(init.body).params?.[0];
    node.reads.push(call?.message);
    notify();
    if (node.mode === 'silent') return new Promise(() => {});
    if (node.mode === 'unreachable') throw new TypeError('fetch failed: connect ECONNREFUSED');
    if (node.mode === 'gated') await new Promise((resolve) => node.releases.push(resolve));
    if (call?.message !== 'getBlockByNumber') throw new Error(`the node double answers no ${call?.message}`);
    const identity = node.chainIdentity;
    return answer(call.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: identity, content: {} }
      : { number: call.data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: identity, ordered_transactions: [] } });
  };
  return node;
}

/** The chain identity of the SDK's refused fixture chain. */
export const FIXTURE_CHAIN = TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0];

/** Sends requests for NODE_ORIGIN to `node` and the rest to the real network fixtures, recording each origin. */
export function routedFetch(node, origins = []) {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    origins.push(url.origin);
    return url.origin === NODE_ORIGIN ? node.fetch(input, init) : fetch(input, init);
  };
}

/** The configuration with SDK purchases on over NODE_ORIGIN; `settings` overrides any key. */
export const switchedOn = (settings = {}) => (config) => ({ ...config, sdkPurchases: 'on', chain: { ...config.chain, rpcUrl: NODE_ORIGIN },
  tp1TransportAuthority: TRANSPORT_AUTHORITY, ...settings });

/**
 * Starts the harness (with `env` and further createApp `appOptions`) with SDK purchases on and `node` behind the chain
 * RPC origin. Closed after the test.
 */
export async function switchOnHarness(t, { node = tp1Node(), settings = {}, origins = [], env = {}, appOptions = {} } = {}) {
  const h = await startHarness({ env, fetchImpl: routedFetch(node, origins), configure: switchedOn(settings), appOptions });
  t.after(() => h.close());
  return { h, node, origins };
}

const isHold = (error) => error?.code === 'profile_not_admitted' && error.cause === undefined;

/** Returns what `work` resolves; the client's purchase hold is rethrown as the one fixed line HELD. */
export async function clientAction(work) {
  try {
    return await work();
  } catch (error) {
    if (isHold(error)) throw new Error(HELD, { cause: error });
    throw error;
  }
}

/**
 * Returns the error `work` rejects with. The client's purchase hold (profile_not_admitted with no cause) is
 * rethrown as the one fixed line HELD, as the expected-until-card entries name it; a call that resolves fails.
 */
export async function clientRefusal(work) {
  try {
    await work();
  } catch (error) {
    if (isHold(error)) throw new Error(HELD, { cause: error });
    return error;
  }
  throw new Error('the call was not refused');
}

/** The account id of a linked test user. */
export const accountOf = (h, user) => h.app.services.accounts.walletOwner(user.wallet.address);

/**
 * Saves a purchase of `wallet` for `accountId` through the operation store, as the client would have, with its handoff
 * open until `handoffExpiresAt` (stored as given). Returns its `{ id, token }`, the token being its real handoff token.
 */
export function seedHandoffPurchase(h, { accountId, wallet, key = 'seeded', handoffExpiresAt = new Date(Date.now() + 3_600_000).toISOString(), jobId = null }) {
  const { operation, handoffToken } = h.app.services.ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: key, request: { key },
    status: 'awaiting_approval', terms: { buyer: { accountId, wallet }, protocol: { jobId } }, termsHash: 'terms', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  h.app.db.prepare('UPDATE operations SET handoff_expires_at = ?, job_id = ? WHERE id = ?').run(handoffExpiresAt, jobId, operation.id);
  return { id: operation.id, token: handoffToken };
}

/** POSTs `body` as canonical JSON to `path` of `h` (with `headers`); resolves `{ status, body }`. */
export async function postJson(h, path, body, headers = {}) {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: canonicalize(body) });
  return { status: response.status, body: await response.json() };
}

/** prepare's arguments for `user`'s account and a fixture listing. */
export const prepareArgs = (h, user, idempotencyKey = 'switch-on') => ({ accountId: accountOf(h, user), listingId: 'fixture-report', version: 1,
  seller: user.wallet.claim, idempotencyKey });
