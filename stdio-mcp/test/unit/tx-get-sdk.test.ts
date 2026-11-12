/**
 * demos_tx_get readback through the real SDK against a local fake node. The SDK's call() returns
 * an HTTP error reply as {result: 500, response: TransportError}, with the node's HTTP status and
 * body on the error's cause, so these tests check the absence rule where the HTTP status is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DemosChain } from '../../src/chain.js';
import { SecretGuard } from '../../src/secrets.js';

const HASH = 'cd'.repeat(32);
type Reply = { status: number; body: unknown };

// A node that answers GET / (connect) and each nodeCall by its message name.
async function fakeNode(replies: Record<string, Reply>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const name = Object.keys(replies).find((k) => raw.includes(`"${k}"`));
      const reply = name ? replies[name] : { status: 404, body: { result: 404, response: 'Unknown message' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function getTx(replies: Record<string, Reply>) {
  const node = await fakeNode(replies);
  try {
    return await new DemosChain(node.url, new SecretGuard()).getTx(HASH);
  } finally {
    await node.close();
  }
}

const statusAbsent: Reply = { status: 404, body: { result: 404, response: { state: 'unknown', checkedThroughBlock: 12 } } };
const txAbsent: Reply = { status: 404, body: { result: 404, response: { checkedThroughBlock: 12 } } };
const statusUnknown200: Reply = { status: 200, body: { result: 200, response: { state: 'unknown' } } };

test('HTTP 404 replies that say what the node searched are "not found"', async () => {
  for (const [status, tx] of [[statusAbsent, txAbsent], [statusUnknown200, txAbsent], [statusAbsent, { status: 200, body: { result: 200, response: null } }]] as const) {
    const r = await getTx({ getTransactionStatus: status, getTxByHash: tx });
    assert.equal(r.found, false);
    assert.equal(r.content, undefined);
  }
});

test('an HTTP 404 "Unknown message" (no handler) is an error, in a string or an object', async () => {
  for (const response of ['Unknown message', { message: 'Unknown message' }]) {
    await assert.rejects(getTx({ getTransactionStatus: { status: 404, body: { result: 404, response } }, getTxByHash: txAbsent }));
  }
});

test('an HTTP 404 that does not say what it searched is an error', async () => {
  await assert.rejects(getTx({ getTransactionStatus: { status: 404, body: { result: 404, response: 'not found' } }, getTxByHash: txAbsent }));
  await assert.rejects(getTx({ getTransactionStatus: statusUnknown200, getTxByHash: { status: 404, body: 'not found' } }));
});

test('an HTTP 500 lookup failure is an error unless the status shows the transaction', async () => {
  const lookupFailed: Reply = { status: 500, body: { result: 500, response: 'lookup_failed' } };
  await assert.rejects(getTx({ getTransactionStatus: statusUnknown200, getTxByHash: lookupFailed }));
  const r = await getTx({ getTransactionStatus: { status: 200, body: { result: 200, response: { state: 'included', blockNumber: 7 } } }, getTxByHash: lookupFailed });
  assert.equal(r.found, true);
  assert.equal(r.state, 'pending', 'inclusion without a readable execution is not success');
  assert.equal(r.executed, false);
});
