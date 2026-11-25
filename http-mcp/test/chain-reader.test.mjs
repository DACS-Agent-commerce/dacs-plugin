// The plugin's Demos chain reader: identity reads built here, the other reads from the client's public reader or a native transport's reader.
// Every node here is an in-process fetch stand-in on an .invalid host; nothing contacts a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemosPublicChainReader } from '@kynesyslabs/dacs-client/substrate/demos';
import { DEMOS_CCI_RESPONSE_LIMITS } from '@kynesyslabs/dacs/identity';
import { createDemosChainReader } from '../src/sdk/chain-reader.mjs';

const RPC = 'https://node.chain.invalid';
const ADDR = `0x${'ab'.repeat(32)}`;
const GENESIS = 'cd'.repeat(32);
const EMPTY_IDENTITIES = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
const PUBLIC_READS = ['readStorageProgram', 'getAddressBalance', 'getTransactionFees', 'networkIdentity', 'getAddressNonce', 'observePurchaseTransfer', 'observeTransfer', 'getTransaction', 'findTransferAtNonce'];
const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

// Answers block 0 with the genesis hash and every getIdentities call with an empty identity set.
function nodeStandIn() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    if (body.method === 'gcr_routine') return json(EMPTY_IDENTITIES);
    return json({ result: 200, response: { number: 0, hash: GENESIS } });
  };
  return { calls, fetchImpl };
}

test('over the public chain reader, the reader offers its nine reads, getIdentities and the read metadata, and nothing that signs or sends', async () => {
  const node = nodeStandIn();
  const chainReads = createDemosPublicChainReader({ rpcUrl: RPC, network: 'testnet', pinnedIdentity: GENESIS, fetchImpl: node.fetchImpl });
  const reader = createDemosChainReader({ rpcUrl: RPC, network: 'testnet', fetchImpl: node.fetchImpl, chainReads });
  const functions = Object.keys(reader).filter((key) => typeof reader[key] === 'function').sort();
  assert.deepEqual(functions, [...PUBLIC_READS, 'getIdentities'].sort());
  assert.deepEqual([reader.network, reader.rpcOrigin, reader.pinnedIdentity, reader.evidenceMode], ['testnet', RPC, GENESIS, 'public-chain-read']);
  assert.ok(Object.isFrozen(reader));
  assert.deepEqual(await reader.networkIdentity(), { mode: 'public-chain-read', identity: GENESIS }, 'a delegated read answers from the public reader');
  assert.deepEqual(await reader.getIdentities(ADDR), EMPTY_IDENTITIES);
  assert.deepEqual(node.calls.at(-1).body, { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [ADDR] }] });
});

test('chain reads missing any of the public reads are refused when the reader is built', () => {
  const complete = Object.fromEntries(PUBLIC_READS.map((name) => [name, async () => null]));
  for (const name of PUBLIC_READS) {
    const chainReads = { ...complete };
    delete chainReads[name];
    assert.throws(() => createDemosChainReader({ rpcUrl: RPC, network: 'testnet', chainReads }), (error) => error instanceof TypeError && error.message.includes(name), name);
  }
});

test('an identity read sends the unsigned SDK request shape and an answer marked simulated labels the reader simulated-fixture', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return json(EMPTY_IDENTITIES, { 'x-dacs-simulation': 'fixture' });
  };
  const reader = createDemosChainReader({ rpcUrl: 'http://127.0.0.1:9/', network: 'demos-testnet', fetchImpl });
  assert.equal(reader.evidenceMode, 'public-chain-read');
  await reader.getIdentities(ADDR);
  assert.equal(reader.evidenceMode, 'simulated-fixture');
  assert.equal(reader.rpcOrigin, 'http://127.0.0.1:9');
  assert.deepEqual([seen[0].headers.identity, seen[0].headers.signature, seen[0].headers.timestamp], ['ed25519:', '', '']);
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[0].credentials, 'omit');
});

test('a remote RPC origin that marks its answers simulated stays a public chain read', async () => {
  const fetchImpl = async () => json(EMPTY_IDENTITIES, { 'x-dacs-simulation': 'fixture' });
  const reader = createDemosChainReader({ rpcUrl: RPC, network: 'demos-testnet', fetchImpl });
  await reader.getIdentities(ADDR);
  assert.equal(reader.evidenceMode, 'public-chain-read');
});

test('an identity answer over the response byte limit is refused before it is decoded', async () => {
  const oversize = `{"result":200,"response":"${'x'.repeat(DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes)}"}`;
  const fetchImpl = async () => new Response(oversize, { status: 200, headers: { 'content-type': 'application/json' } });
  const reader = createDemosChainReader({ rpcUrl: RPC, network: 'testnet', fetchImpl });
  await assert.rejects(reader.getIdentities(ADDR), (error) => error.kind === 'invalid' && /byte limit/.test(error.message));
});
