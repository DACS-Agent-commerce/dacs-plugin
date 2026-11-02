// Fresh, one-use, domain- and purpose-bound wallet signature challenges.
// The message is human-readable (shown by the wallet) and every binding field
// is re-derived by the server at verification time; the client never chooses
// what a signature authorizes.
import { randomBytes } from 'node:crypto';
import { normalizeDemosAddress, verifyDemosSignature } from './demos-signature.mjs';
import { newId } from '../util/ids.mjs';

export const PURPOSES = Object.freeze({
  LOGIN: 'account-login',
  LINK_WALLET: 'link-wallet',
  APPROVE_PURCHASE: 'approve-purchase',
  OFFLINE_AGREEMENT_BROKER: 'offline-agreement-browser-session',
});

const STATEMENTS = {
  [PURPOSES.LOGIN]: 'Sign in to your DACS plugin account with this wallet. This does not move funds.',
  [PURPOSES.LINK_WALLET]: 'Link this wallet to the DACS plugin account below. Only sign if you started this from your own ChatGPT conversation: the account holder will be able to sign in with this wallet. This does not move funds.',
  [PURPOSES.APPROVE_PURCHASE]: 'Approve exactly this DEM testnet purchase. Your wallet will ask separately before any transaction is sent.',
  [PURPOSES.OFFLINE_AGREEMENT_BROKER]: 'Authenticate this linked wallet for one exact SIMULATED Agreement CREATE in this operation. This is not payment approval. The packaged wallet must separately show and approve the complete CREATE debit. No payment or completion is enabled.',
};

export class ChallengeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function bindingLines(binding) {
  return Object.keys(binding)
    .sort()
    .map((key) => {
      const value = binding[key];
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`challenge binding ${key} must be a single-line string`);
      return `${key}: ${value}`;
    });
}

export function renderChallengeMessage({ origin, purpose, address, binding, nonce, issuedAt, expiresAt }) {
  const host = new URL(origin).host;
  return [
    `${host} requests a DACS wallet signature`,
    '',
    STATEMENTS[purpose],
    '',
    `origin: ${origin}`,
    `purpose: ${purpose}`,
    `address: ${address}`,
    ...bindingLines(binding),
    `nonce: ${nonce}`,
    `issued-at: ${issuedAt}`,
    `expires-at: ${expiresAt}`,
  ].join('\n');
}

export function createChallengeService({ db, origin, ttlSeconds, now = () => Date.now() }) {
  const insert = db.prepare(`INSERT INTO challenges (id, nonce, purpose, account_id, binding, message, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const select = db.prepare('SELECT * FROM challenges WHERE id = ?');
  const consume = db.prepare(`UPDATE challenges SET consumed_at = ?, consumed_by = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`);

  function issue({ purpose, address, accountId = null, binding }) {
    if (!STATEMENTS[purpose]) throw new ChallengeError('invalid_purpose', 'unknown challenge purpose');
    const normalized = normalizeDemosAddress(address);
    const id = newId('chl');
    const nonce = randomBytes(16).toString('base64url');
    const issuedAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + ttlSeconds * 1000).toISOString();
    const fullBinding = { ...binding, account: accountId ?? 'new-or-existing-by-wallet' };
    const message = renderChallengeMessage({ origin, purpose, address: normalized, binding: fullBinding, nonce, issuedAt, expiresAt });
    insert.run(id, nonce, purpose, accountId, JSON.stringify({ address: normalized, ...fullBinding }), message, issuedAt, expiresAt);
    return { challengeId: id, message, address: normalized, expiresAt };
  }

  // Verifies the signature against the stored message and that the stored
  // binding equals what the caller (server route) expects, then atomically
  // consumes the challenge. Any mismatch leaves the challenge unconsumed.
  function verifyAndConsume({ challengeId, purpose, expectedBinding, signature, consumedBy }) {
    const row = select.get(challengeId);
    if (!row) throw new ChallengeError('unknown_challenge', 'challenge not found');
    if (row.purpose !== purpose) throw new ChallengeError('purpose_mismatch', 'challenge was issued for a different purpose');
    if (row.consumed_at) throw new ChallengeError('challenge_replayed', 'challenge was already used');
    if (Date.parse(row.expires_at) <= now()) throw new ChallengeError('challenge_expired', 'challenge expired');
    const stored = JSON.parse(row.binding);
    for (const [key, value] of Object.entries(expectedBinding)) {
      if (stored[key] !== value) throw new ChallengeError('binding_mismatch', `challenge binding ${key} does not match`);
    }
    if (!verifyDemosSignature({ address: stored.address, message: row.message, signature })) {
      throw new ChallengeError('bad_signature', 'wallet signature does not verify for this challenge');
    }
    const result = consume.run(new Date(now()).toISOString(), consumedBy, challengeId, new Date(now()).toISOString());
    if (result.changes !== 1) throw new ChallengeError('challenge_replayed', 'challenge was already used or expired');
    return { challengeId, address: stored.address, binding: stored, message: row.message, accountId: row.account_id };
  }

  return { issue, verifyAndConsume };
}
