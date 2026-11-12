import { WALLET_EXTENSION_PROBE_PATH, createWalletExtensionProbeRouter } from './wallet-extension-probe.mjs';
import { autoAdvancePortalPage, autoAdvancePortalSource } from './auto-advance-assets.mjs';
import { showcaseProgress } from '../mcp/showcase-progress.mjs';
import { createPurchasePoll } from './purchase-poll.mjs';
import { createPurchaseStepLog } from '../util/purchase-step-log.mjs';
// Trusted signing portal. ChatGPT links out here because wallet extensions
// cannot be assumed inside the ChatGPT iframe. Pages are static; all state
// changes go through this JSON API, and every state change requires a wallet
// signature that the server verifies against server-held bindings.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PURPOSES, ChallengeError } from '../wallet/challenges.mjs';
import { normalizeDemosAddress, WalletFormatError } from '../wallet/demos-signature.mjs';
import { OperationError } from '../operations.mjs';
import { AccountError } from '../accounts.mjs';
import { OutboundError } from '../util/http.mjs';
import { SCOPE_DESCRIPTIONS, RESOURCE_SCOPES } from '../auth/scopes.mjs';
import { transaction } from '../store/database.mjs';
import { createWalletRpcRouter } from './wallet-rpc.mjs';
import { createStartIntents } from './start-intent.mjs';
import { intentHookedAssets, validateIntentAssets } from './intent-hooks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', '..', 'public', 'portal');
const INTENT_PUBLIC_DIR = join(here, '..', '..', 'public', 'portal-intent');
const PAGE = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
// Read-only explainer pages, kept outside PUBLIC_DIR so /portal/assets never serves them.
// Misses fall through to the app's JSON 404 rather than Express's error page.
const SHOWCASE_DIR = join(here, '..', '..', 'public', 'showcase');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.set({
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
  });
  next();
}

function errorStatus(error) {
  if (error instanceof OutboundError) return 503;
  if (error instanceof ChallengeError || error instanceof WalletFormatError) return 400;
  if (error instanceof AccountError) return 409;
  // 202: a plan step still running past the page's wait (plan_in_progress).
  if (error instanceof OperationError) return error.code === 'not_found' ? 404 : error.code === 'not_configured' ? 503 : error.httpStatus === 202 ? 202 : 409;
  return 500;
}

export function linkToken(secret, accountId, expires, nonce) {
  return createHmac('sha256', secret).update(`dacs-wallet-link:${accountId}:${expires}:${nonce}`).digest('base64url');
}

// timeline: the app's shared purchase step log (src/util/purchase-step-log.mjs).
export function createPortalRouter({ config, db, authServer, accounts, challenges, purchases, identityActions, sellerIdentities, linkSecret, logger, authenticateProbeBearer, chain, fetchImpl = globalThis.fetch, now = () => Date.now(), offlineAgreementBroker = null, timeline = createPurchaseStepLog({ logger }) }) {
  const router = express.Router();
  const purchasePoll=createPurchasePoll(),signTimes=new Map();
  router.drainPurchasePolls=(options)=>purchasePoll.drain(options);
  router.use(securityHeaders);
  router.use(WALLET_EXTENSION_PROBE_PATH, createWalletExtensionProbeRouter({ config, authServer, accounts, authenticateBearer: authenticateProbeBearer, chain, logger }));
  // The two switches each rewrite portal.js for purchase pages; they are refused together (config.mjs).
  if (config.intentApproval === 'on' && config.portalAutoAdvance === 'on') throw new TypeError('DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off');
  const autoPage=config.portalAutoAdvance==='on'?autoAdvancePortalPage(PAGE):PAGE;
  if(config.portalAutoAdvance==='on'){
    const autoSource=autoAdvancePortalSource(readFileSync(join(PUBLIC_DIR,'portal.js'),'utf8'));
    // The controller lives outside PUBLIC_DIR, so with the switch off the
    // asset routes are exactly main's.
    const controller=readFileSync(join(here,'purchase-auto-advance.mjs'),'utf8');
    router.get('/portal/assets/auto-portal.js',(_req,res)=>res.type('js').send(autoSource));
    router.get('/portal/assets/purchase-auto-advance.mjs',(_req,res)=>res.type('js').send(controller));
  }
  // DACS_INTENT_APPROVAL (default off). Off: nothing is added. On: the Start
  // modules, and portal.js / approval.mjs / the embedded-wallet bridge with their hooks inserted at
  // startup (src/portal/intent-hooks.mjs; refuses to start on any mismatch).
  validateIntentAssets(PUBLIC_DIR); // zero legacy markers in either mode
  const startIntents = config.intentApproval === 'on' ? createStartIntents({ purchases, accounts, chain, now }) : null;
  if (startIntents) {
    router.use('/portal/assets/intent', express.static(INTENT_PUBLIC_DIR, { index: false, fallthrough: false, maxAge: 0 }));
    router.use('/portal/assets', intentHookedAssets(PUBLIC_DIR));
  }
  router.use('/portal/assets', express.static(PUBLIC_DIR, { index: false, fallthrough: false, maxAge: 0 }));
  if (config.showcaseWalkthrough === 'on') router.use('/portal/showcase', express.static(SHOWCASE_DIR, { index: 'index.html', fallthrough: true, maxAge: 0 }));
  // Embedded wallet profile + simulated-loopback-only SDK RPC relay.
  router.use(createWalletRpcRouter({ config, fetchImpl, logger, offlineAgreementBroker }));
  if (offlineAgreementBroker) router.use(offlineAgreementBroker.router);

  // The report view marks every shell, including the auto-advance purchase shell.
  const reportShell = (html) => (config.showcaseReportView === true ? html.replace('<body>', '<body data-showcase-report-view="1">') : html);
  const shellPage = reportShell(PAGE), purchasePage = reportShell(autoPage);
  const page = (req, res) => res.type('html').send(req.path.startsWith('/portal/purchase/')?purchasePage:shellPage);
  router.get(['/portal/authorize/:uid', '/portal/link', '/portal/purchase/:id', '/portal/identity/:id'], page);

  const json = express.json({ limit: '64kb' });
  const api = (handler) => async (req, res) => {
    try {
      if(req.path.startsWith('/portal/api/purchase/')) {
        const operation=purchases.portalOperation(req.params.id,req.body?.token);
        timeline.record({purchaseId:operation.id,jobId:operation.terms.protocol?.jobId ?? null,timestampMs:now(),step:'page-action-received',phase:'complete',durationMs:0,action:req.path.split('/').slice(5).join('/')});
      }
      const result=await handler(req,res);
      if(req.path.startsWith('/portal/api/purchase/')) {
        for(const [field,kind] of [['signature','wallet-message'],['agreementSignature','Agreement'],['anchorSignature','anchor-authorization'],['bundleSignature','completed-bundle']]) {
          if(typeof req.body?.[field]==='string') {
            const started=signTimes.get(`${req.params.id}:${kind}`);signTimes.delete(`${req.params.id}:${kind}`);
            timeline.record({purchaseId:req.params.id,timestampMs:now(),step:'sign',phase:'received',artifactKind:kind,...(started===undefined?{}:{durationMs:Math.max(0,now()-started)}),action:req.path.split('/').slice(5).join('/')});
          }
        }
        // The intent routes (switch on only) start the same sign timers.
        const kind=result.signRequest?.kind==='agreement'||result.plan?.needs?.agreementSignature?'Agreement':result.signRequest?.kind==='completed-bundle'?'completed-bundle':result.signRequest||result.start?.needs?.identitySignature||req.path.endsWith('/challenge')?'wallet-message':null;
        if(kind) {
          if(signTimes.size>=256)signTimes.delete(signTimes.keys().next().value);
          signTimes.set(`${req.params.id}:${kind}`,now());
        }
      }
      res.json(result);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) logger.error('portal_error', { path: req.path, message: error.message });
      const code = error instanceof OutboundError ? 'upstream_unavailable' : error.code ?? 'server_error';
      res.status(status).json({ error: code, message: status === 500 ? 'internal error' : error.message, ...(error.details ? { details: error.details } : {}), ...(error.buyerFunding ? { buyerFunding: error.buyerFunding } : {}) });
    }
  };
  const address = (value) => normalizeDemosAddress(value);

  // ---- OAuth interaction: wallet login + consent for ChatGPT ----
  // These live under /portal/authorize/:uid because oidc-provider scopes the
  // _interaction cookie to exactly that path.
  async function interaction(req, res) {
    const details = await authServer.provider.interactionDetails(req, res);
    if (details.uid !== req.params.uid) throw new OperationError('not_found', 'interaction mismatch');
    logger.debug('oauth_interaction', { prompt: details.prompt.name, reasons: details.prompt.reasons, missing: JSON.stringify(details.prompt.details) });
    const requested = String(details.params.scope ?? '').split(' ').filter(Boolean);
    const resourceScopes = requested.filter((s) => RESOURCE_SCOPES.includes(s));
    const client = await authServer.provider.Client.find(details.params.client_id);
    // A native client declares its own type and name at open registration, and
    // DACS_ALLOW_LOOPBACK_REDIRECTS=1 lets a registered (DCR) native client return to
    // any port of its registered loopback callback; metadata-document clients match exactly.
    return { details, requested, resourceScopes, clientName: client?.clientName ?? details.params.client_id, selfDeclared: config.allowLoopbackRedirects && client?.applicationType === 'native' };
  }
  const loginBinding = (uid, details, resourceScopes) => ({
    interaction: uid,
    client: String(details.params.client_id),
    resource: config.mcpUrl,
    scopes: resourceScopes.join(' ') || '(none)',
  });

  if (authServer) {
    router.post('/portal/authorize/:uid/api/view', json, api(async (req, res) => {
      const { details, requested, resourceScopes, clientName, selfDeclared } = await interaction(req, res);
      return {
        prompt: details.prompt.name,
        clientName,
        ...(selfDeclared ? { clientNote: 'Unverified local app: it registered itself and chose this name. Continue only if you started this sign-in from that app.' } : {}),
        redirectOrigin: new URL(details.params.redirect_uri).origin,
        resource: config.mcpUrl,
        scopes: requested.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] ?? (s === 'openid' ? 'Confirm your account identity' : s === 'offline_access' ? 'Stay linked without signing in again' : s) })),
        resourceScopes,
      };
    }));
    router.post('/portal/authorize/:uid/api/challenge', json, api(async (req, res) => {
      const { details, resourceScopes } = await interaction(req, res);
      return challenges.issue({ purpose: PURPOSES.LOGIN, address: address(req.body?.address), binding: loginBinding(req.params.uid, details, resourceScopes) });
    }));
    router.post('/portal/authorize/:uid/api/complete', json, api(async (req, res) => {
      const { details, requested, resourceScopes } = await interaction(req, res);
      const consumed = challenges.verifyAndConsume({
        challengeId: String(req.body?.challengeId ?? ''),
        purpose: PURPOSES.LOGIN,
        expectedBinding: loginBinding(req.params.uid, details, resourceScopes),
        signature: String(req.body?.signature ?? ''),
        consumedBy: `interaction:${req.params.uid}`,
      });
      const account = accounts.loginWithWallet({ address: consumed.address, challengeId: consumed.challengeId });
      const { provider } = authServer;
      // An expired or missing earlier grant falls back to a fresh one.
      const existingGrant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
      const grant = existingGrant ?? new provider.Grant({ accountId: account.id, clientId: details.params.client_id });
      if (grant.accountId !== account.id) throw new OperationError('invalid_state', 'grant belongs to another account');
      const oidc = requested.filter((s) => s === 'openid' || s === 'offline_access' || RESOURCE_SCOPES.includes(s));
      if (oidc.length) grant.addOIDCScope(oidc.join(' '));
      if (resourceScopes.length) grant.addResourceScope(config.mcpUrl, resourceScopes.join(' '));
      const grantId = await grant.save();
      const redirectTo = await provider.interactionResult(req, res, { login: { accountId: account.id }, consent: { grantId } }, { mergeWithLastSubmission: false });
      logger.info('account_linked', { account: account.id, client: details.params.client_id });
      return { redirectTo };
    }));
  }

  // ---- add a wallet to an existing account ----
  const linkArgs = (body) => {
    const accountId = String(body?.accountId ?? '');
    const expires = Number(body?.expires);
    const token = String(body?.token ?? '');
    const nonce = String(body?.nonce ?? '');
    if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new OperationError('not_found', 'wallet link is invalid or expired');
    const expected = Buffer.from(linkToken(linkSecret, accountId, expires, nonce));
    if (!Number.isSafeInteger(expires) || expires < now() || expected.length !== Buffer.byteLength(token) || !timingSafeEqual(expected, Buffer.from(token))) {
      throw new OperationError('not_found', 'wallet link is invalid or expired');
    }
    if (!accounts.getAccount(accountId)) throw new OperationError('not_found', 'account not found');
    if (usedLink.get(nonce)) throw new OperationError('not_found', 'wallet link was already used');
    return { accountId, expires, nonce };
  };
  const usedLink = db.prepare('SELECT nonce FROM used_link_nonces WHERE nonce = ?');
  const useLink = db.prepare('INSERT INTO used_link_nonces (nonce, account_id, used_at) VALUES (?, ?, ?)');
  // Recognisable context in the wallet prompt, not just an opaque account id.
  const walletContext = (accountId) => {
    const wallets = accounts.listWallets(accountId);
    return wallets.length ? `${wallets.length} linked, first ${wallets[0].address.slice(0, 10)}…${wallets[0].address.slice(-6)}` : 'none linked yet';
  };
  // Read-only link state for rendering; never consumes or extends anything.
  // Account context is only returned for a link that is still usable.
  router.post('/portal/api/link/view', json, api(async (req) => {
    const body = req.body ?? {};
    const accountId = String(body.accountId ?? '');
    const expires = Number(body.expires);
    const token = String(body.token ?? '');
    const nonce = String(body.nonce ?? '');
    if (!/^[A-Za-z0-9_-]{22}$/.test(nonce) || !Number.isSafeInteger(expires)) return { state: 'invalid' };
    const expected = Buffer.from(linkToken(linkSecret, accountId, expires, nonce));
    if (expected.length !== Buffer.byteLength(token) || !timingSafeEqual(expected, Buffer.from(token)) || !accounts.getAccount(accountId)) return { state: 'invalid' };
    if (usedLink.get(nonce)) return { state: 'used' };
    if (expires < now()) return { state: 'expired', expiresAt: new Date(expires).toISOString() };
    return { state: 'valid', accountId, expiresAt: new Date(expires).toISOString(), accountWallets: walletContext(accountId) };
  }));
  router.post('/portal/api/link/challenge', json, api(async (req) => {
    const { accountId, expires, nonce } = linkArgs(req.body);
    return challenges.issue({ purpose: PURPOSES.LINK_WALLET, address: address(req.body?.address), accountId, binding: { 'link-expires': String(expires), 'link-nonce': nonce, 'account-wallets': walletContext(accountId) } });
  }));
  router.post('/portal/api/link/complete', json, api(async (req) => {
    const { accountId, expires, nonce } = linkArgs(req.body);
    // Challenge consumption, link-nonce use and the link itself commit together.
    return transaction(db, () => {
      const consumed = challenges.verifyAndConsume({
        challengeId: String(req.body?.challengeId ?? ''),
        purpose: PURPOSES.LINK_WALLET,
        expectedBinding: { account: accountId, 'link-expires': String(expires), 'link-nonce': nonce },
        signature: String(req.body?.signature ?? ''),
        consumedBy: `link:${accountId}`,
      });
      useLink.run(nonce, accountId, new Date(now()).toISOString());
      return { ...accounts.linkWallet({ accountId, address: consumed.address, challengeId: consumed.challengeId }), address: consumed.address };
    });
  }));

  // ---- buyer purchase approval ----
  // Read from the displayed protocol view: a notSaved view is one
  // check's own unsaved copy and asks the buyer for nothing, so it is read again.
  const requiresSignature=(operation)=>{
    const shown=purchases.portalEvidence(operation).protocol;
    return !shown?.notSaved&&(operation.status==='agreement_pending'?!operation.state?.protocol?.signatures:shown?.stage==='awaiting-countersignature'?!operation.state.protocol.bundle?.buyerSignature:['awaiting_approval','approved'].includes(operation.status));
  };
  const purchaseView = (operation, extra = {}, sellerIdentity = sellerIdentities?.cached(operation.terms.seller.claim)) => ({
    id: operation.id,
    status: operation.status,
    terms: operation.terms,
    termsHash: operation.termsHash,
    expiresAt: operation.expiresAt,
    evidence: purchases.portalEvidence(operation),
    // Only while this process runs the purchase's Agreement plan step.
    ...(purchases.planRunning?.(operation) ? { planRunning: true } : {}),
    ...(config.portalAutoAdvance==='on'?{autoAdvance:{requiresSignature:requiresSignature(operation)}}:{}),
    ...(config.sellerIdentities === 'on' ? { sellerName: operation.state?.sellerDisplayName, ...(sellerIdentity ? { sellerIdentity } : {}) } : {}),
    ...(config.showcaseLedger ? { showcaseProgress: showcaseProgress({ operation, history: purchases.status(operation.accountId, operation.id).history, protocol: purchases.portalEvidence(operation).protocol, evidence: purchases.portalEvidence(operation) }) } : {}),
    ...extra,
  });
  if(config.portalAutoAdvance==='on')router.post('/portal/api/purchase/:id/auto/recheck',json,api(async(req)=>{
    const operation=purchases.portalOperation(req.params.id,req.body?.token);
    const polled=await purchasePoll.poll(operation.id,()=>purchases.verifyDeal({accountId:operation.accountId,operationId:operation.id,txHash:req.body?.txHash,attachOnly:true}),()=>({operation:purchases.portalOperation(operation.id,req.body?.token)}));
    return purchaseView(polled.result.operation,{verification:polled.result.verification??null,poll:{pending:polled.pending,afterMs:1000}});
  }));
  router.post('/portal/api/purchase/:id/view', json, api(async (req) => {
    const operation = purchases.portalOperation(req.params.id, req.body?.token);
    const identity = config.sellerIdentities === 'on' ? await sellerIdentities.read(operation.terms.seller.claim) : undefined;
    return purchaseView(operation, {}, identity);
  }));
  router.post('/portal/api/purchase/:id/challenge', json, api(async (req) =>
    purchases.issueApprovalChallenge({ operationId: req.params.id, token: req.body?.token, address: address(req.body?.address) })));
  // refusal: the fixed text of a handoff refused before signing (purchases.mjs PAYMENT_TERMS_CANCELLED).
  router.post('/portal/api/purchase/:id/approve', json, api(async (req) => {
    const result = await purchases.approve({ operationId: req.params.id, token: req.body?.token, challengeId: String(req.body?.challengeId ?? ''), signature: String(req.body?.signature ?? '') });
    return purchaseView(result.operation, { payload: result.payload, ...(result.refusal ? { refusal: result.refusal } : {}) });
  }));
  router.post('/portal/api/purchase/:id/handoff', json, api(async (req) => {
    const result = await purchases.prepareHandoff({ operationId: req.params.id, token: req.body?.token });
    return purchaseView(result.operation, { payload: result.payload, ...(result.refusal ? { refusal: result.refusal } : {}) });
  }));
  router.post('/portal/api/purchase/:id/native-payment/lane', json, api(async (req) => {
    if (req.get('origin') !== config.publicOrigin) throw new OperationError('origin_mismatch', 'same-origin wallet lane reads are required');
    return purchases.nativePaymentLane({ operationId: req.params.id, token: req.body?.token, key: req.body?.key });
  }));
  // walletErrorCode: the wallet's structured error code (portal.js pay()), recorded, never trusted alone.
  router.post('/portal/api/purchase/:id/report', json, api(async (req) => {
    const result = await purchases.reportWalletResult({ operationId: req.params.id, token: req.body?.token, txHash: req.body?.txHash, walletError: req.body?.walletError, walletErrorCode: req.body?.walletErrorCode });
    return purchaseView(result.operation, { verification: result.verification });
  }));

  // One Start approval for the embedded wallet (switch on only).
  startIntents?.mount(router, { api, json, purchaseView, address });

  // ---- DACS protocol purchase steps (offline fixture builds only) ----
  // Each returns the exact messages the bound wallet signs next; the server
  // verifies every returned signature against that wallet before use.
  const id = (req) => req.params.id;
  const token = (req) => req.body?.token;
  const sig = (value) => String(value ?? '');
  router.post('/portal/api/purchase/:id/agreement/identity', json, api(async (req) => {
    const r = await purchases.agreementIdentity({ operationId: id(req), token: token(req), address: address(req.body?.address) });
    return purchaseView(r.operation, { signRequest: { kind: 'identity-presentation', message: r.message, ...(r.delegation ? { delegation: r.delegation } : {}) } });
  }));
  router.post('/portal/api/purchase/:id/agreement/plan', json, api(async (req) => {
    const r = await purchases.agreementPlan({ operationId: id(req), token: token(req), signature: sig(req.body?.signature), delegationSignature: req.body?.delegationSignature === undefined ? undefined : sig(req.body.delegationSignature) });
    return purchaseView(r.operation, { signRequest: { kind: 'agreement', ...r.request } });
  }));
  router.post('/portal/api/purchase/:id/agreement/sign', json, api(async (req) => {
    const r = await purchases.agreementSubmit({ operationId: id(req), token: token(req), agreementSignature: req.body?.agreementSignature === undefined ? undefined : sig(req.body.agreementSignature), anchorSignature: req.body?.anchorSignature === undefined ? undefined : sig(req.body.anchorSignature) });
    return purchaseView(r.operation);
  }));
  router.post('/portal/api/purchase/:id/completion/request', json, api(async (req) => {
    const r = purchases.completionRequest({ operationId: id(req), token: token(req) });
    return purchaseView(r.operation, { signRequest: { kind: 'completed-bundle', ...r.request } });
  }));
  router.post('/portal/api/purchase/:id/completion/countersign', json, api(async (req) => {
    const r = await purchases.completionCountersign({ operationId: id(req), token: token(req), bundleSignature: sig(req.body?.bundleSignature), anchorSignature: sig(req.body?.anchorSignature) });
    return purchaseView(r.operation);
  }));
  router.post('/portal/api/purchase/:id/protocol/recheck', json, api(async (req) => {
    purchases.portalOperation(id(req),token(req));
    const polled=await purchasePoll.poll(id(req),()=>purchases.protocolRecheck({operationId:id(req),token:token(req)}),()=>({operation:purchases.portalOperation(id(req),token(req))}));
    return purchaseView(polled.result.operation,{poll:{pending:polled.pending,afterMs:1000}});
  }));

  // ---- identity add/remove (offline candidate; held unless fixture-only) ----
  // The server never signs or broadcasts. It hands the portal the single
  // provider request to make, records the wallet's reported envelope, and
  // decides completion only from chain readback.
  const identityView = (operation, extra = {}) => identityActions.portalView(operation, extra);
  router.post('/portal/api/identity/:id/view', json, api(async (req) => identityView(await identityActions.opened(req.params.id, req.body?.token))));
  router.post('/portal/api/identity/:id/connected', json, api(async (req) =>
    identityView(identityActions.connected({ id: req.params.id, token: req.body?.token, address: address(req.body?.address) }))));
  router.post('/portal/api/identity/:id/proof', json, api(async (req) =>
    identityView(await identityActions.submitProof({ id: req.params.id, token: req.body?.token, proofUrl: String(req.body?.proofUrl ?? '').trim() }))));
  router.post('/portal/api/identity/:id/request', json, api(async (req) => {
    const r = identityActions.request({ id: req.params.id, token: req.body?.token });
    return identityView(r.operation, { walletRequest: r.walletRequest });
  }));
  router.post('/portal/api/identity/:id/report', json, api(async (req) => {
    const r = await identityActions.report({ id: req.params.id, token: req.body?.token, outcome: req.body?.outcome });
    return identityView(r.operation);
  }));
  // Only before the wallet is asked; afterwards readback decides.
  router.post('/portal/api/identity/:id/cancel', json, api(async (req) => identityView(identityActions.cancel({ id: req.params.id, token: req.body?.token }))));

  return router;
}
