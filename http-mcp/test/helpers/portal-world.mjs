// The portal router on loopback with a purchase service stand-in that has the client's method names: its
// active methods return Promises and its passive readers return plain values, as the client's do.
import http from 'node:http';
import express from 'express';
import { createPortalRouter } from '../../src/portal/routes.mjs';
import { BUYER, PUBLIC_ORIGIN, recordingLogger } from './relay-world.mjs';

/** The client's passive readers; every other method of its purchase service returns a Promise. */
export const PASSIVE_READERS = Object.freeze(['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning']);

/** A purchase in `status` as the client's portal reader returns it. */
export const purchaseOperation = (id = 'op-relay', status = 'approved') => ({
  id, accountId: 'acct-relay', status, termsHash: 'terms-hash', expiresAt: '2026-11-21T13:00:00.000Z',
  terms: { buyer: { accountId: 'acct-relay', wallet: BUYER }, seller: { claim: 'seller-claim', payee: `0x${'e4'.repeat(32)}` }, price: { amountOs: '1' } },
});

/**
 * A stand-in purchase service. `answers[name]` is what an active method's Promise resolves to (or a function of the call's
 * argument); a missing answer resolves `{ operation }`. `calls` lists every method call with its argument.
 */
export function purchaseService({ operation = purchaseOperation(), answers = {} } = {}) {
  const calls = [];
  const active = (name) => (argument) => {
    calls.push({ name, argument });
    const answer = answers[name];
    return Promise.resolve().then(() => (typeof answer === 'function' ? answer(argument) : answer ?? { operation }));
  };
  const service = {
    portalOperation(id, token) { calls.push({ name: 'portalOperation', argument: { id, token } }); return operation; },
    portalEvidence() { return { protocol: null }; },
    planRunning() { return false; },
    status() { return { history: [] }; },
    verifyDeal: active('verifyDeal'),
  };
  for (const name of ['issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane', 'reportWalletResult', 'agreementIdentity', 'agreementPlan',
    'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck']) service[name] = active(name);
  return { service, calls };
}

/** Mounts the portal router. `post(path, body)` posts to `/portal/api/purchase/<id>/<path>`. */
export async function startPortal({ db, purchases, relayAccess = null, logger = recordingLogger(), config = {}, id = 'op-relay' }) {
  const app = express();
  const router = createPortalRouter({ config: { publicOrigin: PUBLIC_ORIGIN, ...config }, db, purchases, logger, relayAccess, timeline: { record() {} } });
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body = {}) {
    const response = await fetch(`${origin}/portal/api/purchase/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'handoff-token', ...body }) });
    return { status: response.status, body: await response.json() };
  }
  return {
    post, logger,
    async close() { await router.drainPurchasePolls(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); },
  };
}
