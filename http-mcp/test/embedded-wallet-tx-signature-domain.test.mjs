// The embedded wallet checks a signed transaction in the form the configured node
// uses: the bare hash while the node's getNetworkInfo says its signatureDomain
// fork is inactive, "demos-tx:v1:<chainId>:<hash>" once it says active. The check
// reads the one network answer the SDK signed with. An answer that does not say
// which, or gives no safe chain id when active, refuses before anything is sent.
// Real bundled SDK; SIMULATED loopback nodes that verify independently of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import * as providerModule from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startSdkChainFixture } from './helpers/embedded-wallet-transaction-chain.mjs';
import { startAnchorFixture, anchorRequest, memoryAnchorJournal, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';

const { createSdkWalletSession, createDevnetNativeWalletTransport } = providerModule;
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

// The SDK as the wallet normally uses it, and three SDKs that sign what the
// node's answer does not call for (so the check has something to refuse).
const SDKS = {
  honest: Demos,
  // signs the bare hash whatever the node says
  bareHash: class extends Demos { async _isSignatureDomainActiveCached() { return false; } },
  // signs for another chain than the node's
  otherChain: class extends Demos { async _chainIdCached() { return 8; } },
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const PAYEE = `0x${'71'.repeat(32)}`;
const verifiesOver = (address, text, signature) => verify(null, Buffer.from(text), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(address.slice(2), 'hex').toString('base64url') }, format: 'jwk' }), Buffer.from(signature.replace(/^0x/, ''), 'hex'));

// One loopback origin that forwards the SDK's RPC path, verbatim, to the simulated
// node, and answers the source's binding path through `binding` when one is given.
async function startRelay(t, chainUrl, { rpcPath, binding = null }) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    if (req.url === rpcPath) {
      const headers = Object.fromEntries(['content-type', 'identity', 'signature', 'timestamp'].filter((k) => req.headers[k]).map((k) => [k, req.headers[k]]));
      const upstream = await fetch(chainUrl, { method: req.method, headers, ...(req.method === 'GET' ? {} : { body }) });
      return reply(upstream.status, await upstream.text());
    }
    if (binding && req.url === binding.path) return reply(...binding.handle(req, body));
    return reply(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.location = new URL(`${origin}/`);
  return origin;
}

// ---- the storage CREATE ----------------------------------------------------
async function createSession(t, { DemosCtor = Demos, domain } = {}) {
  const chain = await startAnchorFixture({ domain });
  t.after(() => chain.close());
  const network = 'demos-testnet';
  const origin = await startRelay(t, chain.url, { rpcPath: '/portal/api/wallet-rpc' });
  const approvals = [];
  const session = createSdkWalletSession({ DemosCtor, IdentitiesCtor: Identities, validateMnemonic, anchorJournal: memoryAnchorJournal(),
    transactionTransport: { profile: 'simulated-loopback', network, rpcUrl: `${origin}/portal/api/wallet-rpc` }, approve: async (request) => { approvals.push(request); return true; } });
  const { address } = await session.create();
  t.after(() => session.lock());
  return { chain, approvals, session, address, request: () => anchorRequest(address, network) };
}
const sendCreate = (w) => w.session.request({ method: 'sendTransaction', params: [w.request()] });
function refusedBeforeAnyEffect(w, out, code = 'payload_mismatch') {
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.error.code, code, out.error.message);
  assert.deepEqual(w.chain.record.confirms, [], 'nothing was submitted for confirmation');
  assert.deepEqual(w.chain.record.broadcastAttempts, [], 'nothing was broadcast');
}

test('CREATE, fork active: a signature over demos-tx:v1:<chainId>:<hash> verifies and is sent once', async (t) => {
  const w = await createSession(t, { domain: { active: true, chainId: 7 } });
  const out = await sendCreate(w);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(w.chain.record.broadcastAttempts, [out.data.hash]);
  const [accepted] = w.chain.record.accepted;
  assert.equal(accepted.hash, out.data.hash);
  assert.equal(verifiesOver(w.address, `demos-tx:v1:7:${accepted.hash}`, accepted.signature.data), true);
  assert.equal(verifiesOver(w.address, accepted.hash, accepted.signature.data), false);
});

test('CREATE, fork active on chain 0: zero is a safe nonnegative chain id', async (t) => {
  const w = await createSession(t, { domain: { active: true, chainId: 0 } });
  const out = await sendCreate(w);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(verifiesOver(w.address, `demos-tx:v1:0:${out.data.hash}`, w.chain.record.accepted[0].signature.data), true);
});

test('CREATE, fork active: a signature over the bare hash is refused before confirmation and broadcast', async (t) => {
  const w = await createSession(t, { DemosCtor: SDKS.bareHash, domain: { active: true, chainId: 7 } });
  refusedBeforeAnyEffect(w, await sendCreate(w));
});

test('CREATE, fork active: a signature for another chain id is refused before confirmation and broadcast', async (t) => {
  const w = await createSession(t, { DemosCtor: SDKS.otherChain, domain: { active: true, chainId: 7 } });
  refusedBeforeAnyEffect(w, await sendCreate(w));
});

for (const [label, domain] of [
  ['the signatureDomain member is not an object', { active: false, chainId: 7, answer: 'inactive' }],
  ['the fork status is not a boolean', { active: false, chainId: 7, answer: { activated: 'false' } }],
  ['the fork status is absent', { active: false, chainId: 7, answer: {} }],
  ['active with no chain id', { active: true, chainId: undefined }],
  ['active with a negative chain id', { active: true, chainId: -1 }],
  ['active with a fractional chain id', { active: true, chainId: 1.5 }],
  ['active with a chain id past the safe integers', { active: true, chainId: 2 ** 53 }],
  ['active with a chain id that is a string', { active: true, chainId: '7' }],
]) {
  test(`CREATE: an unreadable network answer refuses with zero broadcasts (${label})`, async (t) => {
    const w = await createSession(t, { domain });
    refusedBeforeAnyEffect(w, await sendCreate(w));
  });
}

test('CREATE, fork inactive: the bare-hash control still verifies and is sent once', async (t) => {
  const w = await createSession(t, { domain: { active: false, chainId: 7 } });
  const out = await sendCreate(w);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(w.chain.record.broadcastAttempts, [out.data.hash]);
  assert.equal(verifiesOver(w.address, out.data.hash, w.chain.record.accepted[0].signature.data), true);
});

test('CREATE: the check uses the network answer the SDK signed with, not a later read of the node', async (t) => {
  // The node says "inactive" while the SDK signs; right after, its answer (and the SDK's
  // cached copy) says "active". The signature is over the bare hash, as the answer the
  // SDK used called for, so it verifies and is sent once (the node itself still accepts
  // the bare hash). A check that read the node again would see "active" and refuse.
  const domain = { active: false, chainId: 7 };
  const FlipsAfterSign = class extends Demos {
    async sign(tx, options) {
      const signed = await super.sign(tx, options);
      domain.answer = { activated: true, activationHeight: 0 };
      this._cachedNetworkInfoAt = 0;
      return signed;
    }
  };
  const w = await createSession(t, { DemosCtor: FlipsAfterSign, domain });
  const out = await sendCreate(w);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(w.chain.record.broadcastAttempts, [out.data.hash]);
  assert.equal(verifiesOver(w.address, out.data.hash, w.chain.record.accepted[0].signature.data), true);
});

test('CREATE, fork inactive: a signature over the domain form is refused (no second form is tried)', async (t) => {
  const SignsDomain = class extends Demos {
    async _isSignatureDomainActiveCached() { return true; }
    async _chainIdCached() { return 7; }
  };
  const w = await createSession(t, { DemosCtor: SignsDomain, domain: { active: false, chainId: 7 } });
  refusedBeforeAnyEffect(w, await sendCreate(w));
});

// ---- the native send (explicit source capability) -----------------------------
// One origin serves the SDK's RPC path (forwarded to the simulated node) and the
// source's binding path (which also checks the wallet's RPC authentication).
async function nativeSession(t, { DemosCtor = Demos, domain } = {}) {
  const chain = await startSdkChainFixture({ domain });
  t.after(() => chain.close());
  const phases = [], rpcAuth = [];
  const binding = { source: 'TEST-source', bindingVersion: 'dacs-demos-network-binding/v1', bindingId: 'b'.repeat(64), network: 'devnet-test', chainIdentity: FIXTURE_IDENTITY,
    pinVersion: 'TEST-pin', endpoint: 'https://node.invalid/', transportAuthority: 'TEST-authority', connectionId: 'c'.repeat(64) };
  const origin = await startRelay(t, chain.url, { rpcPath: '/portal/api/devnet-native-wallet-rpc', binding: { path: '/portal/api/devnet-native-wallet-binding', handle(req, body) {
    const call = JSON.parse(body);
    phases.push(call.phase);
    if (['bind', 'signature'].includes(call.phase)) {
      const m = /^ed25519:(0x[0-9a-f]{64})$/.exec(req.headers.identity ?? '');
      rpcAuth.push(Boolean(m && m[1] === call.address && verifiesOver(m[1], sha256(`${req.headers.identity}:${req.headers.timestamp}`), req.headers.signature)));
    }
    return [200, call.phase === 'signature' ? { leaseId: 'lease-1', binding } : call.phase === 'release' ? {} : { binding }];
  } } });
  const transport = createDevnetNativeWalletTransport({ profile: 'devnet-native', network: 'devnet-test', rpcUrl: `${origin}/portal/api/devnet-native-wallet-rpc`, bindingUrl: `${origin}/portal/api/devnet-native-wallet-binding` });
  const approvals = [];
  const session = createSdkWalletSession({ DemosCtor, IdentitiesCtor: Identities, validateMnemonic, transactionTransport: transport, approve: async (request) => { approvals.push(request); return true; } });
  const { address } = await session.create();
  t.after(() => session.lock());
  const send = () => session.request({ method: 'sendTransaction', params: [{ content: { type: 'native', from: address, to: PAYEE, amount: '2500000000', nonce: chain.nonceOf(address) + 1, data: ['native', { nativeOperation: 'send', args: [PAYEE, '2500000000'] }] },
    signature: null, hash: '', status: '', blockNumber: null }] });
  return { chain, session, address, phases, rpcAuth, approvals, send };
}
function nativeRefused(w, out) {
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.error.code, 'payload_mismatch', out.error.message);
  assert.deepEqual(w.chain.broadcasts, [], 'nothing was broadcast');
  assert.equal(w.chain.calls.includes('execute:confirmTx'), false, 'nothing was submitted for confirmation');
  assert.equal(w.phases.at(-1), 'release', 'the source lease is released');
}

test('native send, fork active: a signature over demos-tx:v1:<chainId>:<hash> verifies and is sent once', async (t) => {
  const w = await nativeSession(t, { domain: { active: true, chainId: 7 } });
  const out = await w.send();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(w.chain.broadcasts.length, 1);
  assert.equal(w.chain.broadcasts[0].hash, out.data.hash);
  assert.equal(w.chain.broadcasts[0].applied, true, 'the node itself verified the domain form');
  assert.deepEqual(w.rpcAuth, [true, true], 'RPC authentication still signs its digest under SDK 4.0.20');
  assert.equal(w.approvals.length, 1);
});

test('native send, fork active: a signature over the bare hash is refused before broadcast', async (t) => {
  const w = await nativeSession(t, { DemosCtor: SDKS.bareHash, domain: { active: true, chainId: 7 } });
  nativeRefused(w, await w.send());
});

test('native send, fork active: a signature for another chain id is refused before broadcast', async (t) => {
  const w = await nativeSession(t, { DemosCtor: SDKS.otherChain, domain: { active: true, chainId: 7 } });
  nativeRefused(w, await w.send());
});

for (const [label, domain] of [
  ['the fork status is not a boolean', { active: false, chainId: 7, answer: { activated: 1 } }],
  ['active with no chain id', { active: true, chainId: undefined }],
  ['active with a negative chain id', { active: true, chainId: -3 }],
]) {
  test(`native send: an unreadable network answer refuses with zero broadcasts (${label})`, async (t) => {
    const w = await nativeSession(t, { domain });
    nativeRefused(w, await w.send());
  });
}

test('native send, fork inactive: the bare-hash control still verifies and is sent once', async (t) => {
  const w = await nativeSession(t, { domain: { active: false, chainId: 7 } });
  const out = await w.send();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(w.chain.broadcasts.length, 1);
  assert.equal(w.chain.broadcasts[0].applied, true);
  assert.deepEqual(w.rpcAuth, [true, true]);
});

// ---- messages are unchanged -------------------------------------------------
test('ordinary messages still sign and verify under SDK 4.0.20, and a page request for the RPC-auth digest is still refused', async (t) => {
  const w = await nativeSession(t, { domain: { active: true, chainId: 7 } });
  const message = `dacs-payee-bound-agreement:v1:${sha256('scope')}`;
  const out = await w.session.request({ method: 'sign', params: [message] });
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(verifiesOver(w.address, message, out.data.signature), true);
  const digest = sha256(`ed25519:${w.address}:${Date.now()}`);
  const refused = await w.session.request({ method: 'sign', params: [digest] });
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'transaction_preimage_refused');
  const domainForm = await w.session.request({ method: 'sign', params: [`demos-tx:v1:7:${digest}`] });
  assert.equal(domainForm.error.code, 'transaction_preimage_refused');
  assert.equal(w.approvals.length, 1, 'only the ordinary message reached consent');
});

import { transactionDomainCases } from './helpers/transaction-domain-cases.mjs';
transactionDomainCases('browser provider', async (t) => {
  const domain = { active: false, chainId: 1 };
  let form = 'bare';
  class SelectedForm extends Demos {
    async getNetworkInfo(...args) { this._cachedNetworkInfo = null; return super.getNetworkInfo(...args); }
    async _isSignatureDomainActiveCached() { await this.getNetworkInfo(); return form === 'domain'; }
    async _chainIdCached() { return (await this.getNetworkInfo()).chainId; }
  }
  const w = await nativeSession(t, { DemosCtor: SelectedForm, domain });
  return async (answer, signedForm) => {
    form = signedForm;
    domain.active = signedForm === 'domain';
    domain.chainId = answer.chainId;
    domain.answer = answer.forks.signatureDomain;
    const before = w.chain.broadcasts.length;
    const result = await w.send();
    if (result.success) return 'valid';
    assert.equal(result.error.code, 'payload_mismatch', JSON.stringify(result));
    assert.equal(w.chain.broadcasts.length, before, 'refusal sends nothing');
    return 'invalid';
  };
});

for (const [label, DemosCtor, success] of [
  ['bare hash verifies', Demos, true],
  ['domain form refuses', class extends Demos {
    async _isSignatureDomainActiveCached() { await this.getNetworkInfo(); return true; }
  }, false],
]) {
  test(`CREATE: missing signatureDomain member, ${label}`, async (t) => {
    const w = await createSession(t, { DemosCtor, domain: { active: false, chainId: 7, answer: undefined } });
    const result = await sendCreate(w);
    if (success) assert.equal(result.success, true, JSON.stringify(result));
    else refusedBeforeAnyEffect(w, result);
  });
}
