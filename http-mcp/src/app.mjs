// Composition root: one Express app serving
//   GET  /health                                  liveness + configuration status
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
//   *    /oauth/*                                 built-in authorization server (builtin mode)
//   *    /portal/*                                trusted wallet signing portal
//   POST /mcp                                     MCP Streamable HTTP (2025 stateless + 2026 per-request)
//
// SDK purchases (DACS_SDK_PURCHASES) are off in every shipped configuration:
// loadConfig refuses `on` until the switch-on path is validated. With the switch
// off the app builds no purchase service, wallet relay, seller transport or
// listing verifier. Routes and tools get a refusal object with the client
// purchase service's member names: its passive readers (views, status,
// readback) answer not_configured naming the client part they need, and every
// purchase action answers sdk_purchases_off. get_listing answers not_configured
// with reason sdk_purchases_off. Directory search, accounts, identity reads and
// identity actions work as usual. The chain reader has only the identity read.
//
// A configuration with the switch on (test fixtures only) gets the switch-on
// composition in src/sdk/switch-on.mjs: the startup TP-1 binding, one set of
// client purchase objects per buyer session, and, with DACS_INTENT_APPROVAL on,
// the Agreement CREATE delivery and its challenge, claim and pass routes, which
// read KILL on every call and share the portal's relay capability store. Its
// chain reader adds the client's public testnet reads, pinned to the SDK
// record's chain identity. The native wallet relay stays unmounted: it needs a
// server-held buyer key. The composition's process descriptor is returned as
// `services.switchOn`.
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createMcpHandler, verifyBearerToken, bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createCoordinateStore, createDirectoryClient, SDK_PROVENANCE } from '@kynesyslabs/dacs-client';
import { createDemosPublicChainReader } from '@kynesyslabs/dacs-client/substrate/demos';
import { openDatabase } from './store/database.mjs';
import { createAccountService } from './accounts.mjs';
import { createChallengeService } from './wallet/challenges.mjs';
import { createOperationStore } from './operations.mjs';
import { createDemosChainReader } from './sdk/chain-reader.mjs';
import { createPurchasesOff, LISTING_VERIFICATION_OFF } from './sdk/activation-seams.mjs';
import { composeSdkPurchasesOn, releasePreparedOwner } from './sdk/switch-on.mjs';
import { createStopFileCheckSync } from './stop-file.mjs';
import { createAgreementCreateRouter } from './portal/agreement-create-routes.mjs';
import { createStartIntents } from './portal/start-intent.mjs';
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
import { PURCHASE_POLL_DRAIN_MS } from './portal/purchase-poll.mjs';
import { createPurchaseStepLog } from './util/purchase-step-log.mjs';
import { assertTp1RecordCopy } from './tp1-record-copy.mjs';

function serverSecret(db, name) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  if (row) return row.value;
  db.prepare('INSERT OR IGNORE INTO secrets (name, value, created_at) VALUES (?, ?, ?)').run(name, randomBytes(32).toString('base64url'), new Date().toISOString());
  return db.prepare('SELECT value FROM secrets WHERE name = ?').get(name).value;
}

// Options of the in-process Agreement brokers this app no longer composes.
const REMOVED_BROKER_OPTIONS = Object.freeze(['dacsProtocol', 'nativeWalletTransport', 'devnetAgreementTransport', 'offlineAgreementBroker']);

/**
 * Builds the app for `config`: the Express `app`, an async `close`, the
 * database and the services. With SDK purchases on it binds at startup first
 * (src/sdk/switch-on.mjs), over the node connection `preparedOwner` (a
 * prepareSwitchOnOwner handle for this `config`) or one of its own, and gives
 * the composition `recorderNamespace`, the evidence recorder's subpath
 * namespace or null. `listingVerifierFactory` and `routerFactories`
 * (`{ portal, agreementCreate }`) replace the client's listing verifier and the
 * two router constructors for a direct test of the switch-on wiring. In either
 * composition it first rejects Tp1RecordCopyDrift when the browser's TP-1
 * record copy differs from the SDK's (src/tp1-record-copy.mjs). Rejects
 * TypeError before opening the database for a removed broker option or for
 * switch combinations that cannot run together; a prepared connection it did
 * not take is closed when it rejects.
 */
export async function createApp(options) {
  try {
    return await assembleApp(options);
  } catch (error) {
    releasePreparedOwner(options.preparedOwner);
    throw error;
  }
}

async function assembleApp(options) {
  const { config, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = createLogger({ level: config.logLevel }), preparedOwner = null, recorderNamespace = null,
    listingVerifierFactory, routerFactories = { portal: createPortalRouter, agreementCreate: createAgreementCreateRouter } } = options;
  assertTp1RecordCopy();
  const removed = REMOVED_BROKER_OPTIONS.filter((name) => Object.hasOwn(options, name));
  if (removed.length > 0) throw new TypeError(`createApp takes no ${removed.join(', ')}: the client's Agreement CREATE goes only to the CREATE delivery`);
  if (config.sellerWriteBatches === 'on') throw new TypeError('seller write batches are held until native SDK preparation and batch transport integration are reviewed');
  if (config.showcaseReportView === true && config.showcaseLedger === true) throw new TypeError('the showcase report view and the showcase ledger cannot be enabled together');
  if (config.intentApproval === 'on' && config.portalAutoAdvance === 'on') throw new TypeError('DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off');
  const db = openDatabase(config.databasePath);
  const accounts = createAccountService({ db, builtinIssuer: config.builtinIssuer, now });
  const challenges = createChallengeService({ db, origin: config.publicOrigin, ttlSeconds: config.challengeTtlSeconds, now });
  // Per-step purchase timeline at debug; one buffered summary line per stage at info.
  const purchaseSteps = createPurchaseStepLog({ logger });
  const ops = createOperationStore({ db, timeline: purchaseSteps, handoffSecret: serverSecret(db, 'handoff-hmac-key'), now });
  const coordinates = createCoordinateStore({ db, now });
  const directory = config.directory ? createDirectoryClient({ ...config.directory, fetchImpl }) : null;
  // With SDK purchases on, the Listing verifier and the purchase service read storage programs, the chain identity,
  // nonces and transfers through the client's public testnet reader, pinned to the SDK record's chain identity.
  const chainReads = config.chain && config.sdkPurchases === 'on'
    ? createDemosPublicChainReader({ rpcUrl: config.chain.rpcUrl, network: 'testnet', pinnedIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, timeoutMs: config.chain.timeoutMs, fetchImpl })
    : null;
  const chain = config.chain ? createDemosChainReader({ ...config.chain, fetchImpl, chainReads }) : null;
  // The CREATE delivery's write stop reads the KILL file at each call.
  const sdk = config.sdkPurchases === 'on'
    ? await composeSdkPurchasesOn({ config, db, accounts, ops, coordinates, challenges, directory, chain, fetchImpl, now, logger, preparedOwner, recorderNamespace,
      listingVerifierFactory, stopped: createStopFileCheckSync({ dataDir: config.dataDir, logger }) })
    : null;
  const verifier = sdk?.verifier ?? LISTING_VERIFICATION_OFF;
  const purchases = sdk?.purchases ?? createPurchasesOff();
  const intents = config.intentApproval === 'on';
  const startIntents = intents ? sdk?.starts ?? createStartIntents({ purchases, accounts, chain, now }) : null;
  const createDelivery = sdk && intents ? sdk.delivery : null;
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
  const factory = createMcpServerFactory({ config, services, logger, devnetLivePurchase: false });
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
  app.get('/health', (_req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      database = 'error';
    }
    res.status(database === 'ok' ? 200 : 503).json({
      status: database === 'ok' ? 'ok' : 'degraded',
      server: SERVER_INFO,
      mcp: config.mcpUrl,
      authMode: config.authMode,
      authorizationServer: issuer,
      dependencies: {
        database,
        directory: directory ? { configured: true, origin: directory.origin } : { configured: false },
        chain: chain ? { configured: true, rpcOrigin: chain.rpcOrigin, network: chain.network } : { configured: false },
        externalIssuer: config.authMode === 'external' ? { configured: true, issuer } : { configured: false },
      },
      // No evidence recorder is composed in either composition, so no purchase evidence is recorded.
      // With the switch on, `binding` is the startup TP-1 binding: bound with its record id, or refused with its code.
      sdkPurchases: { switch: config.sdkPurchases, evidence: 'unavailable', ...(sdk ? { binding: sdk.bindingState } : {}) },
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

  // The routers' options; with the switch on, both hold the composition's one relay capability store.
  const routeInputs = Object.freeze({
    portal: Object.freeze({ config, db, authServer, accounts, challenges, purchases, identityActions, sellerIdentities, linkSecret, logger,
      authenticateProbeBearer: async (header) => verifyBearerToken(header, { verifier: await getVerifier(), resourceMetadataUrl: prmUrl }), chain, fetchImpl, now,
      timeline: purchaseSteps, startIntents, createDelivery, relayAccess: sdk?.relayAccess ?? null, startupRefusal: sdk?.startupRefusal ?? null }),
    agreementCreate: createDelivery
      ? Object.freeze({ delivery: createDelivery, challenges, purchases, accounts, relayAccess: sdk.relayAccess, starts: startIntents, logger, now })
      : null,
  });
  const portalRouter = routerFactories.portal(routeInputs.portal);
  app.use(portalRouter);
  if (routeInputs.agreementCreate) app.use(routerFactories.agreementCreate(routeInputs.agreementCreate));

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
    clearInterval(purgeTimer);
    // Let in-flight portal rechecks finish before their dependencies close,
    // but never for longer than the bound: a hung seller call must not hold
    // shutdown open. A timed-out drain closes exactly as a shutdown without a
    // drain would; any unknown outcome stays readback-only.
    if (!await portalRouter.drainPurchasePolls({ timeoutMs: PURCHASE_POLL_DRAIN_MS })) logger.warn('portal_poll_drain_timeout', { timeoutMs: PURCHASE_POLL_DRAIN_MS });
    purchaseSteps.close();
    await mcpHandler.close();
    sdk?.close();
    db.close();
  }

  const switchOn = sdk ? Object.freeze({ ...sdk, routeInputs }) : null;
  return { app, close, db, services: { ...services, challenges, coordinates, chain, switchOn }, authServer, issuer, protectedResourceMetadata };
}
