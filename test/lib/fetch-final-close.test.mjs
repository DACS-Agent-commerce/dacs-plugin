import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fetchBounded } from '../../scripts/lib/fetch-bounded.mjs';

// Hold the final close until the test fires the captured deadline callback,
// after a complete body and correct digest have already been read.
test('a deadline during the final close refuses success and removes the file', async (t) => {
  const folder = await fs.mkdtemp(path.join(tmpdir(), 'download-close-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const destination = path.join(folder, 'archive.tgz');
  const payload = Buffer.from('complete and correctly hashed');
  const realOpen = fs.open;
  let enterClose;
  const closeEntered = new Promise((resolve) => { enterClose = resolve; });
  let releaseClose;
  const closePending = new Promise((resolve) => { releaseClose = resolve; });
  t.after(() => releaseClose());
  let fireDeadline;
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    fireDeadline = callback;
    return undefined;
  });
  let closeReached = false;
  let deadlineFired = false;
  let firedBeforeFinalClose = null;
  const patch = t.mock.method(fs, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const close = handle.close.bind(handle);
    let firstClose = true;
    handle.close = async () => {
      if (firstClose) {
        firstClose = false;
        closeReached = true;
        // The successful final close must start before the deadline, so that the
        // deadline fires while this close is pending, not during cleanup.
        firedBeforeFinalClose = deadlineFired;
        enterClose();
        await closePending;
      }
      return close();
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  const outcome = fetchBounded({
    url: 'https://download.example.invalid/archive.tgz', destination,
    sha256: createHash('sha256').update(payload).digest('hex'),
    maxBytes: 1024, deadlineMs: 50,
    transport: async (_url, { signal }) => {
      signal.addEventListener('abort', () => { deadlineFired = true; }, { once: true });
      return {
        status: 200, contentLength: payload.length,
        body: (async function* () { yield payload; })(), release() {},
      };
    },
  });
  const rejection = assert.rejects(outcome, (error) => error.cause === 'download-timeout');
  await closeEntered;
  assert.equal(firedBeforeFinalClose, false);
  try {
    fireDeadline();
  } finally {
    releaseClose();
  }
  await rejection;
  assert.equal(closeReached, true);
  assert.equal(firedBeforeFinalClose, false);
  assert.equal(deadlineFired, true);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});
