// TEST-ONLY harness for the opt-in complete purchase profile
// (src/dacs/devnet-purchase-consumer.mjs). The actual plugin app with the
// programmatic `devnetPurchase` capability, the simulated-loopback wallet relay,
// the SDK-wire loopback chain fixture (real packaged SDK sign/confirm/broadcast),
// the SIMULATED SR-2 fixture substrate and seller agents on their own loopback
// servers. `restart()` rebuilds the app over the same SQLite data directory.
// Every outcome is simulated; nothing contacts node2 or any public host.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { startSdkChainFixture } from './embedded-wallet-flow-fixtures.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';

// `now` (optional) is the plugin/substrate clock, as in startProtocolHarness.
// `browserAgreement` (optional) also enables the Agreement-only broker profile.
export async function startDevnetHarness({ devnetPurchase = { execution: 'simulated-loopback' }, now, browserAgreement } = {}) {
  const chain = await startSdkChainFixture();
  const directory = await startDirectoryFixture();
  const anchors = await startAnchorFixture(now ? { clock: now } : {});
  const endpoints = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-devnet-purchase-'));
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({
    DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir, DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback',
  });
  const logs = [];
  const build = () => createApp({ config, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    dacsProtocol: { anchorUrl: anchors.url, sellerEndpoint: (claim) => endpoints.get(claim) ?? null, ...(devnetPurchase ? { devnetPurchase } : {}), ...(browserAgreement ? { browserAgreement } : {}) }, ...(now ? { now } : {}) });
  let created;
  try { created = await build(); } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true });
    throw error;
  }
  server.on('request', (req, res) => created.app(req, res));
  const sellers = [];
  let restarts = 0;
  return {
    origin, mcpUrl: `${origin}/mcp`, chain, directory, anchors, endpoints, config, logs, sellers,
    get app() { return created; },
    restarts: () => restarts,
    // Same data directory and secrets; no in-memory state survives.
    async restart() { await created.close(); created = await build(); restarts += 1; },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await created.close();
      for (const s of sellers) await s.close();
      await anchors.close(); await chain.close(); await directory.close();
      rmSync(dataDir, { recursive: true });
    },
  };
}
