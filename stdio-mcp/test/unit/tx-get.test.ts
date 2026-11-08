/**
 * demos_tx_get readback (DemosChain.getTx): a hash the node does not know is not found.
 * The node answers an absent hash with state "unknown" (or "not_found", or a 404 envelope)
 * and no transaction content; none of those is evidence that the transaction exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemosChain } from '../../src/chain.js';
import { SecretGuard } from '../../src/secrets.js';

const HASH = 'ab'.repeat(32);
const envelope404 = { result: 404, response: 'not found', require_reply: false };

function chainWith(status: unknown, tx: unknown): DemosChain {
  const c = new DemosChain('http://127.0.0.1:1', new SecretGuard());
  (c as any).demos = {
    nodeCall: async () => status,
    getTxByHash: async () => tx,
  };
  return c;
}

for (const [name, status, tx] of [
  ['state unknown, no transaction', { state: 'unknown' }, null],
  ['state unknown, 404 transaction envelope', { state: 'unknown' }, envelope404],
  ['state not_found, no transaction', { state: 'not_found' }, null],
  ['404 status envelope, 404 transaction envelope', envelope404, envelope404],
] as const) {
  test(`an absent hash is not found: ${name}`, async () => {
    const r = await chainWith(status, tx).getTx(HASH);
    assert.equal(r.found, false);
    assert.equal(r.content, undefined);
  });
}

test('a hash with a known state is found even before its content is readable', async () => {
  const r = await chainWith({ state: 'confirmed', blockNumber: 7 }, null).getTx(HASH);
  assert.equal(r.found, true);
  assert.equal(r.state, 'confirmed');
  assert.equal(r.blockNumber, 7);
});

test('a hash with transaction content is found whatever the status says', async () => {
  const r = await chainWith({ state: 'unknown' }, { content: { type: 'native', from: '0x1', to: '0x2', amount: 1 } }).getTx(HASH);
  assert.equal(r.found, true);
  assert.equal(r.content?.type, 'native');
});

test('a transport failure (5xx envelope) with no transaction is an error, not "not found"', async () => {
  await assert.rejects(chainWith({ result: 500, response: 'down', require_reply: false }, null).getTx(HASH));
});

test('a 404 "Unknown message" (the node has no such handler) is an error, not "not found"', async () => {
  const unknownHandler = { result: 404, response: 'Unknown message', require_reply: false };
  await assert.rejects(chainWith(unknownHandler, null).getTx(HASH));
  await assert.rejects(chainWith(unknownHandler, envelope404).getTx(HASH));
});
