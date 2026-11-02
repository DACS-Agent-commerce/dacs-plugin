// Exercise the helpers' actual child-run paths, without constructing or applying mutants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMutation as publicText } from './helpers/check-public-text-report-mutants.mjs';
import { checkMutation as wallet } from './helpers/wallet-write-batch-mutants.mjs';
import { checkMutation as seller } from './helpers/seller-write-batch-mutants.mjs';
import { checkMutation as showcase } from './helpers/showcase-ledger-mutants.mjs';
import { expectedTests } from './helpers/node-test-child.mjs';

const stub = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
const changed = Boolean(process.env.PUBLIC_TEXT_REPORT_TEST_MODULE || process.env.DACS_BATCH_TEST_MODULE
  || process.env.DACS_SELLER_BATCH_TEST_MODULE || process.env.DACS_SELLER_BATCH_TEST_APP
  || process.env.DACS_SELLER_BATCH_TEST_CONFIG || process.env.SHOWCASE_STUB);
const mode = process.env.VERDICT_STUB;
test(changed && mode === 'renamed' ? 'case renamed' : 'case a', () => {
  if (changed && mode === 'early') process.exit(0);
  assert.equal(changed && mode !== 'survive', false);
});
test('case b', () => {});
`;
const helpers = [
  ['public-text', 'public-text-report', (options) => publicText('stub', '/unused-module.mjs', options)],
  ['wallet', 'wallet-write-batch', (options) => wallet('stub', 'case', '/unused-module.mjs', options)],
  ...['module', 'app', 'config'].map((target) => [
    `seller ${target}`, 'seller-write-batch', (options) => seller('stub', 'case', '/unused-module.mjs', target, options),
  ]),
  ['showcase', 'showcase-progress', async (options) => {
    const file = 'test/showcase-progress.test.mjs';
    const expected = await expectedTests(file, { ...options, timeoutMs: 10000 });
    return showcase('stub', file, { ...options, timeoutMs: 10000, env: { ...options.env, SHOWCASE_STUB: '1' } }, expected);
  }],
];

for (const [name, file, check] of helpers) {
  for (const mode of ['caught', 'survive', 'renamed', 'early']) {
    test(`${name}: ${mode} child results`, { timeout: 20000 }, async (t) => {
      const groups = [];
      t.mock.method(console, 'log', (line) => {
        const match = /^stub: process group (\d+)$/.exec(line);
        if (match) groups.push(Number(match[1]));
      });
      const cwd = mkdtempSync(join(tmpdir(), 'helper-verdict-'));
      try {
        mkdirSync(join(cwd, 'test'));
        writeFileSync(join(cwd, 'test', `${file}.test.mjs`), stub);
        const env = { ...process.env, VERDICT_STUB: mode };
        for (const key of ['PUBLIC_TEXT_REPORT_TEST_MODULE', 'DACS_BATCH_TEST_MODULE', 'DACS_SELLER_BATCH_TEST_MODULE',
          'DACS_SELLER_BATCH_TEST_APP', 'DACS_SELLER_BATCH_TEST_CONFIG', 'SHOWCASE_STUB']) delete env[key];
        const options = { cwd, env };
        if (name === 'public-text' && mode !== 'caught') {
          await assert.rejects(check(options), mode === 'survive' ? /mutant survived/ : mode === 'renamed'
            ? /1 expected test\(s\) have no result, first: case a/ : /no closing test summary/);
          return;
        }
        const result = await check(options);
        const runs = name === 'showcase' ? result.attempts : 2;
        assert.equal(groups.length, runs, 'every child group is printed for cleanup after SIGKILL');
        assert.equal(new Set(groups).size, runs, 'each printed group belongs to a distinct run');
        assert.equal(result.nodeVersion, process.version);
        if (name === 'public-text') {
          assert.deepEqual([result.incomplete, result.tests, result.fail], [null, 2, 1]);
        } else {
          assert.equal(result.killed, mode === 'caught', JSON.stringify(result));
          if (mode === 'renamed') {
            assert.equal(name === 'showcase' ? result.testCount : result.tests, 2, 'renaming must preserve the baseline count');
            assert.match(result.incomplete, /1 expected test\(s\) have no result, first: case a/);
          } else if (mode === 'early') assert.match(result.incomplete, /no closing test summary/);
          else assert.equal(result.incomplete, null);
          if (name === 'showcase') assert.equal(result.attempts, ['renamed', 'early'].includes(mode) ? 3 : 1);
        }
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
  }
}
