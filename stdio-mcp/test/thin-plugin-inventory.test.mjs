import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const config = JSON.parse(fs.readFileSync(new URL('../scripts/thin-plugin.config.json', import.meta.url), 'utf8'));
const names = ['dacs_search', 'dacs_get_listing', 'dacs_buy_prepare', 'dacs_buy', 'dacs_purchase_status'];
const families = ['canonical-json', 'artifact-crypto', 'job-id', 'agreement-hash', 'payment-state', 'execution-readback'];

test('the inventory keeps all five entries, each on the required server module', () => {
  assert.deepEqual(config.entries.map(e => e.name), names);
  for (const entry of config.entries) {
    const required = entry.modules.filter(m => !m.optional);
    assert.deepEqual(required, [{file: 'src/server.ts', registration: entry.name}], entry.name);
    assert.ok(entry.modules.filter(m => m.optional).every(m => m.file.startsWith('buyer/')), entry.name);
  }
});

test('the inventory keeps the root dependency checks and the buyer roots as optional', () => {
  assert.deepEqual(config.dependencyRoots, [{path: '.'}, {path: 'buyer', optional: true}]);
});

test('the inventory keeps the forbidden-directory fence', () => {
  assert.ok(config.forbiddenDirs.includes('src/dacs/'));
});

test('the inventory keeps all six primitive families', () => {
  assert.deepEqual(config.primitives.map(p => p.id), families);
  for (const p of config.primitives) assert.ok(p.names.length > 0, p.id);
  assert.deepEqual(config.primitives.find(p => p.id === 'execution-readback').references, ['getTxByHash']);
});

// Stays red until the Claude Code entry registers the purchase tools from the client.
test('the checker over the stdio tree exits 1 and names each entry\'s missing registration', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-thin-plugin.mjs', import.meta.url))], {encoding: 'utf8'});
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'violation');
  const missing = report.violations.filter(v => v.rule === 'missing-handler-registration').map(v => v.detail);
  assert.deepEqual(missing, names.map(n => `${n}:${n}`));
});
