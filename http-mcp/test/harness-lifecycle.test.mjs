// Test-fixture lifecycle: the harness removes only the temporary data dir it
// created, and only on its final close, never on restart().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, seedSellerListing } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

test('harness-owned data dir survives restart() with its state, then close() removes it', async () => {
  const h = await startHarness();
  let closed = false;
  try {
    assert.ok(h.dataDir.startsWith(join(tmpdir(), 'dacs-chatgpt-test-')));
    const seller = createEphemeralWallet();
    seedSellerListing(h, seller, { listingId: 'lifecycle-report', price: '1' });
    const buyer = await linkedUser(h);
    const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'lifecycle-report', version: 1, seller: seller.claim, idempotencyKey: `lifecycle-${Date.now()}` });
    assert.equal(p.status, 'awaiting_approval');
    assert.ok(readdirSync(h.dataDir).some((f) => f.endsWith('.sqlite')), 'SQLite state lives in the owned data dir');

    await h.restart();
    assert.ok(existsSync(h.dataDir), 'restart keeps the data dir');
    const status = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
    assert.equal(status.status, 'awaiting_approval', 'durable state is readable after restart');

    await h.close();
    closed = true;
    assert.equal(existsSync(h.dataDir), false, 'final close removes the harness-owned data dir and its SQLite files');
  } finally {
    if (!closed) await h.close();
  }
});

test('a caller-supplied DACS_DATA_DIR is left in place for its owner', async () => {
  const own = mkdtempSync(join(tmpdir(), 'dacs-lifecycle-caller-'));
  try {
    const h = await startHarness({ env: { DACS_DATA_DIR: own } });
    await h.close();
    assert.ok(existsSync(own), 'harness did not remove a dir it does not own');
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test('close({ keepFixtures: true }) still removes the owned data dir but keeps shared fixtures', async () => {
  const h = await startHarness();
  const h2 = await startHarness({ chain: h.chain, directory: h.directory });
  try {
    await h2.close({ keepFixtures: true });
    assert.equal(existsSync(h2.dataDir), false);
    assert.ok(existsSync(h.dataDir), 'the other harness keeps its own data dir');
    assert.equal((await fetch(h.chain.url, { method: 'POST' }).catch(() => null)) !== null, true, 'shared chain fixture still answers');
  } finally {
    await h.close();
  }
  assert.equal(existsSync(h.dataDir), false);
});
