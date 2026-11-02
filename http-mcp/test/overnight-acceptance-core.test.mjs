// Overnight ORDINARY functional acceptance of the embedded-wallet
// profiles, through the public portal HTTP API and config loader. SIMULATED
// fixtures only; source-aware; NOT a security review, NOT live, NOT v0.1
// acceptance.
//
// Expected values come from the published interface (profile endpoint
// shapes, held-profile config rules) and docs/OVERNIGHT-CORE.md, not from
// the implementation's tests. The seller "wallet" is the SIMULATED test key of the source
// harness. The held-profile checks are config/endpoint level only: the https
// RPC host is a reserved .invalid name and no tool that would read it is
// called.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers/harness.mjs';
import { loadConfig } from '../src/config.mjs';

const harnesses = [];
async function harness(env) {
  const h = await startHarness({ env });
  harnesses.push(h);
  return h;
}
after(async () => {
  for (const h of harnesses) await h.close();
});

const post = async (h, path, body = {}) => {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { http: res.status, json };
};

test('OA-C1 profiles: default is exactly {writes:"off"}; simulated reports capabilities; held is accepted only as documented and exposes no relay', async () => {
  const plain = await harness({});
  assert.deepEqual((await post(plain, '/portal/api/embedded-wallet/profile')).json, { writes: 'off' });

  const sim = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_IDENTITY_WRITES: 'simulated-fixture-only' });
  const p = (await post(sim, '/portal/api/embedded-wallet/profile')).json;
  assert.equal(p.writes, 'simulated-loopback');
  assert.deepEqual(p.capabilities, { payment: true, identity: true, publication: false });
  const simNoId = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' });
  assert.equal((await post(simNoId, '/portal/api/embedded-wallet/profile')).json.capabilities.identity, false, 'identity capability follows DACS_IDENTITY_WRITES');

  // Config acceptance/refusal (no server, no network).
  const base = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:1', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_DATA_DIR: '/nonexistent-not-opened', DACS_EMBEDDED_WALLET_WRITES: 'testnet-held' };
  const held = { ...base, DACS_CHAIN_RPC_URL: 'https://node.invalid', DACS_CHAIN_NETWORK: 'demos-testnet' };
  const cfg = loadConfig(held);
  assert.equal(cfg.embeddedWallet.writes, 'off', 'held keeps the write profile off');
  assert.deepEqual({ ...cfg.embeddedWalletTestnet }, { profile: 'held', executable: false, network: 'demos-testnet', rpcOrigin: 'https://node.invalid' });
  assert.deepEqual({ ...loadConfig({ ...base, DACS_EMBEDDED_WALLET_WRITES: 'off' }).embeddedWalletTestnet }, { profile: 'off' }, 'default is off');
  const refusals = [
    ['http RPC', { ...held, DACS_CHAIN_RPC_URL: 'http://node.invalid' }, /https, non-loopback DACS_CHAIN_RPC_URL|must use https/],
    ['loopback RPC', { ...held, DACS_CHAIN_RPC_URL: 'https://127.0.0.1:9' }, /non-loopback/],
    ['no RPC', { ...held, DACS_CHAIN_RPC_URL: '' }, /DACS_CHAIN_RPC_URL/],
    ['no network label', { ...held, DACS_CHAIN_NETWORK: '' }, /explicit DACS_CHAIN_NETWORK/],
    ['bad network label', { ...held, DACS_CHAIN_NETWORK: 'Demos Testnet!' }, /DACS_CHAIN_NETWORK/],
    ['fixture GitHub origin', { ...held, DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: 'http://127.0.0.1:9' }, /only to the simulated-loopback profile/],
    ['unknown value', { ...held, DACS_EMBEDDED_WALLET_WRITES: 'testnet' }, /must be off, simulated-loopback or testnet-held/],
  ];
  for (const [label, env, message] of refusals) assert.throws(() => loadConfig(env), message, label);

  // Held app: endpoint shape and no relay. Nothing reads the .invalid RPC.
  const h = await harness({ DACS_EMBEDDED_WALLET_WRITES: 'testnet-held', DACS_CHAIN_RPC_URL: 'https://node.invalid', DACS_CHAIN_NETWORK: 'demos-testnet' });
  const hp = (await post(h, '/portal/api/embedded-wallet/profile')).json;
  assert.equal(hp.writes, 'off');
  assert.equal(hp.rpcUrl, undefined, 'no relay URL is offered');
  assert.equal(hp.testnet.profile, 'held');
  assert.equal(hp.testnet.executable, false);
  assert.equal(hp.testnet.network, 'demos-testnet');
  assert.equal(typeof hp.testnet.reason, 'string');
  assert.equal(hp.testnet.gates.length, 4);
  const relay = await post(h, '/portal/api/wallet-rpc', { method: 'execute', params: [{ extra: 'confirmTx', data: {} }] });
  assert.equal(relay.http, 404, 'the wallet relay is not mounted in the held profile');
});
