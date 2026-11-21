import express from 'express';
import { canonicalize } from '@kynesyslabs/dacs';
import { OperationError } from '../operations.mjs';
import { ChallengeError, PURPOSES } from '../wallet/challenges.mjs';
import { RELAY_PHASES } from '../wallet/relay-access.mjs';
import { CREATE_JOURNAL_HEADER } from './agreement-create-delivery.mjs';

const BODY_LIMIT = 64 * 1024;
const fail = code => { throw new OperationError(code, code); };
/** Returns the standalone challenge, one-use claim and recovery-pass router. No request bytes or capabilities are logged. */
export function createAgreementCreateRouter({ delivery, challenges, purchases, accounts, relayAccess, starts, now = () => Date.now() }) {
  const router = express.Router(), prefix = '/portal/api/purchase/:id/agreement-create';
  const raw = express.raw({ type: () => true, limit: BODY_LIMIT, inflate: false });
  const binding = (operation, start, retained) => ({ operation: operation.id, 'terms-hash': operation.termsHash,
    'agreement-hash': operation.state.protocol.planned.plan.agreementHash, start: start.id, delivery: retained.id,
    'request-hash': retained.requestHash, 'delivery-expires': String(Math.min(start.expiresAt, Date.parse(operation.expiresAt))) });
  function authenticate(req) {
    const operation = purchases.portalOperation(req.params.id, req.body.token);
    if (accounts.walletOwner(operation.terms.buyer.wallet) !== operation.accountId) fail('not_found');
    return operation;
  }
  function route(action, members, handler) {
    router.post(`${prefix}/${action}`, raw, (req, res) => {
      try {
        const bytes = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        let body;
        try { body = JSON.parse(bytes); } catch { fail('invalid_request'); }
        if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== members.slice().sort().join(',')
          || !Buffer.from(canonicalize(body)).equals(req.body) || members.filter(key => key !== 'history').some(key => typeof body[key] !== 'string')) fail('invalid_request');
        req.body = body;
        const gate = delivery.effectAuthority(null);
        if (!gate.ok && ['sdk_purchases_off', 'writes_stopped'].includes(gate.reason)) fail(gate.reason);
        if (!gate.ok && gate.reason.startsWith('tp1_')) {
          const error = new OperationError('profile_not_admitted', 'profile_not_admitted'); error.cause = { code: gate.reason }; throw error;
        }
        const operation = authenticate(req), answer = handler(req, operation);
        const status = ['closed', 'expired'].includes(answer.delivery?.state) ? 409 : 200;
        res.status(status).json(answer);
      } catch (error) {
        const status = error.code === 'not_found' ? 404 : error.code === 'invalid_request' || error instanceof ChallengeError ? 400 : error instanceof OperationError ? 409 : 500;
        res.status(status).json({ error: status === 500 ? 'server_error' : error.code, message: status === 500 ? 'internal error' : error.code,
          ...(error.code === 'profile_not_admitted' && error.cause?.code ? { cause: error.cause.code } : {}) });
      }
    });
  }
  function current(operation, id) {
    const start = starts.current(operation.id);
    if (!start || start.id !== id || starts.get(id)?.id !== id || start.operationId !== operation.id || start.expiresAt <= now() || start.accountId !== operation.accountId || start.wallet !== operation.terms.buyer.wallet
      || start.termsHash !== operation.termsHash) fail('start_not_live');
    return start;
  }
  route('challenge', ['token', 'start'], (req, operation) => {
    const start = current(operation, req.body.start), retained = delivery.forOperation(operation.id);
    if (!retained) fail('delivery_missing');
    if (retained.state === 'issued' && !delivery.bindStart({ operationId: operation.id, start })) fail('start_not_live');
    const issued = challenges.issue({ purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, address: start.wallet, accountId: operation.accountId,
      binding: binding(operation, start, retained) });
    return { challengeId: issued.challengeId, message: issued.message, expiresAt: issued.expiresAt, delivery: retained };
  });
  const mint = (operation, start) => relayAccess.mint({ operationId: operation.id, phases: RELAY_PHASES, expiresAt: start.expiresAt });
  route('claim', ['token', 'challengeId', 'signature'], (req, operation) => {
    const retained = delivery.forOperation(operation.id), start = starts.current(operation.id);
    return delivery.claim({ operationId: operation.id, start,
      consume: () => challenges.verifyAndConsume({ challengeId: req.body.challengeId, signature: req.body.signature,
        purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, expectedBinding: { ...binding(operation, start, retained), account: operation.accountId, address: start.wallet }, consumedBy: operation.id }),
      mintRelay: () => mint(operation, start) });
  });
  route('pass', ['token', 'start', 'hash', 'history'], (req, operation) => {
    const retained = delivery.admitJournal({ operationId: operation.id, presented: req.get(CREATE_JOURNAL_HEADER) });
    const start = current(operation, req.body.start);
    const pass = delivery.appendPass({ operationId: operation.id, start, hash: req.body.hash, history: req.body.history,
      mintRelay: () => { relayAccess.revokeOperation(operation.id); return mint(operation, start); } });
    return { delivery: { id: retained.id, state: retained.state }, pass: { seq: pass.seq, expiresAt: pass.expiresAt }, relayAccess: pass.relayAccess };
  });
  router.use(prefix, (error, _req, res, next) => error ? res.status(400).json({ error: 'invalid_request', message: 'invalid_request' }) : next());
  return router;
}
