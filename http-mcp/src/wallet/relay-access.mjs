// Access to the native wallet relay. A capability is minted when a purchase's payment handoff is given to the
// browser, and is bound to that purchase's account, operation and bound buyer wallet, to a set of relay phases and
// to an expiry no later than the handoff's. Only its SHA-256 is stored; the value itself exists only in mint's
// answer, which the portal hands to the browser, and the browser presents it in the x-dacs-relay-access header.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from '../store/database.mjs';

/** The request header that carries a relay capability. */
export const RELAY_ACCESS_HEADER = 'x-dacs-relay-access';
/** The relay phases a capability can name. */
export const RELAY_PHASES = Object.freeze(['bind', 'signature', 'rpc', 'release', 'readback']);
/** Unexpired capabilities kept per operation; minting another drops the oldest. */
export const RELAY_LIVE_LIMIT = 4;

const CAPABILITY_BYTES = 32;
// 32 bytes in unpadded base64url.
const CAPABILITY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The one refusal for a missing, malformed, unknown or mismatched capability: 403 relay_access_denied, the same for every cause. */
export class RelayAccessError extends Error {
  constructor() {
    super('relay access denied');
    this.code = 'relay_access_denied';
    this.httpStatus = 403;
  }
}

const hashOf = (capability) => createHash('sha256').update(`dacs-relay-access:${capability}`).digest();
const iso = (ms) => new Date(ms).toISOString();
/** Parses a stored handoff expiry: its epoch milliseconds when it is in the exact ISO form the client stores, else NaN. Never throws. */
export function handoffExpiry(stored) {
  const ms = typeof stored === 'string' ? Date.parse(stored) : NaN;
  return Number.isFinite(ms) && iso(ms) === stored ? ms : NaN;
}

/**
 * Returns `{ mint, admit, revokeOperation, sweep }` over the app database `db`; every method is synchronous.
 * - `mint({ operationId, phases, expiresAt? })` stores a new capability for a purchase whose handoff is open and returns
 *   `{ capability, expiresAt }`; the account, wallet and handoff expiry come from the purchase's own row, and `expiresAt` is
 *   clamped to the handoff expiry. Throws RelayAccessError for an unknown purchase or a handoff that is not open.
 * - `admit({ presented, wallet, phase })` returns the frozen `{ accountId, operationId, wallet, phases, expiresAt, live }`
 *   of a stored capability; `live` is false once it or its handoff has expired. `wallet` null means the request names no
 *   wallet. Throws RelayAccessError for a malformed or unknown value, another wallet or a phase outside the set. Reads only.
 * - `revokeOperation(operationId)` and `sweep()` delete an operation's capabilities or every expired one, returning the count.
 */
export function createRelayAccess({ db, now = () => Date.now(), random = randomBytes }) {
  const purchase = db.prepare("SELECT account_id, handoff_expires_at, json_extract(terms, '$.buyer.wallet') AS wallet FROM operations WHERE id = ? AND kind = 'purchase'");
  const insert = db.prepare('INSERT INTO relay_capabilities (capability_hash, account_id, operation_id, wallet, phases, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const newestFirst = db.prepare('SELECT capability_hash FROM relay_capabilities WHERE operation_id = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC');
  const remove = db.prepare('DELETE FROM relay_capabilities WHERE capability_hash = ?');
  const stored = db.prepare('SELECT * FROM relay_capabilities WHERE capability_hash = ?');
  const removeOperation = db.prepare('DELETE FROM relay_capabilities WHERE operation_id = ?');
  const removeExpired = db.prepare('DELETE FROM relay_capabilities WHERE expires_at <= ?');

  function mint({ operationId, phases, expiresAt }) {
    return transaction(db, () => {
      const at = now(), row = purchase.get(operationId), handoffEnds = handoffExpiry(row?.handoff_expires_at);
      if (!row || typeof row.wallet !== 'string' || !(handoffEnds > at)) throw new RelayAccessError();
      const ends = iso(Math.min(expiresAt ?? handoffEnds, handoffEnds));
      const capability = random(CAPABILITY_BYTES).toString('base64url');
      insert.run(hashOf(capability).toString('hex'), row.account_id, operationId, row.wallet, phases.join(','), ends, iso(at));
      for (const { capability_hash: older } of newestFirst.all(operationId, iso(at)).slice(RELAY_LIVE_LIMIT)) remove.run(older);
      return { capability, expiresAt: ends };
    });
  }

  function admit({ presented, wallet, phase }) {
    if (typeof presented !== 'string' || !CAPABILITY_SHAPE.test(presented)) throw new RelayAccessError();
    const computed = hashOf(presented), row = stored.get(computed.toString('hex'));
    if (!row || !timingSafeEqual(Buffer.from(row.capability_hash, 'hex'), computed)) throw new RelayAccessError();
    const phases = row.phases.split(',');
    if ((wallet !== null && wallet !== row.wallet) || !phases.includes(phase)) throw new RelayAccessError();
    const at = now();
    const live = at < Date.parse(row.expires_at) && handoffExpiry(purchase.get(row.operation_id)?.handoff_expires_at) > at;
    return Object.freeze({ accountId: row.account_id, operationId: row.operation_id, wallet: row.wallet, phases: Object.freeze(phases), expiresAt: row.expires_at, live });
  }

  return Object.freeze({
    mint, admit,
    revokeOperation: (operationId) => removeOperation.run(operationId).changes,
    sweep: () => removeExpired.run(iso(now())).changes,
  });
}
