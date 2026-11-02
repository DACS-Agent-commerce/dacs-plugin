// Offline human-tester operator: starts fresh, task-owned loopback fixture
// services (chain, directory, public proofs) and the normal plugin app, all on
// 127.0.0.1 with fresh synthetic state. Importable for programmatic start/stop.
//
// SIMULATED ONLY. This is not Demos testnet, not funded, not ChatGPT and not
// security reviewed. Fixture acceptance of a transaction is not settlement.
//
// The app is the unmodified plugin (src/config.mjs + src/app.mjs) with its
// normal OAuth, portal approval and chain-readback rules. The operator adds no
// routes to it and holds no buyer key: buyer keys are created and held by the
// browser (embedded wallet) or the tester's own wallet. With `dashboard: true`
// the operator's own HTTP server also answers /tester/ (tester-dashboard.mjs)
// before handing every other request to the unmodified app; the dashboard is
// an ordinary OAuth client whose callback origin is added to the allowlist.
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { listenLoopback, closeServer } from './http.mjs';
import { startFixtureChain } from './chain.mjs';
import { startFixtureDirectory } from './directory.mjs';
import { startFixtureProofs } from './proofs.mjs';
import { createSyntheticSeller, buildFixtureListing, storageLocator, directorySummary, FIXTURE_LABEL } from './seller.mjs';
import { createTesterDashboard } from './tester-dashboard.mjs';

export const PACKAGE_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const DEFAULT_REDIRECT_ORIGIN = 'http://localhost:6274'; // MCP Inspector's local OAuth callback origin
export const NOTICE = 'SIMULATED OFFLINE FIXTURES ONLY: not Demos testnet, not funded, not ChatGPT, not security reviewed. Fixture acceptance is not settlement.';

// The simulated-loopback embedded-wallet profile:
// the app's same-origin wallet relay forwards the browser SDK's requests to
// the fixture chain, and GitHub lookups to the proof fixture. Live, testnet,
// ChatGPT and security acceptance remain held.
export const CORE_PROFILE_FLAGS = Object.freeze(['DACS_EMBEDDED_WALLET_WRITES', 'DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN']);

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function startOfflineTester({ port = 0, redirectOrigins = [DEFAULT_REDIRECT_ORIGIN], keepState = false, chainNetwork = 'offline-fixture', logSink = null, logLevel = 'info', dashboard = false } = {}) {
  for (const origin of redirectOrigins) {
    if (!LOOPBACK_ORIGIN.test(origin)) throw new Error(`redirect origin must be a loopback http origin (got ${String(origin).slice(0, 80)})`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer in [0, 65535]');

  // LIFO cleanup of exactly what this call created.
  const owned = [];
  const stopOwned = async () => {
    const errors = [];
    while (owned.length) {
      const step = owned.pop();
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'offline tester cleanup failed');
  };

  try {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-offline-tester-')));
    if (inside(PACKAGE_ROOT, stateDir)) {
      rmSync(stateDir, { recursive: true });
      throw new Error('the temporary directory is inside the package; set TMPDIR to a directory outside it');
    }
    if (!keepState) owned.push(async () => rmSync(stateDir, { recursive: true, force: true }));

    const proofs = await startFixtureProofs();
    owned.push(() => proofs.close());
    const chain = await startFixtureChain({ proofs });
    owned.push(() => chain.close());
    // The directory indexes seller registrations from this chain's storage.
    const directory = await startFixtureDirectory({ chain });
    owned.push(() => directory.close());

    const seller = createSyntheticSeller();
    chain.seedSellerIdentities(seller.address);
    const listing = buildFixtureListing(seller);
    const locator = storageLocator(`${seller.address}:${listing.listingId}:${listing.listingVersion}`);
    chain.seedStorage(locator, { data: listing, owner: seller.address });
    directory.add(directorySummary(listing, locator), listing);

    const server = http.createServer();
    server.requestTimeout = 60_000;
    server.headersTimeout = 20_000;
    const appPort = await listenLoopback(server, port);
    owned.push(() => closeServer(server));
    const origin = `http://127.0.0.1:${appPort}`;
    // The dashboard's OAuth callback is on this exact origin; the tester's own
    // origins are kept as given.
    const allowedOrigins = dashboard && !redirectOrigins.includes(origin) ? [...redirectOrigins, origin] : [...redirectOrigins];

    // Explicit environment: nothing is inherited from process.env.
    const env = {
      DACS_PUBLIC_ORIGIN: origin,
      DACS_ALLOW_INSECURE_LOCALHOST: '1',
      DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
      DACS_DATA_DIR: join(stateDir, 'data'),
      DACS_DIRECTORY_ORIGIN: directory.url,
      DACS_CHAIN_RPC_URL: chain.url,
      DACS_CHAIN_NETWORK: chainNetwork,
      DACS_ALLOWED_REDIRECT_ORIGINS: allowedOrigins.join(','),
      DACS_IDENTITY_WRITES: 'simulated-fixture-only',
      DACS_SELLER_IDENTITIES: 'on',
      DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback',
      DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: proofs.url,
      DACS_LOG_LEVEL: logLevel,
    };
    const config = loadConfig(env);
    const logger = createLogger({ level: logLevel, ...(logSink ? { sink: logSink } : {}) });
    const created = await createApp({ config, logger });
    owned.push(() => created.close());

    let stopped = null;
    const listingInfo = {
      label: FIXTURE_LABEL,
      listingId: listing.listingId,
      version: listing.listingVersion,
      seller: seller.claim,
      sellerAddress: seller.address,
      price: listing.pricing.price,
      locator,
    };
    const embeddedWalletUrl = `${origin}/portal/assets/embedded-wallet/index.html`;
    let tester = null;
    if (dashboard) {
      const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
      tester = createTesterDashboard({
        origin, mcpUrl: `${origin}/mcp`, embeddedWalletUrl, proofsUrl: proofs.url, listing: listingInfo, app: { name: pkg.name, version: pkg.version },
        // Public fixture counts for the evidence download.
        stats: { chain: () => chain.stats(), directory: () => directory.stats() },
      });
      owned.push(() => tester.close());
      server.on('request', (req, res) => (tester.handles(req) ? tester.handle(req, res) : created.app(req, res)));
    } else {
      server.on('request', created.app);
    }
    return {
      notice: NOTICE,
      origin,
      mcpUrl: `${origin}/mcp`,
      // Portal approval pages are opened from the links the MCP tools return;
      // this is the standalone embedded-wallet page served by the same app.
      embeddedWalletUrl,
      // Guided tester dashboard (null unless started with dashboard: true).
      dashboardUrl: tester ? tester.url : null,
      fixtures: { chain: chain.url, directory: directory.url, proofs: proofs.url },
      listing: listingInfo,
      redirectOrigins: allowedOrigins,
      stateDir,
      keepState,
      coreProfile: Object.fromEntries(CORE_PROFILE_FLAGS.map((name) => [name, env[name]])),
      chainStats: () => chain.stats(),
      directoryStats: () => directory.stats(),
      get stopped() {
        return stopped !== null;
      },
      // Idempotent: closes the app server, app (MCP + database), fixtures and
      // (unless keepState) the temporary state, in reverse start order.
      stop() {
        stopped ??= stopOwned();
        return stopped;
      },
    };
  } catch (error) {
    await stopOwned().catch(() => {});
    throw error;
  }
}
