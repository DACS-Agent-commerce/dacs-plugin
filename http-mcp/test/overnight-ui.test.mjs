// Retained simulated dashboard checks: fixture indexing, input validation,
// purchase targets, evidence export and failure reporting. V2 has no seller
// publication wizard. Browser execution is checked separately on the host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { startOfflineTester } from '../bin/dacs-chatgpt-offline-test.mjs';
import { deriveStorageAddress } from '../bin/offline-fixtures/chain.mjs';
import { registrationMessage } from '../bin/offline-fixtures/directory.mjs';
import { validateListingInput, listingIdFor, publicationStages, buildEvidenceExport, CALLBACK_PATH, SELLER_CALLBACK_PATH } from '../bin/offline-fixtures/tester-dashboard.mjs';
import {
  createEphemeralWallet, dashboardClient, completeDashboardSignIn, signTransaction, broadcastTransaction, publishWithSyntheticWallet, payWithSyntheticWallet,
} from './helpers/overnight-ui-actors.mjs';

let h;
let d;
before(async () => {
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  d = dashboardClient(h);
});
after(async () => {
  await h?.stop();
});

const unique = (label) => `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const storageCreate = (wallet, { nonce, programName = 'dacs1-test', data = { hello: 'fixture' }, storageAddress, encoding = 'json' }) => ({
  content: {
    type: 'storageProgram', from: wallet.address, to: storageAddress, amount: 0,
    data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', storageAddress, programName, encoding, data, metadata: {}, acl: { mode: 'public' }, salt: '', storageLocation: 'onchain' }],
    nonce, timestamp: Date.now(), transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
  },
});
const readStorage = async (locator) => {
  const res = await fetch(`${h.fixtures.chain}/storage-program/${locator}`);
  return { status: res.status, body: await res.json() };
};

async function signIn(role, wallet) {
  const out = await d.action(role === 'seller' ? 'seller-sign-in' : 'sign-in');
  assert.equal(out.ok, true, out.error);
  const s = role === 'seller' ? out.state.seller.signIn : out.state.signIn;
  assert.equal(s.status, 'redirected');
  assert.equal(new URL(s.authorizationUrl).searchParams.get('redirect_uri'), `${h.origin}${role === 'seller' ? SELLER_CALLBACK_PATH : CALLBACK_PATH}`);
  assert.equal(await completeDashboardSignIn(h, s.authorizationUrl, wallet, role === 'seller' ? SELLER_CALLBACK_PATH : CALLBACK_PATH), 303);
  const state = await d.state();
  const after = role === 'seller' ? state.seller.signIn : state.signIn;
  assert.equal(after.status, 'signed_in', after.error ?? '');
  assert.deepEqual(after.wallets, [wallet.address]);
  return state;
}

// ---------------- launcher runs the publication-capable simulated profile ----------------
async function embeddedProfile(origin) {
  const res = await fetch(`${origin}/portal/api/embedded-wallet/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  return res.json();
}
function assertSimulatedPublicationProfile(p, origin) {
  assert.equal(p.writes, 'simulated-loopback');
  assert.equal(p.evidenceMode, 'simulated-fixture');
  assert.match(p.label, /SIMULATED/);
  assert.match(p.label, /not Demos testnet/);
  assert.equal(p.rpcUrl, `${origin}/portal/api/wallet-rpc`);
  assert.equal(p.capabilities?.publication, false, JSON.stringify(p.capabilities));
  assert.equal(p.capabilities?.payment, true);
  assert.equal(p.capabilities?.identity, true);
  assert.notEqual(p.testnet?.profile, 'held');
}

test('launcher (programmatic and CLI) serves the simulated embedded-wallet profile with publication retired and SIMULATED labels', { timeout: 60_000 }, async () => {
  assertSimulatedPublicationProfile(await embeddedProfile(h.origin), h.origin);
  assert.equal(h.coreProfile.DACS_EMBEDDED_WALLET_WRITES, 'simulated-loopback');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/dacs-chatgpt-offline-test.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '' } });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  try {
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const deadline = Date.now() + 20_000;
    while (!out.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const info = JSON.parse(out.split('\n')[0]);
    assert.match(info.notice, /SIMULATED/);
    assert.equal(info.coreProfile.DACS_EMBEDDED_WALLET_WRITES, 'simulated-loopback');
    assertSimulatedPublicationProfile(await embeddedProfile(info.plugin), info.plugin);
    const page = await (await fetch(info.dashboard)).text();
    assert.match(page, /SIMULATED ONLY/);
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
});

// ---------------- fixture chain: storage-program CREATE ----------------
test('fixture chain: storage-program CREATE is stored exactly, owned by the sender, at the derived address', async () => {
  const w = createEphemeralWallet();
  const nonce = 1;
  const storageAddress = deriveStorageAddress(w.address, 'dacs1-test', nonce, '');
  const data = { listing: 'bytes', nested: { n: 1, s: 'é' } };
  const before = h.chainStats();
  const sent = await broadcastTransaction(h.fixtures.chain, signTransaction(w, storageCreate(w, { nonce, storageAddress, data })));
  assert.match(sent.hash ?? '', /^[0-9a-f]{64}$/, JSON.stringify(sent.confirmed?.response?.data?.message));
  const read = await readStorage(storageAddress);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { success: true, data, owner: w.address, programName: 'dacs1-test' });
  assert.equal(h.chainStats().storagePrograms, before.storagePrograms + 1);
  assert.equal(h.chainStats().broadcastAccepted, before.broadcastAccepted + 1);
});

test('fixture chain: ordinary malformed storage writes are refused and change nothing', async () => {
  const w = createEphemeralWallet();
  const good = deriveStorageAddress(w.address, 'dacs1-test', 1, '');
  const cases = [
    ['wrong derived address', storageCreate(w, { nonce: 1, storageAddress: deriveStorageAddress(w.address, 'dacs1-test', 2, '') }), /does not match the sender/],
    ['to differs from storageAddress', (() => { const t = storageCreate(w, { nonce: 1, storageAddress: good }); t.content.to = `stor-${'0'.repeat(40)}`; return t; })(), /differs from content.to/],
    ['non-json encoding', storageCreate(w, { nonce: 1, storageAddress: good, encoding: 'binary' }), /only json storage programs/],
    ['array payload', storageCreate(w, { nonce: 1, storageAddress: good, data: [1, 2] }), /only json storage programs/],
    ['wrong nonce', storageCreate(w, { nonce: 2, storageAddress: deriveStorageAddress(w.address, 'dacs1-test', 2, '') }), /nonce 2 rejected; expected 1/],
    ['oversized payload', storageCreate(w, { nonce: 1, storageAddress: good, data: { big: 'x'.repeat(70 * 1024) } }), /too large/],
    ['other operation', (() => { const t = storageCreate(w, { nonce: 1, storageAddress: good }); t.content.data[1].operation = 'WRITE_STORAGE'; return t; })(), /only storage-program CREATE/],
  ];
  const before = h.chainStats();
  for (const [label, tx, reason] of cases) {
    const sent = await broadcastTransaction(h.fixtures.chain, signTransaction(w, tx));
    assert.equal(sent.hash, null, label);
    assert.match(String(sent.confirmed?.response?.data?.message), reason, label);
  }
  assert.equal((await readStorage(good)).status, 404);
  const after = h.chainStats();
  assert.equal(after.storagePrograms, before.storagePrograms);
  assert.equal(after.broadcastAccepted, before.broadcastAccepted);
  assert.equal(h.chainStats().confirmRejected - before.confirmRejected, cases.length);
});

test('fixture chain: an existing storage program is never overwritten', async () => {
  const w = createEphemeralWallet();
  const first = deriveStorageAddress(w.address, 'dacs1-dup', 1, '');
  assert.ok((await broadcastTransaction(h.fixtures.chain, signTransaction(w, storageCreate(w, { nonce: 1, programName: 'dacs1-dup', storageAddress: first, data: { v: 1 } })))).hash);
  // A different sender cannot target that address (derivation binds the owner).
  const other = createEphemeralWallet();
  const stolen = await broadcastTransaction(h.fixtures.chain, signTransaction(other, storageCreate(other, { nonce: 1, programName: 'dacs1-dup', storageAddress: first, data: { v: 2 } })));
  assert.equal(stolen.hash, null);
  assert.deepEqual((await readStorage(first)).body.data, { v: 1 });
});

// ---------------- fixture directory: registration indexing ----------------
test('fixture directory: refuses unsigned, stale or unowned registrations with plain reasons', async () => {
  const w = createEphemeralWallet();
  const claim = w.claim;
  const anchor = deriveStorageAddress(w.address, 'dacs1-x', 1, '');
  const reg = async (body) => {
    const res = await fetch(`${h.fixtures.directory}/api/dacs/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const signedAt = Date.now();
  const message = registrationMessage({ primaryClaim: claim, displayName: 'X', listingAnchors: [anchor] }, signedAt);
  const ok = { primaryClaim: claim, displayName: 'X', listingAnchors: [anchor], ownerSignature: { message, signature: w.signHex(message).slice(2), signedAt } };
  assert.equal((await reg({ ...ok, primaryClaim: 'did:demos:agent:XYZ' })).status, 400);
  assert.equal((await reg({ ...ok, listingAnchors: [] })).status, 400);
  assert.equal((await reg({ ...ok, ownerSignature: { ...ok.ownerSignature, signedAt: signedAt - 11 * 60 * 1000 } })).status, 400);
  assert.equal((await reg({ ...ok, ownerSignature: { ...ok.ownerSignature, signature: createEphemeralWallet().signHex(message).slice(2) } })).status, 401);
  const missing = await reg(ok);
  assert.equal(missing.status, 422, 'nothing stored at the anchor: nothing indexed');
  assert.match(missing.body.error, /not found on the fixture chain/);
  // Stored data that is not a listing by this claim is not indexed either.
  assert.ok((await broadcastTransaction(h.fixtures.chain, signTransaction(w, storageCreate(w, { nonce: 1, programName: 'dacs1-x', storageAddress: anchor, data: { not: 'a listing' } })))).hash);
  const junk = await reg(ok);
  assert.equal(junk.status, 422);
  assert.match(junk.body.error, /not presented and signed by the claim/);
});

test('dashboard actions refuse empty or out-of-order input with plain messages', async () => {
  const st = await d.state();
  assert.equal(st.seller.signIn.status, 'signed_out');
  assert.match((await d.action('seller-register', { title: 'Valid title', priceDem: '1' })).error, /unknown action/i);
  assert.match((await d.action('seller-refresh')).error, /unknown action/i);
  assert.match((await d.action('search-listings', { query: '   ' })).error, /Type part of a service title/);
  assert.match((await d.action('search-listings', { query: 'a'.repeat(201) })).error, /at most 200 characters/);
  assert.match((await d.action('verify-listing', { listingId: 'nope', version: 1, seller: `did:demos:agent:${'1'.repeat(64)}` })).error, /choose a listing from the current results/);
  const after = await d.state();
  assert.ok(after.activity.some((a) => a.action === 'search-listings' && a.ok === false), 'failed actions are recorded in the public activity list');
  assert.doesNotMatch(JSON.stringify(after), /access_token|refresh_token|code_verifier|privateKey|mnemonic/i);
});

test('evidence export never carries portal links, OAuth values or idempotency keys from state', () => {
  const state = {
    signIn: { status: 'signed_in', wallets: [`0x${'a'.repeat(64)}`], authorizationUrl: 'http://127.0.0.1:1/oauth?code=SECRETCODE' },
    listing: { discovery: null, verification: null, search: null },
    purchase: { operationId: 'pur_x', status: 'awaiting_approval', approvalUrl: 'http://127.0.0.1:1/portal/p#t=HANDOFF', idempotencyKey: 'tester-buy-KEY', terms: { listingId: 'l', amount: '1 DEM', amountOs: '1000000000', network: 'offline-fixture', payee: 'p' }, receipt: null },
    identity: { add: { status: 'prepared', portalUrl: 'http://x/#t=ID', idempotencyKey: 'tester-add-K' }, remove: null, observed: null },
    checklist: { lock: true },
    seller: { signIn: { status: 'redirected', wallets: [], authorizationUrl: 'http://127.0.0.1:1/auth?state=STATEVALUE' }, listing: { idempotencyKey: 'tester-sell-K', operationId: 'pub_y', portalUrl: 'http://x/#t=PUB', title: 'T', priceDem: '1', publicationStatus: 'awaiting_identity_signature' } },
    activity: [{ at: 'now', action: 'sign-in', ok: true }],
  };
  const text = JSON.stringify(buildEvidenceExport(state, { runId: 'r' }));
  assert.doesNotMatch(text, /SECRETCODE|HANDOFF|STATEVALUE|#t=|tester-(buy|sell|add)-K/);
  assert.match(text, /awaiting_approval/);
  assert.match(text, /"unfinished":\[/);
});
