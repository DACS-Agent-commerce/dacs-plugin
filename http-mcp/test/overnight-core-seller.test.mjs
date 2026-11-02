// Retained embedded-wallet profile checks: unconfigured and testnet-held
// sessions refuse writes. The simulated transport retains storage CREATE
// support and publication fault coverage remain active until retirement.
// SDK-dependent cases require wallet-build dependencies and remain host gates.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { loadConfig, ConfigError } from '../src/config.mjs';
import { createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation, buildListingDraft, listingSigningMessage, attachListingSignature, logicalListingAddress } from '../src/dacs/listing.mjs';
import { communityProgramName, deriveStorageAddress, buildStorageProgramCreatePayload } from '../src/dacs/wallet-transactions.mjs';
import { startHarness } from './helpers/harness.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startOvernightChain, startOvernightDirectory } from './helpers/overnight-core-fixtures.mjs';

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed';
// The prepared dependencies may be a symlinked node_modules; importers inside
// the SDK then carry the real path.
const sdkPrefixes = SDK_BLOCKED ? [] : [sdkDir.href, `${pathToFileURL(realpathSync(fileURLToPath(sdkDir))).href}/`];

// Same scoped resolution shim as embedded-wallet-transaction.test.mjs: only
// importers inside the installed SDK get dir/ -> dir/index.js and ./x -> ./x.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!sdkPrefixes.some((prefix) => context.parentURL?.startsWith(prefix))) throw error;
      if (error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' && error.url) return nextResolve(new URL('index.js', error.url.endsWith('/') ? error.url : `${error.url}/`).href, context);
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
      throw error;
    }
  },
});

async function loadSdk() {
  const require = createRequire(new URL('package.json', buildDir));
  assert.equal(JSON.parse(readFileSync(new URL('package.json', sdkDir), 'utf8')).version, '4.0.16');
  const { Demos } = await import(pathToFileURL(require.resolve('@kynesyslabs/demosdk/websdk')).href);
  const { Identities } = await import(new URL('build/abstraction/Identities.js', sdkDir).href);
  const { StorageProgram } = await import(new URL('build/storage/StorageProgram.js', sdkDir).href);
  const { validateMnemonic: bip39Validate } = await import(pathToFileURL(require.resolve('@scure/bip39')).href);
  const { wordList } = await import(new URL('build/encryption/PQC/falconts/wordlist.js', sdkDir).href);
  return { Demos, Identities, StorageProgram, validateMnemonic: (m) => typeof m === 'string' && bip39Validate(m, wordList) };
}

const sdk = SDK_BLOCKED ? null : await loadSdk();
const BASE_ENV = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(40) };

let h;
let chain;
let directory;
before(async () => {
  if (SDK_BLOCKED) return;
  chain = await startOvernightChain();
  directory = await startOvernightDirectory({ chain });
  h = await startHarness({ chain, directory, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
});
after(async () => {
  await h?.close();
});
afterEach(() => chain?.resetFaults());

async function post(origin, path, body) {
  const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}

// What portal.js builds from the server profile.
async function transportFrom(harness) {
  const profile = (await post(harness.origin, '/portal/api/embedded-wallet/profile')).body;
  return { profile: profile.writes, rpcUrl: profile.rpcUrl, network: profile.network };
}

async function embedded(decide = () => true, { DemosCtor } = {}) {
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: DemosCtor ?? sdk.Demos,
    IdentitiesCtor: sdk.Identities,
    validateMnemonic: sdk.validateMnemonic,
    transactionTransport: await transportFrom(h),
    approve: async (request) => {
      asked.push(structuredClone(request));
      return decide(request, session);
    },
  });
  const account = await session.create();
  return { session, account, address: account.address, asked };
}

// ---------------- held testnet profile ----------------

test('config: testnet-held is a separate explicit profile; it needs an https non-loopback chain and an explicit network, and keeps embedded writes off', () => {
  const held = { ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet-held' };
  assert.throws(() => loadConfig(held), ConfigError, 'no chain');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9', DACS_CHAIN_NETWORK: 'demos-testnet' }), ConfigError, 'loopback fixture chain');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example' }), ConfigError, 'implicit network label');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'Demos Testnet' }), ConfigError, 'malformed network label');
  assert.throws(() => loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet', DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: 'http://127.0.0.1:9' }), ConfigError, 'fixture-only setting');
  // Accepting control.
  const ok = loadConfig({ ...held, DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet' });
  assert.deepEqual({ ...ok.embeddedWallet }, { writes: 'off', githubApiOrigin: null }, 'embedded writes stay off');
  assert.deepEqual({ ...ok.embeddedWalletTestnet }, { profile: 'held', executable: false, network: 'demos-testnet', rpcOrigin: 'https://rpc.testnet.example' });
  // Default and the simulated profile do not carry the testnet profile.
  assert.deepEqual({ ...loadConfig(BASE_ENV).embeddedWalletTestnet }, { profile: 'off' });
  assert.deepEqual({ ...loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9' }).embeddedWalletTestnet }, { profile: 'off' });
  assert.throws(() => loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet' }), ConfigError, 'no implicit live value');
});

test('held testnet profile: the public profile says held, no relay is mounted, and nothing is sent upstream', async () => {
  const config = loadConfig({ ...BASE_ENV, DACS_EMBEDDED_WALLET_WRITES: 'testnet-held', DACS_CHAIN_RPC_URL: 'https://rpc.testnet.example', DACS_CHAIN_NETWORK: 'demos-testnet' });
  const outbound = [];
  const app = express();
  app.use(createWalletRpcRouter({ config, fetchImpl: async (...args) => { outbound.push(String(args[0])); throw new Error('no network in this test'); }, logger: null }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const profile = await post(origin, '/portal/api/embedded-wallet/profile');
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body, {
      writes: 'off',
      testnet: {
        profile: 'held', executable: false, network: 'demos-testnet',
        reason: 'held. The external security review is on hold. Live gates are not met; no testnet writes in this build.',
        gates: ['external-security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval'],
      },
    });
    // Not mounted: the default 404 (an HTML page), not a relay answer.
    const statusOf = async (path, body) => (await fetch(`${origin}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
    assert.equal(await statusOf('/portal/api/wallet-rpc'), 404);
    for (const body of [
      { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: `0x${'1'.repeat(64)}` } }] },
      { method: 'execute', params: [{ extra: 'broadcastTx', data: {} }] },
    ]) assert.equal(await statusOf('/portal/api/wallet-rpc', body), 404);
    assert.equal(await statusOf('/portal/api/wallet-rpc/github-user', { username: 'octo' }), 404);
    assert.deepEqual(outbound, [], 'no request left the process');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('held testnet transport in the real SDK session: every write answers held_for_review before any node call; message signing still works', { skip: SDK_BLOCKED }, async () => {
  const nodeTouches = [];
  class Recording extends sdk.Demos {
    async connect(url) { nodeTouches.push(`connect ${url}`); return super.connect(url); }
    async nodeCall(...args) { nodeTouches.push('nodeCall'); return super.nodeCall(...args); }
    async confirm(...args) { nodeTouches.push('confirm'); return super.confirm(...args); }
    async broadcast(...args) { nodeTouches.push('broadcast'); return super.broadcast(...args); }
  }
  const asked = [];
  const session = createSdkWalletSession({
    DemosCtor: Recording, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic,
    transactionTransport: { profile: 'testnet-held', network: 'demos-testnet', rpcUrl: 'https://rpc.testnet.example' },
    approve: async (request) => { asked.push(request.method); return true; },
  });
  const account = await session.create();
  assert.equal(account.network, 'demos-testnet');
  assert.equal(account.evidenceMode, 'testnet-held-no-writes');
  assert.deepEqual(session.getWriteProfile(), {
    profile: 'testnet-held', network: 'demos-testnet', evidenceMode: 'testnet-held-no-writes', methods: [], transactionKinds: [], held: true,
    gates: ['external-security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval'],
  });
  const storagePayload = { content: { type: 'storageProgram', from: account.address, to: `stor-${'0'.repeat(40)}`, amount: 0, nonce: 1, data: ['storageProgram', {}] } };
  for (const [method, params] of [['sendTransaction', [storagePayload]], ['addGithubIdentity', ['https://gist.github.com/a/1']], ['removeWeb2Identity', [{ context: 'github', username: 'a' }]], ['signTransaction', [{}]], ['pay', []]]) {
    const res = await session.request({ method, params });
    assert.equal(res.success, false, method);
    assert.equal(res.error.code, 'held_for_review', method);
    assert.match(res.error.message, /held\. The external security review is on hold\./);
  }
  assert.deepEqual(asked, [], 'no approval was even requested for a held write');
  const signed = await session.request({ method: 'sign', params: ['overnight-core held-profile sign check'] });
  assert.equal(signed.success, true, JSON.stringify(signed.error));
  assert.deepEqual(asked, ['sign']);
  session.lock();
  assert.equal((await session.request({ method: 'sendTransaction', params: [storagePayload] })).error.code, 'held_for_review');
  assert.deepEqual(nodeTouches, [], 'the held transport never reached a node');
});

test('default: an unconfigured session refuses the storage write (not_configured); the default profile stays exactly {writes:"off"}', { skip: SDK_BLOCKED }, async () => {
  const plain = await startHarness();
  try {
    assert.deepEqual((await post(plain.origin, '/portal/api/embedded-wallet/profile')).body, { writes: 'off' });
  } finally {
    await plain.close();
  }
  const session = createSdkWalletSession({ DemosCtor: sdk.Demos, IdentitiesCtor: sdk.Identities, validateMnemonic: sdk.validateMnemonic, approve: async () => true });
  const account = await session.create();
  assert.equal(session.getWriteProfile(), null);
  const res = await session.request({ method: 'sendTransaction', params: [{ content: { type: 'storageProgram', from: account.address } }] });
  assert.equal(res.error.code, 'not_configured');
  session.lock();
});

// ---------------- retained simulated wallet capabilities ----------------

test('simulated profile refuses Listing publication while retaining storage CREATE for purchases', { skip: SDK_BLOCKED }, async () => {
  const profile = (await post(h.origin, '/portal/api/embedded-wallet/profile')).body;
  assert.equal(profile.writes, 'simulated-loopback');
  assert.deepEqual(profile.capabilities, { payment: true, identity: false, publication: false });
  const wallet = await embedded();
  assert.deepEqual(wallet.session.getWriteProfile().transactionKinds, ['native-send', 'storage-program-create']);
  wallet.session.lock();
});

// Direct signed storage fixtures keep wallet validation coverage after API retirement.
async function storagePayload(wallet) {
  const timestamp = 1700000000000;
  const unsigned = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: timestamp, sessionSeed: 'TEST-storage-fixture' });
  const sign = async message => {
    const answer = await wallet.session.request({ method: 'sign', params: [message] });
    assert.equal(answer.success, true);
    return answer.data.signature;
  };
  const identityBundle = attachIdentityPresentation(unsigned, await sign(unsigned.message));
  const draft = buildListingDraft({ identityBundle, displayName: 'Fixture seller', publicEndpoint: 'https://seller.example/agent', listingId: 'wallet-storage-fixture', listingVersion: 1, title: 'Storage fixture', description: 'SIMULATED storage validation fixture.', category: 'services.test', tags: [], priceDem: '2', notBefore: timestamp - 1000, notAfter: timestamp + 86400000 });
  const signedListing = attachListingSignature(draft, await sign(listingSigningMessage(draft)));
  const logicalAddress = logicalListingAddress(signedListing), programName = communityProgramName(logicalAddress), nonce = 1;
  const storageAddress = deriveStorageAddress(wallet.address, programName, nonce, '');
  return buildStorageProgramCreatePayload({ from: wallet.address, storageAddress, programName, logicalAddress, signedListing, nonce, timestamp });
}
const executes = from => chain.calls.slice(from).filter(call => call.startsWith('execute:'));

test('storage CREATE on a pre-fork node (osDenomination not activated, DEM-number wire amounts): the same checks pass and exactly one write lands', { skip: SDK_BLOCKED }, async () => {
  const preChain = await startOvernightChain({ osDenominationActivated: false });
  const preDirectory = await startOvernightDirectory({ chain: preChain });
  const pre = await startHarness({ chain: preChain, directory: preDirectory, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const savedH = h;
  const savedChain = chain;
  try {
    h = pre;
    chain = preChain;
    const wallet = await embedded();
    const payload = await storagePayload(wallet);
    const res = await wallet.session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.ok(preChain.calls.includes('nodeCall:getNetworkInfo'), 'the SDK asked the node for its fork status');
    assert.deepEqual(preChain.broadcasts.map((b) => [b.applied, b.kind]), [[true, 'storage-create']]);
    const onChain = preChain.txContent(res.data.hash);
    assert.equal(onChain.amount, 0, 'pre-fork wire keeps DEM numbers');
    assert.deepEqual(onChain.gcr_edits.filter((e) => e.type === 'balance').map((e) => e.amount), [1, 1], 'storage fee and gas as DEM numbers');
    assert.ok(preChain.storageAt(payload.content.to));
    wallet.session.lock();
  } finally {
    h = savedH;
    chain = savedChain;
    await pre.close();
  }
});

test('storage CREATE payload boundaries: the valid payload reaches approval; each malformed or foreign variant is refused before approval and nothing is sent', { skip: SDK_BLOCKED }, async () => {
  const wallet = await embedded((request) => request.method !== 'sendTransaction');
  const payload = await storagePayload(wallet);
  const mark = chain.calls.length;
  // Accepting control first: the exact server payload reaches one approval (declined here).
  let asked = wallet.asked.length;
  const control = await wallet.session.request({ method: 'sendTransaction', params: [payload] });
  assert.equal(control.error.code, 'user_rejected');
  assert.equal(wallet.asked.length, asked + 1);
  asked = wallet.asked.length;

  const variant = (mutate) => {
    const tx = structuredClone(payload);
    mutate(tx, tx.content.data[1]);
    return tx;
  };
  const other = `0x${'2'.repeat(64)}`;
  const shiftedAddress = sdk.StorageProgram.deriveStorageAddress(wallet.address, payload.content.data[1].programName, payload.content.nonce + 1, '');
  const cases = [
    ['payload for another wallet', variant((tx) => { tx.content.from = other; }), 'wrong_wallet'],
    ['listing names another seller', variant((_tx, op) => { op.data.seller.identity.presentedBy = `did:demos:agent:${'2'.repeat(64)}`; }), 'wrong_wallet'],
    ['address derived for a different nonce', variant((tx, op) => { op.storageAddress = shiftedAddress; tx.content.to = shiftedAddress; }), 'invalid_params'],
    ['to differs from the storage address', variant((tx) => { tx.content.to = shiftedAddress; }), 'invalid_params'],
    ['program name not from the listing address', variant((_tx, op) => { op.programName = 'dacs1-b3RoZXI'; }), 'invalid_params'],
    ['unexpected payload field', variant((_tx, op) => { op.extra = true; }), 'invalid_params'],
    ['non-zero amount', variant((tx) => { tx.content.amount = 1; }), 'invalid_params'],
    ['nonce 0', variant((tx) => { tx.content.nonce = 0; }), 'invalid_params'],
    ['not a create', variant((_tx, op) => { op.operation = 'WRITE_STORAGE'; }), 'invalid_params'],
    ['owner-only ACL', variant((_tx, op) => { op.acl = { mode: 'owner' }; }), 'invalid_params'],
    ['binary encoding', variant((_tx, op) => { op.encoding = 'binary'; }), 'invalid_params'],
    ['empty params', null, 'invalid_params'],
  ];
  for (const [label, tx, code] of cases) {
    const res = await wallet.session.request({ method: 'sendTransaction', params: tx ? [tx] : [] });
    assert.equal(res.success, false, label);
    assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  }
  assert.equal(wallet.asked.length, asked, 'no malformed variant reached approval');
  assert.deepEqual(executes(mark), [], 'nothing was validated or broadcast');
  assert.equal(chain.storageAt(payload.content.to), null);
  wallet.session.lock();
});

test('storage CREATE: after approval, an SDK-signed transaction that differs from the approved content is payload_mismatch and is never confirmed or broadcast (controlled SDK-seam faults)', { skip: SDK_BLOCKED }, async () => {
  for (const [label, alter] of [
    ['storage create edit removed', (signed) => { signed.content.gcr_edits = signed.content.gcr_edits.filter((e) => e.type !== 'storageProgram'); }],
    ['listing changed after approval', (signed) => { signed.content.data[1].data.offering.title = 'changed after approval'; }],
    ['storage fee changed', (signed) => { const burn = signed.content.gcr_edits.find((e) => e.type === 'balance'); burn.amount = typeof burn.amount === 'string' ? '2000000000' : 2; }],
  ]) {
    class Faulty extends sdk.Demos {
      async sign(tx, options) {
        const signed = await super.sign(tx, options);
        if (tx?.content?.type === 'storageProgram') alter(signed);
        return signed;
      }
    }
    const wallet = await embedded(undefined, { DemosCtor: Faulty });
    const payload = await storagePayload(wallet);
    const mark = chain.calls.length;
    const res = await wallet.session.request({ method: 'sendTransaction', params: [payload] });
    assert.equal(res.error?.code, 'payload_mismatch', `${label}: ${JSON.stringify(res)}`);
    assert.deepEqual(executes(mark), [], `${label}: nothing confirmed or broadcast`);
    assert.equal(chain.storageAt(payload.content.to), null, label);
    wallet.session.lock();
  }
});
