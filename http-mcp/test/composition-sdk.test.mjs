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
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_CHAIN_IDENTITIES, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, seedSellerListing, tool, toolRaw } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';
import { composeSdkPurchasesOn } from '../src/sdk/switch-on.mjs';
import { FIXTURE_CHAIN, NODE_ORIGIN, clientRefusal, prepareArgs, routedFetch, switchOnHarness, tp1Node } from './helpers/switch-on-world.mjs';

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

// ---- SDK purchases on: the startup binding and each session's binding ----

const healthOf = async (h) => (await (await fetch(`${h.origin}/health`)).json()).sdkPurchases;
// A record the SDK has not approved: the approved record under another revision.
const REVISION_ONE = { ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'dacs-demos-testnet-identity/revision-1', pinVersion: 'dacs-demos-testnet-identity/revision-1' };
const LOCAL = { endpoint: `${NODE_ORIGIN}/`, transportAuthority: 'tp1-node', connectionId: 'test-connection' };
// The origins of requests that went neither to the node double nor to the chain and directory fixtures.
const sellerOrigins = (h, origins) => origins.filter((origin) => ![NODE_ORIGIN, h.chain.url, h.directory.url].includes(origin));
// A listing the directory does not hold: a purchase of it ends at the verifier, before any seller request.
const ABSENT_LISTING = { listingId: 'absent-listing' };

/** The record checks the composition's binder makes before it reads the node: `record` is refused with `code`. */
async function assertRecordRefused(record, code) {
  const reads = [];
  await assert.rejects(bindTp1Profile({ record, local: LOCAL, readAuthority: async (scope) => { reads.push(scope); } }), (error) => error.code === code);
  assert.deepEqual(reads, [], 'refused before the authority was read');
}

test('the app binds only the SDK\'s approved identity record, and a revision-1 record is refused tp1_identity_unapproved before any signature', async (t) => {
  const { h, node } = await switchOnHarness(t);
  assert.deepEqual((await healthOf(h)).binding, { state: 'bound', recordId: TP1_APPROVED_IDENTITY_RECORD.recordId });
  assert.ok(node.reads.length > 0, 'the startup binding read the node');
  await assertRecordRefused(REVISION_ONE, 'tp1_identity_unapproved');
});

test('the composition refuses a fixture chain, a mainnet-labelled record and an http endpoint with their tp1 codes', async (t) => {
  for (const [label, options, code] of [['fixture chain', { node: tp1Node({ chainIdentity: FIXTURE_CHAIN }) }, 'tp1_connection_unverified'],
    ['http endpoint', { settings: { chain: { rpcUrl: 'http://node.chain.invalid', network: 'demos-testnet', timeoutMs: 1000 } } }, 'tp1_local_binding_invalid']]) {
    const { h, node } = await switchOnHarness(t, options);
    assert.deepEqual((await healthOf(h)).binding, { state: 'refused', code }, label);
    await assert.rejects(h.app.services.purchases.prepare({ accountId: 'acct_1', listingId: 'fixture-report', version: 1 }), (error) => error.code === code, label);
    if (label === 'http endpoint') assert.deepEqual(node.reads, [], 'an http endpoint is refused before any node read');
  }
  await assertRecordRefused({ ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' }, 'tp1_identity_record_invalid');
});

/** A switch-on app with a linked user whose purchase session is already bound. */
async function boundSession(t) {
  const origins = [];
  const { h, node } = await switchOnHarness(t, { origins });
  const user = await linkedUser(h);
  await h.app.services.purchases.prepare({ ...prepareArgs(h, user, 'bind-session'), ...ABSENT_LISTING }).catch(() => {});
  node.reset();
  return { h, node, user, origins, reads: node.reads.length, rows: databaseRows(h.app.db) };
}

test('after a successful startup binding, an authority reader naming the revision-1 chain makes prepare_purchase reject profile_not_admitted, with the original refusal as its cause and cause code tp1_connection_unverified, and zero seller requests', async (t) => {
  const { h, node, user, origins } = await boundSession(t);
  node.chainIdentity = TP1_REFUSED_CHAIN_IDENTITIES[0];
  const error = await clientRefusal(() => h.app.services.purchases.prepare({ ...prepareArgs(h, user), ...ABSENT_LISTING }));
  assert.deepEqual([error.code, error.cause?.code], ['profile_not_admitted', 'tp1_connection_unverified']);
  assert.deepEqual(sellerOrigins(h, origins), []);
});

test('after a successful startup binding, an authority reader that never answers makes prepare_purchase reject profile_not_admitted with cause code tp1_authority_timeout at 10,000 ms and zero action calls, and a late answer changes nothing', async (t) => {
  const { h, node, user, rows } = await boundSession(t);
  node.mode = 'gated';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refusal = clientRefusal(() => h.app.services.purchases.prepare({ ...prepareArgs(h, user), ...ABSENT_LISTING }));
  if (await Promise.race([refusal.then(() => false, () => false), node.requested.then(() => true)])) t.mock.timers.tick(10_000);
  const error = await refusal;
  assert.deepEqual([error.code, error.cause?.code], ['profile_not_admitted', 'tp1_authority_timeout']);
  node.release();
  assert.equal(databaseRows(h.app.db), rows, 'no action ran, before or after the late answer');
});

const isHeld = (error) => error.code === 'profile_not_admitted' && error.cause === undefined;

/** A switch-on composition built directly over `h`'s parts and its node double; closed after the test. */
async function composeOver(t, h, node, origins) {
  const { db, services: { accounts, ops, coordinates, challenges, directory, chain } } = h.app;
  const composed = await composeSdkPurchasesOn({ config: h.config, db, accounts, ops, coordinates, challenges, directory, chain,
    fetchImpl: routedFetch(node, origins), now: () => Date.now(), logger: createLogger({ level: 'error', sink: () => {} }), stopped: () => false });
  t.after(() => composed.close());
  return composed;
}

/**
 * A switch-on composition whose owner connection is closed after the startup binding and after linked user A's
 * session was bound by one held prepare. Linked user B has no session yet.
 */
async function closedOwnerSession(t) {
  const origins = [];
  const { h, node } = await switchOnHarness(t, { origins });
  const [a, b] = [await linkedUser(h), await linkedUser(h)];
  const composed = await composeOver(t, h, node, origins);
  await assert.rejects(composed.purchases.prepare(prepareArgs(h, a, 'bind-a')), isHeld);
  composed.close();
  return { h, node, a, b, composed, origins, reads: node.reads.length, rows: databaseRows(h.app.db) };
}

test('after a successful startup binding and while SDK purchase admission is held, each of the refused-authority setups (an authority reader naming the revision-1 chain, an authority reader that never answers, the owner connection closed after the startup binding) makes prepare_purchase reject profile_not_admitted with no cause at once, before any per-call authority read, with zero seller requests and zero action calls', async (t) => {
  for (const setup of [(node) => { node.chainIdentity = TP1_REFUSED_CHAIN_IDENTITIES[0]; }, (node) => { node.mode = 'silent'; }]) {
    const { h, node, user, origins, reads, rows } = await boundSession(t);
    setup(node);
    await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, user)), isHeld);
    assert.equal(node.reads.length, reads, 'no authority read for the call');
    assert.deepEqual(sellerOrigins(h, origins), []);
    assert.equal(databaseRows(h.app.db), rows);
  }

  const { h, node, a, b, composed, origins, reads, rows } = await closedOwnerSession(t);
  await assert.rejects(composed.purchases.prepare(prepareArgs(h, a)), isHeld);
  // B's session would bind after the close: the closed owner refuses it before any node read.
  await assert.rejects(composed.purchases.prepare(prepareArgs(h, b, 'bind-b')), (error) => error.code === 'profile_not_admitted' && error.cause?.code === 'transport_closed');
  assert.equal(node.reads.length, reads, 'no authority read after the close');
  assert.deepEqual(sellerOrigins(h, origins), []);
  assert.equal(databaseRows(h.app.db), rows);

  // With the owner left open, B's first bind reads the node and its call reaches the held client.
  const open = await composeOver(t, h, node, origins);
  const opened = node.reads.length;
  await assert.rejects(open.purchases.prepare(prepareArgs(h, b, 'bind-b')), isHeld);
  assert.ok(node.reads.length > opened, 'B bound over the open owner');
});

test('after a successful startup binding, a closed owner connection makes prepare_purchase reject profile_not_admitted with cause code transport_closed and zero seller requests and zero action calls', async (t) => {
  const { h, a, composed, origins, rows } = await closedOwnerSession(t);
  const error = await clientRefusal(() => composed.purchases.prepare(prepareArgs(h, a)));
  assert.deepEqual([error.code, error.cause?.code], ['profile_not_admitted', 'transport_closed']);
  assert.deepEqual(sellerOrigins(h, origins), []);
  assert.equal(databaseRows(h.app.db), rows, 'no action ran');
});

const PURCHASE_FACTORIES_SOURCE = fileURLToPath(new URL('./purchases.mjs', import.meta.resolve('@kynesyslabs/dacs-client')));
const FEE_CEILING_MISSING = 'sdk_part_missing: P19f feeCeilingOs is not an option of the purchase factories in @kynesyslabs/dacs-client@0.1.0-alpha.0';

test('the composition supplies the client the portal\'s per-write fee ceiling constant', () => {
  if (!readFileSync(PURCHASE_FACTORIES_SOURCE, 'utf8').includes('feeCeilingOs')) throw new Error(FEE_CEILING_MISSING);
  const composition = readFileSync(join(PACKAGE_ROOT, 'src/sdk/switch-on.mjs'), 'utf8');
  assert.match(composition, /feeCeilingOs: FEE_CEILING_PER_WRITE_OS/);
});
