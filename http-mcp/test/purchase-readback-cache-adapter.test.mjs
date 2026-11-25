import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '@kynesyslabs/dacs-client';
import * as adapter from '../src/util/purchase-readback-cache.mjs';

// An included Demos anchor receipt in the core's exact shape, and the verified read that matches it.
const receipt = () => ({ receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST', logicalAddress: 'dacs:agreement:test', nativeAddress: 'TEST-address',
  contentHash: 'a'.repeat(64), transactionRef: { kind: 'demos', value: 'b'.repeat(64) }, writer: 'TEST-writer', state: 'included', observationDisposition: 'established',
  observedAt: 100, blockRef: { id: 'c'.repeat(64), height: '1', timestamp: 100 }, evidence: { kind: 'TEST', value: 'TEST-proof' } });
const present = () => ({ disposition: 'present', native: { receipt: receipt(), txRef: { writeTxHash: 'b'.repeat(64) } } });

test('the plugin\'s readback cache module is the client\'s public createPurchaseReadbackCache, its read calls the host\'s currentness check on every read, and a not-current purchase is never answered from the cache', async () => {
  assert.deepEqual(Object.keys(adapter), ['createPurchaseReadbackCache']);
  assert.equal(adapter.createPurchaseReadbackCache, client.createPurchaseReadbackCache);
  let status = 'settled_verified', reads = 0, checks = 0;
  const cache = adapter.createPurchaseReadbackCache({ loadPurchase: (id) => ({ id, kind: 'purchase', status, state: { protocol: { stage: 'payment-observed' } } }) });
  const request = { purchaseId: 'pur_TESTTESTTESTTEST', receipt: receipt(), scope: { TEST: 'scope' } };
  const readVerified = async () => { reads += 1; return present(); };
  const checkCurrent = async () => { checks += 1; };
  await cache.read(request, readVerified, checkCurrent);
  await cache.read(request, readVerified, checkCurrent);
  await cache.read(request, readVerified, checkCurrent);
  assert.equal(reads, 1, 'later reads of a current purchase are answered from the cache');
  assert.equal(checks, 2, 'every cached answer runs the host\'s currentness check');
  const stale = { disposition: 'indeterminate', reason: 'TEST not current' };
  assert.deepEqual(await cache.read(request, readVerified, async () => stale), stale, 'a not-current answer is returned, not the cached one');
  await cache.read(request, readVerified, checkCurrent);
  assert.equal(reads, 2, 'the not-current answer evicted the entry');
  status = 'cancelled';
  await cache.read(request, readVerified, checkCurrent);
  assert.equal(reads, 3, 'an ended purchase is read fresh, never from the cache');
  const failing = adapter.createPurchaseReadbackCache({ loadPurchase: () => { throw new Error('TEST host read failed'); } });
  await assert.rejects(failing.read(request, readVerified), /TEST host read failed/, 'the host\'s error reaches the caller unchanged');
});
