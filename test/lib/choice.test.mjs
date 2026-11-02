import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoiceError, MAX_SELECTOR_CHARS, parseChoice, parseFlags } from '../../scripts/lib/choice.mjs';

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
