import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';

test('OAuth arrival diagnostics are off at the default info level', async (t) => {
  const h = await startHarness({ env: { DACS_LOG_LEVEL: 'info' } });
  t.after(() => h.close());
  const response = await fetch(`${h.origin}/oauth/auth`, { redirect: 'manual' });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(h.logs.some((line) => JSON.parse(line).event === 'oauth_auth_request'), false);
});

test('debug OAuth diagnostics correlate arrival and completion without copying credentials or parameters', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const marker = 'PRIVATE-DIAGNOSTIC-TEST-MARKER';
  for (let request = 1; request <= 2; request += 1) {
    const response = await fetch(`${h.origin}/oauth/auth?state=${marker}&code=${marker}&code_verifier=${marker}`, {
      redirect: 'manual', headers: { authorization: `Bearer ${marker}`, cookie: `test_cookie=${marker}` },
    });
    assert.equal(response.status, 400);
    await response.text();
  }
  const entries = h.logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'oauth_auth_request');
  assert.deepEqual(entries.map(({ request, phase }) => ({ request, phase })), [
    { request: 1, phase: 'received' }, { request: 1, phase: 'finished' },
    { request: 2, phase: 'received' }, { request: 2, phase: 'finished' },
  ]);
  assert.ok(entries.filter((entry) => entry.phase === 'finished').every((entry) => entry.status === 400 && entry.ms >= 0));
  assert.ok(entries.every((entry) => Object.keys(entry).every((key) => ['at', 'level', 'event', 'request', 'phase', 'method', 'status', 'ms'].includes(key))));
  assert.equal(h.logs.join('\n').includes(marker), false);
});
