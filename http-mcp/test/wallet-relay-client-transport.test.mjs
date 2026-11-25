// The native relay runs only over the client's registered transport and imports only public client entries;
// the client's refusals keep their 409; the simulated-loopback relay keeps its own rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rpcAuthRefusal, transferRefusal } from '@kynesyslabs/dacs-client';
import { createHeldTransportFacade } from '@kynesyslabs/dacs-client/node-wallet';
import { createWalletRpcRouter, WALLET_RPC_PATH } from '../src/portal/wallet-rpc.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { RELAY_PHASES, createRelayAccess } from '../src/wallet/relay-access.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { BINDING_PATH, PUBLIC_ORIGIN, RPC_PATH, nodeRead, openHeldTransport, readback, release, seedPurchase, startRelay, testClock } from './helpers/relay-world.mjs';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const PUBLIC_CLIENT_ENTRIES = ['@kynesyslabs/dacs-client', '@kynesyslabs/dacs-client/node-wallet'];
const config = { publicOrigin: PUBLIC_ORIGIN };

let held;
before(async () => { held = await openHeldTransport(); });
after(async () => { await held.close(); });

function importsOf(file) {
  return [...readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}

test('the relay is built on the client\'s public native transport and imports nothing from a not-carried path', () => {
  const db = openDatabase(':memory:');
  try {
    const relayAccess = createRelayAccess({ db });
    const lookalike = { rpc: async () => ({}), walletBinding: async () => ({}), binding: async () => ({}), profile: () => ({}), chainReader: () => ({}) };
    for (const nativeTransport of [lookalike, Object.freeze({ ...held.transport })]) {
      assert.throws(() => createWalletRpcRouter({ config, nativeTransport, relayAccess }), TypeError);
    }
    assert.throws(() => createWalletRpcRouter({ config, nativeTransport: held.transport }), TypeError, 'relay access is required');
    assert.doesNotThrow(() => createWalletRpcRouter({ config, nativeTransport: held.transport, relayAccess }));
  } finally {
    db.close();
  }
  for (const file of ['portal/wallet-rpc.mjs', 'wallet/relay-access.mjs']) {
    for (const specifier of importsOf(resolve(SOURCE, file))) {
      if (specifier.startsWith('.')) {
        const target = resolve(SOURCE, dirname(file), specifier);
        assert.ok(existsSync(target), `${file} imports ${specifier}, which is not in this repository`);
        assert.doesNotMatch(specifier, /devnet-demo|\/dacs\/|devnet-native-transport/);
      } else if (specifier.startsWith('@kynesyslabs/')) {
        assert.ok(PUBLIC_CLIENT_ENTRIES.includes(specifier), `${file} imports ${specifier}`);
      }
    }
  }
  assert.match(readFileSync(resolve(SOURCE, 'portal/wallet-rpc.mjs'), 'utf8'), /import \{[^}]*\brpcAuthRefusal\b[^}]*\btransferRefusal\b[^}]*\} from '@kynesyslabs\/dacs-client';/);
});

test('stale-clock, replayed and cancelled-transfer refusals from the client map to 409 as before', async (t) => {
  // The relay answers a client refusal with the client's own mapping, for each code it names.
  for (const code of ['wallet_auth_stale', 'wallet_auth_replayed', 'payment_cancelled']) {
    const error = Object.assign(new Error(code), { code });
    const [status, body] = rpcAuthRefusal(error) ?? transferRefusal(error);
    assert.equal(status, 409);
    assert.equal(body.error, code);
  }
  // Through the relay, the client's hold refusal is a 409 too, with no cause it does not carry.
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  const relay = await startRelay({ db, transport: held.transport, clock: testClock() });
  t.after(async () => { await relay.close(); db.close(); });
  const capability = relay.relayAccess.mint({ operationId: 'op-relay', phases: RELAY_PHASES }).capability;
  for (const [path, body] of [[RPC_PATH, nodeRead], [BINDING_PATH, release()]]) {
    const answer = await relay.post(path, body, capability);
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'profile_not_admitted');
    assert.equal(Object.hasOwn(answer.body, 'cause'), false);
  }
});

test('the simulated-loopback relay still refuses writes until the chain answers with the simulation header', async (t) => {
  const execute = { method: 'execute', params: [{ extra: 'confirmTx', data: { content: {} } }] };
  const nonceRead = { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: `0x${'a1'.repeat(32)}` } }] };
  async function relayTo(rpcUrl) {
    const app = express().use(createWalletRpcRouter({ config: { publicOrigin: PUBLIC_ORIGIN, embeddedWallet: { writes: 'simulated-loopback' }, chain: { rpcUrl, network: 'loopback', timeoutMs: 5000 } }, logger: { info() {}, warn() {} } }));
    const server = http.createServer(app);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
    return async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${WALLET_RPC_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  }
  const fixture = await startChainFixture();
  t.after(() => fixture.close());
  const simulated = await relayTo(fixture.url);
  assert.equal((await simulated(execute)).status, 409, 'a write before any simulated answer is refused');
  assert.deepEqual(fixture.faults.rpcCalls, []);
  assert.equal((await simulated(nonceRead)).status, 200);
  assert.equal((await simulated(execute)).status, 200, 'a write after a simulated answer is forwarded');

  const plain = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: 200, response: 0 })); });
  await new Promise((done) => plain.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => plain.close(done)));
  const unmarked = await relayTo(`http://127.0.0.1:${plain.address().port}`);
  const read = await unmarked(nonceRead);
  assert.equal(read.status, 409);
  assert.match(read.body.response, /^not_simulated/);
  assert.equal((await unmarked(execute)).status, 409);
});

test('the relay accepts the held facade over each transport the client\'s node-wallet session composes, native payment included, and refuses every other object', async (t) => {
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  t.after(() => db.close());
  const clock = testClock();
  const relayAccess = createRelayAccess({ db, now: clock.now });
  // The session's own facade over its Agreement-class transport, which carries native payment, and a host's facade over that facade.
  const hostFacade = createHeldTransportFacade({ admission: held.admission, transport: held.transport });
  for (const transport of [held.transport, hostFacade]) {
    const relay = await startRelay({ db, transport, clock, relayAccess });
    t.after(() => relay.close());
    const capability = relayAccess.mint({ operationId: 'op-relay', phases: RELAY_PHASES }).capability;
    assert.equal((await relay.post(BINDING_PATH, readback(), capability)).body.error, 'not_issued', 'readback reaches the transport');
    assert.equal((await relay.post(RPC_PATH, nodeRead, capability)).body.error, 'profile_not_admitted', 'an RPC call reaches the transport');
  }
  for (const other of [{}, [], () => {}, { ...held.transport }, Object.create(held.transport), new Proxy(held.transport, {})]) {
    assert.throws(() => createWalletRpcRouter({ config, nativeTransport: other, relayAccess }), TypeError);
  }
});
