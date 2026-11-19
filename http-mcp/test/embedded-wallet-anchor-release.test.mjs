// Embedded wallet, devnet Agreement storage anchor: the source lease is released
// after the anchor was broadcast. A release that fails or never answers must not
// replace the anchor's own result. Offline: the binding endpoint is an in-process
// fake fetch; the node is the simulated anchor fixture behind a loopback relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createSdkWalletSession, createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startAnchorFixture, anchorRequest, memoryAnchorJournal, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';

globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location = new URL('http://127.0.0.1/');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const NETWORK = 'devnet-test';
const BINDING_DEADLINE_MS = 70_000;
const JOB_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const digest = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(typeof v === 'string' ? v.normalize('NFC') : v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const hex = (b) => Buffer.from(b).toString('hex');

const transportBinding = {
  source: 'devnet-agreement-transport/v1', bindingVersion: 'dacs-demos-network-binding/v1', bindingId: 'b'.repeat(64), network: NETWORK,
  chainIdentity: FIXTURE_IDENTITY, pinVersion: 'TEST-pin', endpoint: 'https://node.invalid/', transportAuthority: 'TEST-authority',
};

async function relay(t, chainUrl) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = (status, text) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text); };
    if (req.url !== '/portal/api/devnet-native-wallet-rpc') return reply(404, '{"error":"not found"}');
    const headers = Object.fromEntries(['content-type', 'identity', 'signature', 'timestamp'].filter((k) => req.headers[k]).map((k) => [k, req.headers[k]]));
    const upstream = await fetch(chainUrl, { method: req.method, headers, ...(req.method === 'GET' ? {} : { body }) });
    return reply(upstream.status, await upstream.text());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const previous = globalThis.location;
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.location = new URL(`${origin}/`);
  t.after(() => { globalThis.location = previous; });
  return origin;
}

// A signed payee-bound Agreement owned by the wallet, as an anchor request.
async function agreementRequest(wallet, address) {
  const seller = generateKeyPairSync('ed25519');
  const sellerKey = hex(Buffer.from(seller.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const data = {
    payeeBoundAgreementVersion: '1', derivedFromPattern: 'fixed-price', jobId: JOB_ID,
    parties: [{ role: 'buyer', primaryClaim: `did:demos:agent:${address.slice(2)}` }, { role: 'seller', primaryClaim: `did:demos:agent:${sellerKey}` }],
    terms: { price: { currency: 'DEM', amount: '2.5' }, rail: { railId: 'demos-native:DEM', railVersion: 1 },
      payoutBindings: [{ payeeAddress: `0x${sellerKey}`, phaseIndex: 2, railId: 'demos-native:DEM' }] },
  };
  const message = `dacs-payee-bound-agreement:v1:${digest(canonical(data))}`;
  const buyerSigned = await wallet.request({ method: 'sign', params: [message] });
  assert.equal(buyerSigned.success, true, JSON.stringify(buyerSigned));
  const buyerBytes = Buffer.from(String(buyerSigned.data.signature).replace(/^0x/, ''), 'hex');
  data.signatures = [
    { party: `did:demos:agent:${address.slice(2)}`, algorithm: 'ed25519', value: buyerBytes.toString('base64url') },
    { party: `did:demos:agent:${sellerKey}`, algorithm: 'ed25519', value: nodeSign(null, Buffer.from(message), seller.privateKey).toString('base64url') },
  ];
  const request = anchorRequest(address, NETWORK, { artifact: data, artifactKind: 'Agreement', logicalAddress: `dacs3:agreement:${JOB_ID}` });
  request.kind = 'devnet-agreement-storage-create';
  request.profile = 'devnet-agreement';
  request.transaction.content.chainIdentity = FIXTURE_IDENTITY;
  request.transaction.content.data[1].metadata.networkBinding = transportBinding;
  return request;
}

// The release phase is answered by `onRelease`; every other phase is granted.
async function anchorAfterBroadcast(t, onRelease, { mockTimersAfterBroadcast = false } = {}) {
  const chain = await startAnchorFixture({ domain: { active: false, chainId: 7 } });
  t.after(() => chain.close());
  const origin = await relay(t, chain.url);
  const phases = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== `${origin}/portal/api/devnet-native-wallet-binding`) return originalFetch(url, init);
    const { phase } = JSON.parse(init.body);
    phases.push(phase);
    if (phase === 'broadcast' && mockTimersAfterBroadcast) t.mock.timers.enable({ apis: ['setTimeout'] });
    if (phase === 'release') return onRelease(init);
    return new Response(JSON.stringify(phase === 'signature' ? { leaseId: 'lease-1', binding: transportBinding } : phase === 'bind' ? { binding: transportBinding } : {}),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const transport = createDevnetAgreementWalletTransport({ profile: 'devnet-agreement', network: NETWORK, rpcUrl: `${origin}/portal/api/devnet-native-wallet-rpc`,
    bindingUrl: `${origin}/portal/api/devnet-native-wallet-binding`, transportBinding });
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal: memoryAnchorJournal(), transactionTransport: transport, approve: async () => true });
  const { address } = await wallet.create();
  t.after(() => wallet.lock());
  const request = await agreementRequest(wallet, address);
  const result = await wallet.request({ method: 'sendTransaction', params: [request] });
  return { chain, phases, result };
}

function assertAnchorResultKept({ chain, phases, result }) {
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.status, 'broadcast_accepted');
  assert.equal(chain.record.accepted.length, 1, 'the anchor was broadcast once');
  assert.equal(result.data.hash, chain.record.accepted[0].hash, 'the caller keeps the transaction hash');
  assert.equal(phases.at(-1), 'release', 'the lease release was attempted');
}

test('an anchor whose lease release is refused after the broadcast keeps its own result', async (t) => {
  const out = await anchorAfterBroadcast(t, async () => { throw new TypeError('release refused'); });
  assertAnchorResultKept(out);
});

test('an anchor whose lease release hangs past the deadline after the broadcast keeps its own result', async (t) => {
  const out = await anchorAfterBroadcast(t, (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    t.mock.timers.tick(BINDING_DEADLINE_MS);
  }), { mockTimersAfterBroadcast: true });
  assertAnchorResultKept(out);
});
