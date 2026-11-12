// The client's purchase factories refuse a Node below their floor before anything is built, so the app
// database is never opened under a runtime that cannot run purchases. The check needs a real older
// runtime: DACS_TEST_NODE20 names a Node 20 binary (CI images that have none skip this test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'candidate-runtime-floor-probe.mjs');
const node20 = process.env.DACS_TEST_NODE20;

test('constructing the client purchase service on Node 20.19 refuses runtime_unsupported before the app database opens', { skip: node20 ? false : 'DACS_TEST_NODE20 is not set' }, (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'dacs-runtime-floor-'));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const report = JSON.parse(execFileSync(node20, [PROBE, dataDirectory], { encoding: 'utf8' }));
  assert.match(report.version, /^v20\./);
  assert.equal(report.refusal?.code, 'runtime_unsupported');
  assert.match(report.refusal.message, /22\.13/);
  assert.deepEqual(report.filesOpened, []);
});
