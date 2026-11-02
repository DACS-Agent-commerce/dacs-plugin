import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A, B, openCrashWorld } from './helpers/settlement-crash-world.mjs';
for (const scenario of ['current', 'stale', 'mismatch']) for (const boundary of ['before-transaction', 'before-commit', 'after-commit']) {
  test(`SIGKILL ${scenario} settlement ${boundary}: atomic evidence and restart without resend`, { timeout: 15000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'settlement-crash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let stderr = '';
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./helpers/settlement-crash-child.mjs', import.meta.url).pathname, dir, boundary, scenario], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr += data; });
    const [code, signal] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve([code, signal])); });
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'interrupted.json'), 'utf8')), { boundary, scenario });
    let w = await openCrashWorld(dir, { scenario }); t.after(() => w?.close());
    const snapshot = await w.snapshot(), committed = boundary === 'after-commit';
    assert.equal(snapshot.coord.reportedTxHash, scenario === 'stale' ? B : A);
    assert.equal(snapshot.paid.status, committed && scenario === 'current' ? 'settled_verified' : scenario === 'mismatch' ? committed ? 'payment_mismatch' : 'broadcast_reported' : 'cancelled');
    assert.equal(snapshot.other.status, committed && scenario === 'current' ? 'superseded' : 'broadcast_reported');
    assert.equal(Boolean(snapshot.coord.verifiedAt), committed && scenario === 'current');
    assert.deepEqual(snapshot.nonces.map(row => ({ hash: row.tx_hash, nonce: row.nonce })), committed ? [{ hash: A, nonce: 7 }] : []);
    assert.equal(snapshot.paidSource.state, 'issued'); assert.equal(snapshot.otherSource.state, 'issued');
    assert.deepEqual(snapshot.ledger, { sends: 1 });
    if (scenario === 'stale') {
      assert.equal(snapshot.coord.observation, null, 'stale nonce evidence never changes the replacement pointer');
      assert.equal(snapshot.lane.observation, null);
    } else {
      // A fresh process recovers both source lanes after the durable settlement,
      // or re-reads and commits once if the original process died before commit.
      assert.equal((await w.verify()).verification.outcome, scenario === 'current' ? 'verified' : 'mismatch');
      const recovered = await w.snapshot();
      assert.equal(recovered.paid.status, scenario === 'current' ? 'settled_verified' : 'payment_mismatch');
      assert.equal(recovered.other.status, scenario === 'current' ? 'superseded' : 'broadcast_reported');
      assert.equal(recovered.coord.observation.nativeNonceResolved, true);
      if (scenario === 'current') assert.equal(recovered.lane.observation.nativeLaneResolved, true);
      assert.equal(recovered.paidSource.state, 'superseded'); assert.equal(recovered.otherSource.state, scenario === 'current' ? 'superseded' : 'issued');
      assert.deepEqual(recovered.ledger, { sends: 1 });
      assert.equal((await w.verify()).verification.outcome, scenario === 'current' ? 'verified' : 'mismatch');
      assert.deepEqual(await w.snapshot(), recovered, 'repeat adds no second effect');
      w.close(); w = null; w = await openCrashWorld(dir, { scenario });
      assert.deepEqual(await w.snapshot(), recovered, 'second restart retains evidence and completed lane release');
    }
  });
}
