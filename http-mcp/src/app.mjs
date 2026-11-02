import { createPurchaseReadbackCache } from './util/purchase-readback-cache.mjs';
import { createDeliveryDeadlineWatch } from './dacs/delivery-deadline-watch.mjs';
// Composition root: one Express app serving
//   GET  /health                                  liveness + configuration status
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
//   *    /oauth/*                                 built-in authorization server (builtin mode)
//   *    /portal/*                                trusted wallet signing portal
//   POST /mcp                                     MCP Streamable HTTP (2025 stateless + 2026 per-request)
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createMcpHandler, verifyBearerToken, bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { openDatabase } from './store/database.mjs';
import { createAccountService } from './accounts.mjs';
import { createChallengeService } from './wallet/challenges.mjs';
import { createOperationStore } from './operations.mjs';
import { createCoordinateStore } from './dacs/wallet-transactions.mjs';
import { createDirectoryClient } from './dacs/directory.mjs';
import { createDemosChainReader } from './dacs/chain.mjs';
import { createListingVerifier } from './dacs/verification.mjs';
import { createPurchaseService } from './purchases.mjs';
import { createProtocolPurchases, OFFLINE_AGREEMENT_MODE } from './dacs/protocol-purchases.mjs';
import { createLegacyPublicationService } from './legacy-publications.mjs';
import { createSellerIdentityReader } from './seller-identities.mjs';
import { createIdentityService, createIdentityActions } from './identities.mjs';
import { createAuthorizationServer } from './auth/authorization-server.mjs';
import { builtinTokenVerifier, discoverExternalIssuer } from './auth/token-verifier.mjs';
import { RESOURCE_SCOPES } from './auth/scopes.mjs';
import { createPortalRouter } from './portal/routes.mjs';
import { createMcpServerFactory, SERVER_INFO } from './mcp/server.mjs';
import { createLogger } from './util/log.mjs';
import { createRateLimiter, clientAddress } from './util/rate-limit.mjs';
import { SDK_PROVENANCE } from './dacs/listing.mjs';
import { createOfflineAgreementBroker } from './portal/offline-agreement-broker.mjs';
import { createWalletRpcRouter } from './portal/wallet-rpc.mjs';
import { PURCHASE_POLL_DRAIN_MS } from './portal/purchase-poll.mjs';
import { createPurchaseStepLog } from './util/purchase-step-log.mjs';
import { isDevnetNativeTransport, isDevnetAgreementTransport } from './wallet/devnet-native-transport.mjs';
import { createDevnetAgreementTransportBroker } from './portal/devnet-agreement-transport-broker.mjs';
import { operatorBuyerAccessConfig } from './devnet-demo/buyer-access.mjs';
import { demDeliveryContextUsage } from './dacs/dem-delivery-context-consumer.mjs';

function serverSecret(db, name) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  if (row) return row.value;
  db.prepare('INSERT OR IGNORE INTO secrets (name, value, created_at) VALUES (?, ?, ?)').run(name, randomBytes(32).toString('base64url'), new Date().toISOString());
  return db.prepare('SELECT value FROM secrets WHERE name = ?').get(name).value;
}

// dacsProtocol ({ anchorUrl, sellerEndpoint(claim) }) enables offline DACS
// protocol purchases against a loopback seller agent and the SIMULATED SR-2
// fixture substrate. It is a programmatic option only (no environment
// variable); without it protocol purchases refuse as unavailable.
// walletAgreement ({ rpcUrl, network, journal, walletFactory }) separately
// enables the bounded simulated SR-2 Agreement profile. Its factory is an
// explicit local fixture capability; no buyer key or wallet fallback is held
// by the plugin and no environment option enables this path.
// browserAgreement ({ journal, ttlMs? }) is a separate LOOPBACK TEST ONLY
// option: the portal authenticates the bound wallet and the actual built-in
// UI approves CREATE; it cannot be combined with an injected walletFactory.
// It has no env/CLI/public-server enabling path or payment authorization. The
// separate nativeAgreementPayment programmatic consumer can bind NEW terms
// to normal payment approval after public Agreement/fixture commitment reads.
export async function createApp({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = createLogger({ level: config.logLevel }), dacsProtocol = null, nativeWalletTransport = null, devnetAgreementTransport = null, testOnlyDeliveryDeadlineTimer }) {
  if (config.sellerWriteBatches === 'on') throw new TypeError('seller write batches are held until native SDK preparation and batch transport integration are reviewed');
  if (config.showcaseReportView === true && config.showcaseLedger === true) throw new TypeError('the showcase report view and the showcase ledger cannot be enabled together');
  if (config.intentApproval === 'on' && config.portalAutoAdvance === 'on') throw new TypeError('DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off');
  // Source capability only. Config/model approval booleans cannot instantiate
  // a transport or admit a pin. Existing portal/purchase profiles stay held.
  if (nativeWalletTransport !== null && !isDevnetNativeTransport(nativeWalletTransport)) throw new TypeError('nativeWalletTransport requires the explicit independently trusted source capability');
  if (devnetAgreementTransport !== null && !isDevnetAgreementTransport(devnetAgreementTransport)) throw new TypeError('devnetAgreementTransport requires its separate opaque source capability');
  if (devnetAgreementTransport && (nativeWalletTransport || dacsProtocol?.browserAgreement || dacsProtocol?.walletAgreement || dacsProtocol?.nativeAgreementPayment)) throw new TypeError('choose the separately constructed Agreement source, never migrate or combine old profiles');
  // The native-demo profile mounts the Agreement relay and broker; both need
  // the constructed operator buyer-access capability (an open one admits all).
  const buyerAccess = operatorBuyerAccessConfig(dacsProtocol?.buyerAccess);
  if (devnetAgreementTransport && !buyerAccess) throw new TypeError('devnetAgreementTransport requires the constructed operator buyerAccess capability');
  const walletTransport = devnetAgreementTransport ?? nativeWalletTransport;
  const db = openDatabase(config.databasePath);
  const accounts = createAccountService({ db, builtinIssuer: config.builtinIssuer, now });
  const challenges = createChallengeService({ db, origin: config.publicOrigin, ttlSeconds: config.challengeTtlSeconds, now });
  // Per-step purchase timeline at debug; one buffered summary line per stage at info.
  const purchaseSteps = createPurchaseStepLog({ logger });
  const readbackCache = config.readbackCache ? createPurchaseReadbackCache({ loadPurchase: (id) => {
    const row = db.prepare("SELECT kind,status,state FROM operations WHERE id=?").get(id);
    return row ? { ...row, state: JSON.parse(row.state) } : null;
  } }) : null;
  const timeline = { record: (fields) => { readbackCache?.stageChange(fields); purchaseSteps.record(fields); } };
  const ops = createOperationStore({ db, timeline, handoffSecret: serverSecret(db, 'handoff-hmac-key'), now });
  const coordinates = createCoordinateStore({ db, now });
  const detachTimeline=walletTransport?.onPurchaseStep((fields)=>{
    const rows=fields.jobId ? db.prepare("SELECT id,terms FROM operations WHERE kind='purchase' AND json_extract(terms,'$.protocol.jobId')=?").all(fields.jobId)
      : db.prepare("SELECT o.id,o.terms FROM operations o JOIN write_coordinates c ON c.operation_id=o.id WHERE o.kind='purchase' AND c.from_address=? AND c.expected_nonce=?").all(fields.writer,fields.nonce);
    if(rows.length===1)purchaseSteps.record({...fields,purchaseId:rows[0].id,jobId:JSON.parse(rows[0].terms).protocol?.jobId ?? null});
  });
  const directory = config.directory ? createDirectoryClient({ ...config.directory, fetchImpl }) : null;
  const chain = devnetAgreementTransport ? devnetAgreementTransport.chainReader() : config.chain ? createDemosChainReader({ ...config.chain, fetchImpl }) : null;
  const verifier = createListingVerifier({ directory, chain, now, cacheImmutable:Boolean(devnetAgreementTransport), observeBinding:devnetAgreementTransport?()=>devnetAgreementTransport.observeBinding():null });
  const browserAgreement = dacsProtocol?.browserAgreement;
  if (browserAgreement && Object.keys(browserAgreement).some((k) => !['journal', 'ttlMs'].includes(k))) throw new Error('the loopback browser broker accepts only an explicit public journal and bounded expiry');
  if (browserAgreement && dacsProtocol.walletAgreement) throw new Error('choose either the loopback browser broker or the injected fixture wallet, not both');
  const offlineAgreementBroker = devnetAgreementTransport ? createDevnetAgreementTransportBroker({config,ops,accounts,challenges,sourceCapability:devnetAgreementTransport,journal:devnetAgreementTransport.journal,assertBuyerAccess:(operation)=>protocol.assertBuyerAccess(operation.terms.buyer.wallet,operation),fetchImpl,now}) : browserAgreement ? createOfflineAgreementBroker({ config, ops, accounts, challenges, journal: browserAgreement.journal, ttlMs: browserAgreement.ttlMs, fetchImpl, now }) : null;
  const deliveryDeadlineWatch = createDeliveryDeadlineWatch({ db, ops, coordinates, enabled: config.deliveryDeadlineWatch === 'on', now, logger, ...(testOnlyDeliveryDeadlineTimer ? { timer: testOnlyDeliveryDeadlineTimer } : {}) });
  if (dacsProtocol) dacsProtocol = { ...dacsProtocol, commitOnSignature: config.commitOnSignature ?? false };
  const protocol = createProtocolPurchases({ db, ops, coordinates, dacsProtocol: offlineAgreementBroker ? { ...dacsProtocol, walletAgreement: offlineAgreementBroker.walletAgreement, ...(devnetAgreementTransport ? {nativeAgreementPayment:devnetAgreementTransport}: {}) } : dacsProtocol, fetchImpl, now, deliveryDeadlineWatch, readbackCache, buyerChainReadback: config.buyerChainReadback === 'on' });
  const purchases = createPurchaseService({ db, config, ops, coordinates, accounts, verifier, chain, challenges, protocol, now, logger });
  // Historical owner history and nonce-proven cancellation; no publication writer.
  const agents = createLegacyPublicationService({ db, ops, coordinates, chain });
  const identityClient = new AsyncLocalStorage();
  const sellerIdentities = createSellerIdentityReader({ config, chain, now, fetchImpl, clientKey: () => identityClient.getStore() });
  const identities = createIdentityService({ chain, accounts, now });
  const identityActions = createIdentityActions({ config, ops, accounts, coordinates, chain, now });
  const linkSecret = serverSecret(db, 'wallet-link-hmac-key');

  // ---- authorization ----
  let authServer = null;
  let issuer;
  let getVerifier;
  if (config.authMode === 'builtin') {
    authServer = await createAuthorizationServer({ config, db, accounts, now, logger });
    issuer = authServer.issuer;
    const verifier = builtinTokenVerifier({ issuer, audience: config.mcpUrl, publicJwks: authServer.publicJwks });
    getVerifier = async () => verifier;
  } else {
    issuer = config.externalIssuer.issuer;
    let pending = null;
    getVerifier = async () => {
      pending ??= discoverExternalIssuer({ ...config.externalIssuer, audience: config.mcpUrl, fetchImpl }).then((r) => r.verifier).catch((error) => {
        pending = null;
        logger.error('external_issuer_unavailable', { issuer, message: error.message });
        throw error;
      });
      return pending;
    };
  }
  const prmUrl = `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const protectedResourceMetadata = {
    resource: config.mcpUrl,
    authorization_servers: [issuer],
    scopes_supported: RESOURCE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'DACS testnet commerce',
  };

  const services = { accounts, ops, directory, verifier, purchases, agents, identities, identityActions, sellerIdentities, linkSecret };
  // The Node2 Devnet operator composition makes the SR-2 wallet Agreement
  // purchase real; the MCP text must say so instead of the held default.
  const devnetLivePurchase = Boolean(devnetAgreementTransport && dacsProtocol?.nativeSellerCommitment && dacsProtocol?.nativeDemDelivery);
  // The showcase reports a live purchase only when the protocol can also
  // prepare it (that needs the seller endpoint resolver).
  const showcaseLivePurchase = devnetLivePurchase && protocol.supportsMode(OFFLINE_AGREEMENT_MODE);
  const factory = createMcpServerFactory({ config, services, logger, devnetLivePurchase, showcaseLivePurchase });
  const maxRequestBodySize = 256 * 1024;
  const mcpHandler = createMcpHandler(factory, { legacy: 'stateless', maxRequestBodySize, onerror: (error) => logger.warn('mcp_protocol_error', { message: error.message }) });
  const nodeMcp = toNodeHandler(mcpHandler, { maxRequestBodySize, onerror: (error) => logger.error('mcp_adapter_error', { message: error.message }) });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const publicHost = new URL(config.publicOrigin).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'];
  const allowedHosts = config.allowInsecureLocal ? [publicHost, ...local] : [publicHost];
  // Liveness first: container healthchecks connect via 127.0.0.1 without the public Host.
  const partyVetStore = () => (dacsProtocol?.demDeliveryContext ? demDeliveryContextUsage(dacsProtocol.demDeliveryContext) : null);
  app.get('/health', (_req, res) => {
    const vetStore = partyVetStore();
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      database = 'error';
    }
    const sellerTls = dacsProtocol?.sellerTlsReadiness?.();
    res.status(database === 'ok' ? 200 : 503).json({
      status: database === 'ok' && sellerTls?.status !== 'unusable' ? 'ok' : 'degraded',
      ...(sellerTls ? { sellerTls } : {}),
      server: SERVER_INFO,
      mcp: config.mcpUrl,
      authMode: config.authMode,
      authorizationServer: issuer,
      dependencies: {
        database,
        directory: directory ? { configured: true, origin: directory.origin } : { configured: false },
        chain: chain ? { configured: true, rpcOrigin: chain.rpcOrigin, network: chain.network } : { configured: false },
        externalIssuer: config.authMode === 'external' ? { configured: true, issuer } : { configured: false },
        // The operator's party Vet store: used and remaining jobs and bytes.
        // New purchase plans fail closed once it is full.
        ...(vetStore ? { partyVetStore: vetStore } : {}),
      },
      sdk: SDK_PROVENANCE,
      liveness: 'This endpoint never reports chain, payment or ChatGPT installation success.',
    });
  });

  app.use(hostHeaderValidation(allowedHosts));

  // Access log: method, path (never query or fragment), status, duration.
  let oauthRequestSequence = 0;
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    // Debug only: a canceled authorization has no `finish` access-log entry.
    // Use a local sequence instead of any OAuth parameter, cookie or header.
    const request = config.logLevel === 'debug' && req.path === '/oauth/auth' ? ++oauthRequestSequence : null;
    const elapsed = () => Number((process.hrtime.bigint() - started) / 1_000_000n);
    if (request !== null) {
      logger.debug('oauth_auth_request', { request, phase: 'received', method: req.method });
      res.once('close', () => {
        if (!res.writableFinished) logger.debug('oauth_auth_request', { request, phase: 'disconnected', ms: elapsed() });
      });
    }
    res.on('finish', () => {
      logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: elapsed() });
      if (request !== null) logger.debug('oauth_auth_request', { request, phase: 'finished', status: res.statusCode, ms: elapsed() });
    });
    next();
  });
  const limiter = createRateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000, now });
  app.use(['/mcp', '/portal/api', '/portal/authorize', '/oauth'], limiter);

  const prm = (_req, res) => res.set('access-control-allow-origin', '*').json(protectedResourceMetadata);
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], prm);

  if (authServer) {
    // RFC 8414 path-insertion and OIDC suffix forms for an issuer with path /oauth.
    // oidc-provider derives its mount path from originalUrl vs url, so present
    // the request exactly as if it arrived at /oauth/.well-known/openid-configuration.
    app.get(['/.well-known/oauth-authorization-server/oauth', '/.well-known/openid-configuration/oauth', '/oauth/.well-known/oauth-authorization-server'], (req, res) => {
      req.originalUrl = '/oauth/.well-known/openid-configuration';
      req.url = '/.well-known/openid-configuration';
      authServer.callback(req, res);
    });
    app.use('/oauth', (req, res) => authServer.callback(req, res));
  }

  if (walletTransport) app.use(createWalletRpcRouter({ config,logger,nativeTransport:walletTransport,buyerAccess }));
  const portalRouter=createPortalRouter({ config, db, authServer, accounts, challenges, purchases, identityActions, sellerIdentities, linkSecret, logger, authenticateProbeBearer: async (header) => verifyBearerToken(header, { verifier: await getVerifier(), resourceMetadataUrl: prmUrl }), chain, fetchImpl, now, offlineAgreementBroker, timeline: purchaseSteps });
  app.use(portalRouter);

  // Anonymous MCP calls are allowed (public discovery tools). A presented
  // bearer token must verify, or the request is refused with a challenge.
  const optionalBearer = async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    try {
      req.auth = await verifyBearerToken(header, { verifier: await getVerifier(), resourceMetadataUrl: prmUrl });
      return next();
    } catch (error) {
      logger.info('mcp_bearer_refused', { reason: String(error?.message ?? 'invalid').slice(0, 160) });
      const response = bearerAuthChallengeResponse(error, { resourceMetadataUrl: prmUrl });
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      return res.send(await response.text());
    }
  };
  const originHosts = [publicHost, ...config.allowedRedirectOrigins.map((o) => new URL(o).hostname), ...(config.allowInsecureLocal ? local : [])];
  app.all('/mcp', originValidation(originHosts), optionalBearer, (req, res) => identityClient.run(clientAddress(req), () => nodeMcp(req, res)));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  const purgeTimer = setInterval(() => authServer?.purgeExpired(), 10 * 60 * 1000);
  purgeTimer.unref();

  async function close() {
    await deliveryDeadlineWatch.stop();
    clearInterval(purgeTimer);
    // Let in-flight portal rechecks finish before their dependencies close,
    // but never for longer than the bound: a hung seller call must not hold
    // shutdown open. A timed-out drain closes exactly as a shutdown without a
    // drain would; any unknown outcome stays readback-only.
    if (!await portalRouter.drainPurchasePolls({ timeoutMs: PURCHASE_POLL_DRAIN_MS })) logger.warn('portal_poll_drain_timeout', { timeoutMs: PURCHASE_POLL_DRAIN_MS });
    readbackCache?.close();
    detachTimeline?.();
    purchaseSteps.close();
    await walletTransport?.close();
    await mcpHandler.close();
    db.close();
  }

  return { app, close, db, startDeliveryDeadlineWatch: deliveryDeadlineWatch.start, stopDeliveryDeadlineWatch: deliveryDeadlineWatch.stop, services: { ...services, challenges, coordinates, chain, protocol }, authServer, issuer, protectedResourceMetadata };
}
