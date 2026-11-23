// The SDK purchases off composition. The app boots on the client's public entries; directory search, the account
// and the identity reads answer; listing verification and the purchase readers answer not_configured; and every
// purchase action refuses sdk_purchases_off with no seller request and no node submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TP1_REFUSED_CHAIN_IDENTITIES, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, seedSellerListing, tool, toolRaw } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURCHASE_ID = 'pur_AAAAAAAAAAAAAAAA';
const PASSIVE_READER_MISSING = 'sdk_part_missing: P19';
// The portal routes of purchase actions that call the purchase service directly.
const PORTAL_ACTIONS = ['challenge', 'approve', 'handoff', 'native-payment/lane', 'agreement/identity', 'agreement/plan', 'agreement/sign',
  'completion/request', 'completion/countersign'];
// The seller wire paths the client's HTTPS seller client calls (dacs-client src/dacs/seller-http.mjs).
const SELLER_PATHS = ['/dacs/v1/agreements/proposals', '/dacs/v1/agreements/state', '/dacs/v1/commitments', '/dacs/v1/commitments/signature',
  '/dacs/v1/payments', '/dacs/v1/bundles/request', '/dacs/v1/bundles/countersignature', '/dacs/v1/bundles/buyer-copy'];
const SELLER_MODULE = /\/@kynesyslabs\/dacs-seller\/|\/seller-agent[^/]*\.m?js$|\/http-mcp\/src\/devnet-demo\//;

/** Boots the app as shipped (every switch off) on the chain and directory fixtures, recording the origin of each outbound request. */
async function offApp(t) {
  const origins = [];
  const fetchImpl = (input, init) => {
    origins.push(new URL(input instanceof Request ? input.url : String(input)).origin);
    return fetch(input, init);
  };
  const h = await startHarness({ fetchImpl });
  t.after(() => h.close());
  return { h, origins };
}

async function post(h, path, body, headers = {}) {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, ...(await response.json()) };
}

test('with DACS_SDK_PURCHASES off the app boots, read-only tools answer, and every active purchase action refuses sdk_purchases_off with zero seller requests and zero node submissions', async (t) => {
  const { h, origins } = await offApp(t);
  assert.equal(h.config.sdkPurchases, 'off');
  seedSellerListing(h, createEphemeralWallet());
  const { results: [listing] } = await tool(h, null, 'search_agents', {});
  assert.equal(listing.verified, false);
  const user = await linkedUser(h);
  for (const [name, args] of [['get_profile', {}], ['get_account_status', {}], ['get_identities', {}]]) {
    const answer = await toolRaw(h, user, name, args);
    assert.ok(!answer.isError, `${name}: ${answer.content[0]?.text}`);
  }
  const verification = await tool(h, null, 'get_listing', { listingId: listing.listingId, version: listing.version, seller: listing.seller });
  assert.deepEqual([verification.error, verification.details], ['not_configured', { reason: 'sdk_purchases_off' }]);

  const before = databaseRows(h.app.db);
  const prepared = await tool(h, user, 'prepare_purchase', { listingId: listing.listingId, version: listing.version, seller: listing.seller, idempotencyKey: 'off-composition-1' });
  assert.equal(prepared.error, 'sdk_purchases_off');
  assert.equal((await tool(h, user, 'cancel_wallet_handoff', { operationId: PURCHASE_ID })).error, 'sdk_purchases_off');
  const body = { token: 'handoff-token', address: user.wallet.address, challengeId: 'challenge', signature: 'signature', key: 'lane' };
  for (const action of PORTAL_ACTIONS) {
    const answer = await post(h, `/portal/api/purchase/${PURCHASE_ID}/${action}`, body, { origin: h.origin });
    assert.deepEqual([answer.status, answer.error], [409, 'sdk_purchases_off'], action);
  }
  assert.equal(databaseRows(h.app.db), before, 'a refused action writes nothing');
  assert.deepEqual([...new Set(origins)].filter((origin) => origin !== h.chain.url && origin !== h.directory.url), [], 'no request left for a seller');
  assert.equal(h.chain.txs.size, 0, 'no transaction reached the node');
});

test('with DACS_SDK_PURCHASES off, purchase views, status, readback and /report answer 503 not_configured with zero writes when the installed client has no passive reader or recorder, and /health answers 200', async (t) => {
  const { h } = await offApp(t);
  const user = await linkedUser(h);
  const before = databaseRows(h.app.db);
  for (const route of ['view', 'protocol/recheck']) {
    const answer = await post(h, `/portal/api/purchase/${PURCHASE_ID}/${route}`, { token: 'handoff-token' });
    assert.deepEqual([answer.status, answer.error, answer.message], [503, 'not_configured', PASSIVE_READER_MISSING], route);
  }
  for (const name of ['get_purchase_status', 'verify_deal']) {
    const answer = await tool(h, user, name, { operationId: PURCHASE_ID });
    assert.deepEqual([answer.error, answer.message], ['not_configured', PASSIVE_READER_MISSING], name);
  }
  const report = await post(h, `/portal/api/purchase/${PURCHASE_ID}/report`, { token: 'handoff-token', txHash: `0x${'ab'.repeat(32)}` });
  assert.deepEqual([report.status, report.error, report.details], [503, 'not_configured', { reason: 'sdk_purchases_off' }]);
  assert.equal(databaseRows(h.app.db), before, 'nothing was recorded');

  const health = await fetch(`${h.origin}/health`);
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.status, 'ok');
  assert.deepEqual(status.sdkPurchases, { switch: 'off', evidence: 'unavailable' });
});

test('with DACS_SDK_PURCHASES off, the CREATE evidence routes answer 503 not_configured with zero writes when the installed client has no evidence recorder', async (t) => {
  const { h } = await offApp(t);
  const before = databaseRows(h.app.db);
  for (const route of ['journal', 'result']) {
    const answer = await post(h, `/portal/api/purchase/${PURCHASE_ID}/agreement-create/${route}`, { token: 'handoff-token' });
    assert.ok(answer.status !== 404, 'the CREATE evidence router is not mounted: src/portal/agreement-create-evidence.mjs is absent');
    assert.deepEqual([answer.status, answer.error, answer.message], [503, 'not_configured', 'sdk_part_missing: P19r createPurchaseEvidenceRecorder'], route);
  }
  assert.equal(databaseRows(h.app.db), before);
});

/** The URL of every module that importing `entry` (a path under http-mcp) resolves, recorded in a child process. */
function loadedModules(entry) {
  const script = [
    "import { registerHooks } from 'node:module';",
    'const urls = new Set();',
    'registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); urls.add(resolved.url); return resolved; } });',
    `await import(${JSON.stringify(new URL(`../${entry}`, import.meta.url).href)});`,
    'process.stdout.write(JSON.stringify([...urls]));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('the app has no in-process seller route and its module graph reaches no seller module', async (t) => {
  const { h } = await offApp(t);
  for (const path of SELLER_PATHS) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${h.origin}${path}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      assert.deepEqual([response.status, (await response.json()).error], [404, 'not_found'], `${method} ${path}`);
    }
  }
  const loaded = loadedModules('src/app.mjs');
  assert.ok(loaded.some((url) => url.endsWith('/http-mcp/src/app.mjs')), 'the scan saw the app itself');
  assert.ok(loaded.some((url) => url.includes('/@kynesyslabs/dacs-client/')), 'the scan followed the client package');
  assert.deepEqual(loaded.filter((url) => SELLER_MODULE.test(url)), []);
});

const filesUnder = (path) => (statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => filesUnder(join(path, name))) : [path]);
const REFUSED_IDENTITIES = [...TP1_REFUSED_CHAIN_IDENTITIES, ...TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES].map((identity) => identity.toLowerCase().replace(/^0x/, ''));
// The embedded wallet's own storage-anchor pin is the one listed exception: the wallet, not the server, owns that value.
const WALLET_PIN = { file: 'public/portal/embedded-wallet/sdk-provider.mjs', line: /^export const DACS_STORAGE_ANCHOR_CHAIN_IDENTITY = '[0-9a-f]{64}';$/ };
const holdsRefusedIdentity = (text) => REFUSED_IDENTITIES.some((identity) => text.toLowerCase().includes(identity));

test('no identity on the SDK\'s refused list appears in http-mcp sources or served assets', () => {
  assert.ok(REFUSED_IDENTITIES.length > 0, 'the SDK names refused identities');
  const packed = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).files;
  const scanned = [...packed, 'scripts'].map((entry) => join(PACKAGE_ROOT, entry)).filter((path) => statSync(path, { throwIfNoEntry: false })).flatMap(filesUnder);
  assert.ok(scanned.some((file) => file.endsWith('src/app.mjs')) && scanned.some((file) => file.endsWith('public/portal/portal.js')));
  const holding = scanned.filter((file) => holdsRefusedIdentity(readFileSync(file, 'latin1'))).map((file) => relative(PACKAGE_ROOT, file));
  assert.deepEqual(holding, [WALLET_PIN.file]);
  const lines = readFileSync(join(PACKAGE_ROOT, WALLET_PIN.file), 'utf8').split('\n').filter(holdsRefusedIdentity);
  assert.equal(lines.length, 1);
  assert.match(lines[0], WALLET_PIN.line);
});

const ADMISSION_INPUTS = ['identityRecord', 'record', 'profile', 'actionsAdmitted', 'admission', 'binding'];

test('no configuration key, environment variable or tool argument can supply an identity record, profile or admission flag to the client factories', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'composition-admission-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir };
  const injected = { DACS_IDENTITY_RECORD: '{}', DACS_TP1_IDENTITY_RECORD: '{}', DACS_TP1_PROFILE: 'testnet-tp1', DACS_PROFILE: 'testnet-tp1', DACS_ACTIONS_ADMITTED: '1',
    DACS_ADMISSION: '{}', identityRecord: '{}', actionsAdmitted: 'true', admission: '{}' };
  const config = loadConfig({ ...env, ...injected });
  assert.deepEqual(config, loadConfig(env), 'the environment names no admission input');

  const withKeys = { ...config, identityRecord: { revision: 2 }, profile: 'testnet-tp1', actionsAdmitted: true, admission: { binding: {} }, binding: {} };
  const app = await createApp({ config: withKeys, logger: createLogger({ level: 'error', sink: () => {} }) });
  t.after(() => app.close());
  await assert.rejects(app.services.purchases.prepare({ accountId: 'acct', listingId: 'listing', version: 1 }), (error) => error.code === 'sdk_purchases_off');

  const server = http.createServer(app.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const client = new Client({ name: 'composition-admission', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  t.after(() => client.close());
  for (const { name, inputSchema } of (await client.listTools()).tools) {
    assert.equal(inputSchema.additionalProperties, false, `${name} takes only its named arguments`);
    assert.deepEqual(Object.keys(inputSchema.properties ?? {}).filter((key) => ADMISSION_INPUTS.includes(key)), [], name);
  }
});
