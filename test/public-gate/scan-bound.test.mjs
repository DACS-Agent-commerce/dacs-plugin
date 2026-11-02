import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScanDeadline } from '../../scripts/public-gate/gate.mjs';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { createPrivateMatcher } from '../../scripts/public-gate/rules-private.mjs';

const ENTRY = ['quartz', 'lantern'].join('-');
const WINDOW = 1024;

const deadlineAfter = (calls) => {
  let seen = 0;
  return () => {
    seen += 1;
    if (seen > calls) throw new GateInputError('limit:scanDeadlineMs', 'the scan took too long');
  };
};

/** Lines of `text` that hold an entry, found without windows. */
const naiveLines = (text, entries) => text.split('\n').flatMap((line, index) => (entries.some((entry) => line.toLowerCase().includes(entry.toLowerCase())) ? [index + 1] : []));

test('a list entry that straddles a scan window boundary is found on its own line, at every offset around the boundary', () => {
  const matcher = createPrivateMatcher([ENTRY]);
  const lines = [];
  for (let offset = WINDOW - ENTRY.length - 2; offset <= WINDOW + 2; offset += 1) lines.push(`${'x'.repeat(offset)}${ENTRY.toUpperCase()}`, 'clean line');
  const text = lines.join('\n');
  assert.deepEqual(matcher.linesIn(Buffer.from(text), 1000), naiveLines(text, [ENTRY]));
});

test('an entry longer than a scan window and an entry after an astral character at the boundary are found', () => {
  const long = `long-${'ab'.repeat(2 * WINDOW)}`;
  const astral = 'pile-\u{1F600}-end';
  const matcher = createPrivateMatcher([long, astral]);
  const text = `${'y'.repeat(WINDOW - 3)}${long}\n${'z'.repeat(WINDOW - 3)}${'\u{1F600}'}${astral}\n`;
  assert.deepEqual(matcher.linesIn(Buffer.from(text), 1000), [1, 2]);
  assert.equal(matcher.firstEntryIn(`${'p'.repeat(WINDOW - 2)}${astral.toUpperCase()}`), 2);
});

test('the number of the first entry is the lowest list number found anywhere in a long path', () => {
  const matcher = createPrivateMatcher(['second-entry', 'first-entry']);
  assert.equal(matcher.firstEntryIn(`${'d/'.repeat(5 * WINDOW)}first-entry/${'d/'.repeat(WINDOW)}second-entry`), 1);
  assert.equal(matcher.firstEntryIn('d/'.repeat(5 * WINDOW)), 0);
});

test('the scan deadline stops the scan of a large blob between windows instead of after the whole scan', () => {
  const entries = Array.from({ length: 1200 }, (_, index) => `${'a'.repeat(20)}-${String(index).padStart(5, '0')}`);
  const matcher = createPrivateMatcher(entries, deadlineAfter(3));
  assert.throws(() => matcher.linesIn(Buffer.from('a'.repeat(64 * WINDOW)), 1000), { cause: 'limit:scanDeadlineMs' });
});

test('the scan deadline stops the search of a long path', () => {
  const matcher = createPrivateMatcher([ENTRY], deadlineAfter(2));
  assert.throws(() => matcher.firstEntryIn('d'.repeat(8 * WINDOW)), { cause: 'limit:scanDeadlineMs' });
});

test('the scan deadline passes while the clock is within it and throws limit:scanDeadlineMs once the clock is past it', () => {
  let now = 1000;
  const checkpoint = createScanDeadline({ deadlineMs: 500, clock: () => now });
  checkpoint();
  now = 1500;
  checkpoint();
  now = 1501;
  assert.throws(checkpoint, { cause: 'limit:scanDeadlineMs' });
});
