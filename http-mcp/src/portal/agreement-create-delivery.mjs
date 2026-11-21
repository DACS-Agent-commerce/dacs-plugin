// One public delivery id correlates one purchase with its retained CREATE bytes.
// Claim authority comes from a live Start and a wallet challenge; the hashed journal
// capability grants evidence access only. A recovery pass restores effect authority
// over retained signed bytes without moving the claim or handing out request bytes.
// The app database and the client's wallet journal share no transaction.
// A row moves only from issued to claimed; its events are append-only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_PROFILE, OperationError } from '@kynesyslabs/dacs-client';
import { transaction } from '../store/database.mjs';
import { deriveDispatchHistory } from '../../public/portal/embedded-wallet/effect-records.mjs';

/** Maximum recovery passes retained for one delivery. */
export const CREATE_PASS_LIMIT = 8;
/** The evidence capability header; it confers no claim or signing authority. */
export const CREATE_JOURNAL_HEADER = 'x-dacs-create-journal';
const REQUEST_LIMIT = 64 * 1024, HISTORY_LIMIT = 64;
const CLOSED = new Set(['settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'cancelled', 'superseded', 'agreement_rejected']);
const fail = code => { throw new OperationError(code, code); };
const view = row => row && ({ id: row.delivery_id, state: row.state, requestHash: row.request_hash });
const capabilityHash = value => sha256Hex(`dacs-create-journal:${value}`);
const refused = code => ({ success: false, error: { code } });

/** Creates the synchronous app store and the client's immediate wallet handoff. Store errors propagate. */
export function createAgreementCreateDelivery({ db, starts, gates, now = () => Date.now(), random = randomBytes }) {
  const stored = db.prepare('SELECT * FROM agreement_create_deliveries WHERE operation_id = ?');
  const purchase = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'purchase'");
  const byJob = db.prepare("SELECT id FROM operations WHERE job_id = ? AND kind = 'purchase'");
  const insert = db.prepare(`INSERT INTO agreement_create_deliveries
    (delivery_id, operation_id, account_id, wallet, terms_hash, kind, request_bytes, request_hash, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`);
  const rebind = db.prepare(`UPDATE agreement_create_deliveries SET start_record_id = ?, claim_expires_at = ?
    WHERE operation_id = ? AND state = 'issued' AND start_record_id IS ?`);
  const take = db.prepare(`UPDATE agreement_create_deliveries SET state = 'claimed', journal_capability_hash = ?, claimed_at = ?
    WHERE operation_id = ? AND state = 'issued' AND start_record_id = ?`);
  const eventRows = db.prepare('SELECT * FROM agreement_create_events WHERE delivery_id = ? ORDER BY seq');
  const eventInsert = db.prepare('INSERT INTO agreement_create_events VALUES (?, ?, ?, ?, ?)');
  const expiry = (operation, start) => Math.min(start.expiresAt, Date.parse(operation.handoff_expires_at), Date.parse(operation.expires_at));
  const live = (operation, start) => Boolean(operation && start && starts.current(operation.id)?.id === start.id && starts.get(start.id)
    && start.operationId === operation.id && start.accountId === operation.account_id && start.termsHash === operation.terms_hash
    && start.wallet === JSON.parse(operation.terms).buyer.wallet && expiry(operation, start) > now());
  const closed = operation => !operation || CLOSED.has(operation.status);
  const events = deliveryId => eventRows.all(deliveryId).map(row => ({ seq: row.seq, kind: row.kind, body: JSON.parse(row.body), createdAt: row.created_at }));
  function append(deliveryId, kind, body) {
    const seq = (db.prepare('SELECT max(seq) AS seq FROM agreement_create_events WHERE delivery_id = ?').get(deliveryId).seq ?? 0) + 1;
    eventInsert.run(deliveryId, seq, kind, canonicalize(body), new Date(now()).toISOString());
    return seq;
  }
  function effectAuthority(operationId) {
    const gate = !gates.purchasesOn() ? 'sdk_purchases_off' : gates.bindingCause() ?? (gates.stopped() ? 'writes_stopped' : null);
    if (gate) return { ok: false, reason: gate };
    const row = stored.get(operationId), operation = purchase.get(operationId);
    const pass = row && events(row.delivery_id).findLast(event => event.kind === 'pass');
    const start = row && starts.get(pass?.body.startRecordId ?? row.start_record_id);
    const reason = row?.state !== 'claimed' ? 'not_claimed' : closed(operation) ? 'closed'
      : !live(operation, start) || (pass?.body.expiresAt ?? row.claim_expires_at) <= now() ? 'expired' : null;
    return reason ? { ok: false, reason } : { ok: true };
  }
  function bindStart({ operationId, start }) {
    return transaction(db, () => {
      const row = stored.get(operationId), operation = purchase.get(operationId);
      if (!row || row.state !== 'issued' || closed(operation) || !live(operation, start)) return false;
      return rebind.run(start.id, String(expiry(operation, start)), operationId, row.start_record_id).changes === 1;
    });
  }
  function walletFactoryFor(operationId) {
    const operation = purchase.get(operationId);
    if (!operation) fail('delivery_unbound');
    const terms = JSON.parse(operation.terms);
    return () => ({
      getPublicAccount: () => ({ address: terms.buyer.wallet }),
      getWriteProfile: () => ({ profile: DEVNET_AGREEMENT_PROFILE, network: terms.network, transactionKinds: [DEVNET_AGREEMENT_KIND] }),
      request: input => request(input, operationId),
    });
  }
  async function request({ method, params }, operationId) {
    const value = Array.isArray(params) && params.length === 1 && params[0];
    if (method !== 'sendTransaction' || !value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== DEVNET_AGREEMENT_KIND || value.profile !== DEVNET_AGREEMENT_PROFILE || value.artifactKind !== 'Agreement') return refused('delivery_refused');
    const bytes = Buffer.from(canonicalize(value));
    if (bytes.length > REQUEST_LIMIT) return refused('delivery_refused');
    return transaction(db, () => {
      const operation = purchase.get(operationId ?? byJob.get(value.jobId)?.id ?? null);
      const terms = operation && JSON.parse(operation.terms);
      if (!operation || operation.job_id !== value.jobId || value.owner !== `did:demos:agent:${terms.buyer.wallet.slice(2)}`
        || value.network !== terms.network || closed(operation) || !(Date.parse(operation.handoff_expires_at) > now())) return refused('delivery_unbound');
      if (stored.get(operation.id)) return refused('outcome_unknown');
      if (JSON.parse(operation.state).protocol?.stage !== 'agreement-signing') return refused('delivery_unbound');
      insert.run(random(16).toString('base64url'), operation.id, operation.account_id, terms.buyer.wallet, operation.terms_hash,
        value.kind, bytes, sha256Hex(bytes.toString()), new Date(now()).toISOString());
      return refused('outcome_unknown');
    });
  }
  function claim({ operationId, start, consume, mintRelay }) {
    return transaction(db, () => {
      const row = stored.get(operationId), operation = purchase.get(operationId);
      if (!row) fail('delivery_missing');
      const state = closed(operation) ? 'closed' : row.state === 'claimed' ? 'claimed'
        : !live(operation, start) || row.start_record_id !== start.id || row.claim_expires_at <= now() ? 'expired' : null;
      if (state) return { delivery: { id: row.delivery_id, state } };
      consume();
      const journalCapability = random(32).toString('base64url');
      if (take.run(capabilityHash(journalCapability), new Date(now()).toISOString(), operationId, start.id).changes !== 1) fail('claim_conflict');
      const relayAccess = mintRelay();
      return { delivery: { ...view(row), state: 'claimed', kind: row.kind }, request: Buffer.from(row.request_bytes).toString('base64'), journalCapability, relayAccess };
    });
  }
  function admitJournal({ operationId, presented }) {
    const row = stored.get(operationId);
    if (!row?.journal_capability_hash || typeof presented !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(presented)
      || !timingSafeEqual(Buffer.from(row.journal_capability_hash, 'hex'), Buffer.from(capabilityHash(presented), 'hex'))) fail('not_found');
    return { ...row, ...view(row) };
  }
  function appendPass({ operationId, start, hash, history, mintRelay }) {
    return transaction(db, () => {
      const row = stored.get(operationId), operation = purchase.get(operationId);
      if (row?.state !== 'claimed') fail('not_claimed');
      if (closed(operation)) fail('closed');
      if (!live(operation, start)) fail('start_not_live');
      if (start.recovery !== true) fail('start_not_recovery');
      const retained = events(row.delivery_id);
      if (retained.some(event => event.kind === 'browser-stage' && event.body.stage === 'broadcast-accepted')) fail('readback_only');
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !Array.isArray(history) || history.length > HISTORY_LIMIT
        || history.some((record, index) => !record || record.seq !== index + 1 || typeof record.passId !== 'string' || !record.passId
          || Object.keys(record).some(key => !['seq', 'kind', 'stage', 'passId'].includes(key)) || (record.kind === 'signed' && index !== 0)
          || !/^(signed|signed-held|observed|(?:dispatch|confirm|broadcast)-(?:started|acknowledged|unknown|withheld))$/.test(record.kind)
          || (record.kind === 'signed-held' ? !['dispatch', 'confirm', 'broadcast'].includes(record.stage)
            : record.kind.includes('-') ? record.stage !== record.kind.split('-')[0] : record.stage !== undefined))
        || retained.some(event => ['browser-stage', 'pass'].includes(event.kind) && event.body.hash && event.body.hash !== hash)) fail('history_invalid');
      const verdict = deriveDispatchHistory(history);
      if (!verdict.signed || !verdict.neverDispatched || verdict.confirmation === 'unknown') fail('readback_only');
      if (retained.filter(event => event.kind === 'pass').length >= CREATE_PASS_LIMIT) fail('pass_limit');
      const expiresAt = expiry(operation, start);
      const seq = append(row.delivery_id, 'pass', { startRecordId: start.id, expiresAt, hash, withheldDigest: sha256Hex(canonicalize(history)) });
      return { seq, expiresAt, relayAccess: mintRelay() };
    });
  }
  return { walletFactory: () => ({ request, getPublicAccount: () => null, getWriteProfile: () => null }), walletFactoryFor,
    forOperation: operationId => view(stored.get(operationId)) ?? null, bindStart, claim, admitJournal, appendPass, events, effectAuthority,
    appendEvent: ({ deliveryId, kind, body }) => transaction(db, () => {
      if (!['browser-stage', 'result', 'retirement'].includes(kind)) fail('invalid_event');
      return append(deliveryId, kind, body);
    }) };
}
