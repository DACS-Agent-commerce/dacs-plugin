// Server side of the embedded wallet's one Start approval
// (DACS_INTENT_APPROVAL=on; default off). See public/portal-intent/.
//
// Switch off: nothing here is mounted, and every portal asset is the plain
// static file (the switch-on hooks are inserted by intent-hooks.mjs only when
// the switch is on), so every route, asset and wallet dialog is the build
// without this feature.
//
// Switch on: three purchase routes run main's own identity, plan and submit
// steps (purchases.agreementIdentity / agreementPlan / agreementSubmit, with
// every check they make) and return the structured drafts the wallet checks
// and derives bytes from, plus the pinned Listing the wallet hash-checks and
// derives the Agreement terms from. They add one binding: a short-lived Start
// record per purchase, tied to the purchase, its account, the bound wallet and
// the terms hash. It guards these three routes only; main's agreement/*
// routes stay mounted and keep their own checks. Later intent steps are
// refused when the record is unknown, replaced by a newer Start, expired, used
// for another purchase or account, or when the wallet is no longer linked to
// the account. The newest Start to arrive wins: it revokes the older record at
// once, and an older Start still reading the chain issues nothing. The record
// is in memory only: after a restart or reload the buyer is asked again
// (fail-safe, never resumed).
import { randomBytes } from 'node:crypto';
import { OperationError } from '../operations.mjs';
import { intentProfile } from '../../public/portal-intent/intent.mjs';

export const START_INTENT_TTL_MS = 10 * 60 * 1000;

export function createStartIntents({ purchases, accounts, chain = null, now = () => Date.now(), ttlMs = START_INTENT_TTL_MS, maxRecords = 1024 }) {
  const records = new Map();
  const latest = new Map(); // operation id -> its one current Start record id
  // operation id -> the generation of the newest Start that arrived for it,
  // allocated before any await so arrival order, not completion, decides.
  const arrivals = new Map();
  let generation = 0;
  function arrive(operationId) {
    const mine = ++generation;
    arrivals.delete(operationId);
    arrivals.set(operationId, mine);
    while (arrivals.size > maxRecords) arrivals.delete(arrivals.keys().next().value);
    const previous = latest.get(operationId);
    if (previous) { records.delete(previous); latest.delete(operationId); }
    return mine;
  }

  // Only after arrive(), which already revoked the purchase's older record.
  function issue(operation, wallet) {
    while (records.size >= maxRecords) {
      const [oldest, record] = records.entries().next().value;
      records.delete(oldest);
      if (latest.get(record.operationId) === oldest) latest.delete(record.operationId);
    }
    const id = randomBytes(16).toString('base64url');
    const record = Object.freeze({ id, operationId: operation.id, accountId: operation.accountId, wallet, termsHash: operation.termsHash,
      expiresAt: Math.min(now() + ttlMs, Date.parse(operation.expiresAt)),
      generatedAt: operation.state.protocol.planned?.draft.generatedAt ?? now() });
    records.set(id, record);
    latest.set(operation.id, id);
    return record;
  }

  const refused = (reason) => new OperationError('intent_refused', `${reason}; nothing was signed or sent. Start again.`);
  function linked(operation, wallet) {
    return operation.terms.buyer.wallet === wallet && accounts.walletOwner(wallet) === operation.accountId;
  }
  function admit(operationId, token, recordId) {
    const operation = purchases.portalOperation(operationId, token);
    const record = typeof recordId === 'string' ? records.get(recordId) : undefined;
    // arrive() drops a purchase's previous record, so a replaced one is unknown.
    if (!record) throw refused('this purchase start is unknown or was replaced');
    if (record.operationId !== operation.id || record.accountId !== operation.accountId) throw refused('this purchase start belongs to another purchase or account');
    if (!linked(operation, record.wallet)) throw refused('the wallet is no longer linked to this purchase account');
    if (record.termsHash !== operation.termsHash) throw refused('the purchase terms changed');
    if (record.expiresAt <= now()) throw refused('this purchase start expired');
    return operation;
  }

  function mount(router, { api, json, purchaseView, address }) {
    const sig = (value) => (value === undefined ? undefined : String(value ?? ''));
    router.post('/portal/api/purchase/:id/intent/start', json, api(async (req) => {
      const operation = purchases.portalOperation(req.params.id, req.body?.token);
      const profile = intentProfile(operation.terms);
      if (!profile) throw new OperationError('intent_unsupported', 'this purchase keeps per-step wallet approvals');
      const wallet = address(req.body?.address);
      if (!linked(operation, wallet)) throw new OperationError('wrong_wallet', 'connect the wallet bound to this purchase and linked to its account');
      const mine = arrive(operation.id);
      // Main's identity step, with every admission check it makes.
      const r = await purchases.agreementIdentity({ operationId: operation.id, token: req.body?.token, address: wallet });
      let plannedNonce = null;
      if (profile.writes.length) {
        if (!chain) throw new OperationError('not_configured', 'no chain reader is configured for the wallet write plan');
        plannedNonce = (await chain.getAddressNonce(wallet)) + 1;
      }
      // No await from here to issue(): still the newest Start, still linked.
      if (arrivals.get(operation.id) !== mine) throw refused('a newer start for this purchase arrived');
      if (!linked(r.operation, wallet)) throw refused('the wallet is no longer linked to this purchase account');
      arrivals.delete(operation.id);
      const record = issue(r.operation, wallet);
      const p = r.operation.state.protocol;
      return purchaseView(r.operation, { start: {
        intent: { id: record.id, expiresAt: new Date(record.expiresAt).toISOString() },
        // The pinned Listing: the wallet checks its hash against the terms and
        // derives the deliverable, seller identity and deadline from it.
        listing: p.listing,
        agreement: { generatedAt: record.generatedAt },
        identity: { bundle: p.identity.bundle },
        delegation: p.sessionDelegation ? { payload: p.sessionDelegation.payload } : null,
        needs: { identitySignature: !p.planned, delegationSignature: Boolean(p.sessionDelegation && !p.sessionDelegation.signature && !p.planned) },
        wallet: plannedNonce === null ? {} : { plannedNonce },
      } });
    }));
    router.post('/portal/api/purchase/:id/intent/plan', json, api(async (req) => {
      admit(req.params.id, req.body?.token, req.body?.intent);
      const generatedAt = records.get(req.body.intent).generatedAt;
      const r = await purchases.agreementPlan({ operationId: req.params.id, token: req.body?.token, signature: String(req.body?.signature ?? ''), delegationSignature: sig(req.body?.delegationSignature), intentGeneratedAt: generatedAt });
      const p = r.operation.state.protocol;
      return purchaseView(r.operation, { plan: { draft: p.planned.draft, needs: { agreementSignature: p.stage === 'agreement-signing' && !p.signatures } } });
    }));
    router.post('/portal/api/purchase/:id/intent/sign', json, api(async (req) => {
      admit(req.params.id, req.body?.token, req.body?.intent);
      const r = await purchases.agreementSubmit({ operationId: req.params.id, token: req.body?.token, agreementSignature: sig(req.body?.agreementSignature), anchorSignature: sig(req.body?.anchorSignature) });
      return purchaseView(r.operation);
    }));
  }

  return { mount, issue, admit };
}
