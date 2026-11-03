import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoiceError, MAX_SELECTOR_CHARS, parseChoice, parseFlags } from '../../scripts/lib/choice.mjs';
import { ROOT_COMMIT, createRepo, runGate, writeList } from './gate-fixtures.mjs';

// One row per real CLI selector. Later owners add theirs: sdk-input --prepare, import-check subcommands and --plugin.
const HOSTILE_VALUES = {
  empty: '',
  unknown: 'partial',
  'wrong case': 'Generic',
  complet: 'complet',
  COMPLETE: 'COMPLETE',
  oversized: 'g'.repeat(100_000),
};

const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
const listFile = writeList(['unused-label']);
const COMPLETE_ONLY_FLAGS = ['--private-list', listFile, '--expected-root', ROOT_COMMIT];
const gateWithScope = (value) => runGate(['--repo', repo.dir, '--commit', repo.commit,
  ...(value === undefined ? [] : ['--scope', value]), ...(value === 'complete' ? COMPLETE_ONLY_FLAGS : [])]);

const SELECTORS = [
  { name: 'gate --scope', valid: ['generic', 'complete'], run: gateWithScope },
];

test('at this PR: gate `--scope` and the gate\'s own routes; later owners add their rows. Each real CLI selector accepts only its exact enum: gate --scope generic or complete; sdk-input --prepare root, http-mcp, stdio or buyer; import-check subcommand prepare, check or finalize; --plugin http-mcp or stdio when required by prepare/check; absent required, empty, unknown, wrong-case, complet, COMPLETE and 100,000-character inputs exit 2 with bounded diagnostics before any report or npm call and never default or become not-run/passed; valid bare finalize still runs, and an unknown supplied --plugin is refused; later owners register their CLI routes in this single table', async (t) => {
  for (const selector of SELECTORS) {
    for (const value of selector.valid) {
      await t.test(`${selector.name} accepts ${value}`, () => {
        const result = selector.run(value);
        assert.ok(result.status === 0 || result.status === 1, result.stderr);
        assert.equal(JSON.parse(result.stdout).scope, value);
      });
    }
    await t.test(`${selector.name} refuses an absent value and never defaults`, () => {
      const result = selector.run(undefined);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /missing-choice/);
    });
    for (const [label, value] of Object.entries(HOSTILE_VALUES)) {
      await t.test(`${selector.name} refuses ${label} input before any report`, () => {
        const result = selector.run(value);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.length <= MAX_SELECTOR_CHARS + 1);
        assert.match(result.stderr, /(?:invalid|oversized)-choice/);
      });
    }
  }
});

test('parseChoice returns only an exact member and reports the cause without echoing the value', () => {
  assert.equal(parseChoice('--scope', 'generic', ['generic', 'complete']), 'generic');
  const causes = new Map([[undefined, 'missing-choice'], ['', 'invalid-choice'], ['Generic', 'invalid-choice'],
    ['x'.repeat(MAX_SELECTOR_CHARS + 1), 'oversized-choice']]);
  for (const [value, cause] of causes) {
    assert.throws(() => parseChoice('--scope', value, ['generic', 'complete']), (error) => {
      assert.ok(error instanceof ChoiceError);
      assert.equal(error.cause, cause);
      assert.ok(!error.message.includes('Generic'));
      return true;
    });
  }
});

test('parseFlags refuses an unknown flag, a repeated flag, a missing value and a stray argument', () => {
  assert.deepEqual(parseFlags(['--a', '1', '--b', '2'], ['--a', '--b']), { '--a': '1', '--b': '2' });
  for (const argv of [['--c', '1'], ['--a', '1', '--a', '2'], ['--a'], ['stray']]) {
    assert.throws(() => parseFlags(argv, ['--a', '--b']), { cause: 'bad-arguments' });
  }
});
