import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { createPrivateMatcher } from '../../scripts/public-gate/rules-private.mjs';

const ENTRY = ['quartz', 'lantern'].join('-');
const CHECKPOINT_STEPS = 65_536;
const noDeadline = () => {};
const matcherFor = (entries, checkpoint = noDeadline) => createPrivateMatcher(entries, checkpoint);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines (CRLF, CR or LF ends one) where some entry starts, found by one whole-text `/iu` search per entry. */
function oracleLines(text, entries) {
  const lineAt = (index) => 1 + (text.slice(0, index).match(/\r\n|\r|\n/g) ?? []).length;
  const starts = entries.flatMap((entry) => [...text.matchAll(new RegExp(`(?=${escapeRegExp(entry)})`, 'giu'))].map((match) => match.index));
  return [...new Set(starts.map(lineAt))].sort((first, second) => first - second);
}

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

test('hits and start lines equal a whole-text /iu search for random entries with overlaps, prefixes, regex syntax, astral and mixed-case characters', () => {
  const random = seededRandom(7);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const letters = ['a', 'A', 'b', '.', '*', '(', '[', 'ß', 'ẞ', 'ſ', 's', 'S', 'k', 'K', 'K', 'σ', 'ς', 'Σ', 'ı', 'i', 'I', 'İ', 'é', '\u{1F600}', '\u{10400}', '\u{10428}'];
  const word = (length) => Array.from({ length }, () => pick(letters)).join('');
  for (let round = 0; round < 400; round += 1) {
    const entries = Array.from({ length: 1 + Math.floor(random() * 4) }, () => word(1 + Math.floor(random() * 3)));
    if (random() < 0.5) entries.push(`${entries[0]}${word(1)}`);
    const text = Array.from({ length: 40 }, () => pick([...letters, ' ', '\n', '\r', '\r\n'])).join('');
    const matcher = matcherFor(entries);
    const expected = oracleLines(text, entries);
    assert.deepEqual(matcher.entryLines(text, Infinity), expected, JSON.stringify({ entries, text }));
    assert.equal(matcher.hasEntry(text), expected.length > 0);
  }
});

test('case folding agrees with /iu for dotless and dotted i, long s, Kelvin sign, final sigma, Greek letters with two encodings and sharp s', () => {
  const pairs = [['ı', 'i'], ['ı', 'I'], ['İ', 'i'], ['İ', 'I'], ['ſ', 's'], ['ſ', 'S'], ['K', 'k'], ['K', 'K'],
    ['ς', 'σ'], ['ς', 'Σ'], ['σ', 'Σ'], ['ΐ', 'ΐ'], ['ΰ', 'ΰ'], ['ß', 'ẞ'], ['ß', 'ss'], ['ẞ', 'SS']];
  for (const [first, second] of pairs) {
    for (const [entry, text] of [[first, second], [second, first]]) {
      assert.equal(matcherFor([entry]).hasEntry(text), new RegExp(escapeRegExp(entry), 'iu').test(text), `${entry} in ${text}`);
    }
  }
});

test('every code point with a case mapping matches exactly the code points /iu matches', () => {
  const cased = [];
  for (let code = 0; code < 0x110000; code += 1) {
    const char = String.fromCodePoint(code);
    if (char.toLowerCase() !== char || char.toUpperCase() !== char) cased.push(char);
  }
  const haystack = cased.join('\n');
  const lineAt = new Map();
  let start = 0;
  cased.forEach((char, line) => {
    lineAt.set(start, line + 1);
    start += char.length + 1;
  });
  const mismatched = cased.filter((char) => {
    const expected = [...haystack.matchAll(new RegExp(`\\u{${char.codePointAt(0).toString(16)}}`, 'giu'))].map((match) => lineAt.get(match.index));
    return matcherFor([char]).entryLines(haystack, Infinity).join() !== expected.join();
  });
  assert.deepEqual(mismatched, []);
});

test('LF, CRLF and a lone CR each end exactly one line', () => {
  const matcher = matcherFor(['secret-value']);
  for (const text of ['clean\nsecret-value\n', 'clean\r\nsecret-value\r\n', 'clean\rsecret-value\r']) assert.deepEqual(matcher.entryLines(text, 10), [2], JSON.stringify(text));
  assert.deepEqual(matcher.entryLines('a\r\r\nb\n\rSECRET-VALUE', 10), [5]);
});

test('lines are distinct, ascending and cut at the requested number', () => {
  const matcher = matcherFor([ENTRY]);
  const text = ['x', ENTRY, `${ENTRY} ${ENTRY}`, 'y', ENTRY, ENTRY].join('\n');
  assert.deepEqual(matcher.entryLines(text, 10), [2, 3, 5, 6]);
  assert.deepEqual(matcher.entryLines(text, 2), [2, 3]);
});

test('one 8 MiB line dense with overlapping hits finishes and reports line 1', () => {
  assert.deepEqual(matcherFor(['ab', 'b', 'ba']).entryLines('ab'.repeat(4 << 20), 10), [1]);
});

test('scan work does not grow with the list: 2,000 shared-prefix entries cost at most 4 times the steps of 10 on an 8 MiB near miss', () => {
  const prefix = 'shared-prefix-for-entries-';
  const many = Array.from({ length: 2000 }, (_, index) => `${prefix}${String(index).padStart(4, '0')}`);
  assert.ok(Buffer.byteLength(many.join('\n')) <= 65_536);
  const text = `${prefix}x `.repeat(Math.ceil((8 << 20) / (prefix.length + 2)));
  const checkpointsFor = (entries) => {
    let calls = 0;
    assert.deepEqual(matcherFor(entries, () => { calls += 1; }).entryLines(text, 10), []);
    return calls;
  };
  const few = checkpointsFor(many.slice(0, 10));
  assert.ok(few >= (8 << 20) / CHECKPOINT_STEPS, `only ${few} checkpoints`);
  assert.ok(checkpointsFor(many) <= 4 * few);
});

test('the deadline checkpoint stops the matcher while it is built and while it scans', () => {
  const expired = () => { throw new GateInputError('limit:scanDeadlineMs', 'the scan took too long'); };
  const longList = Array.from({ length: 3000 }, (_, index) => `${String(index).padStart(6, '0')}-${'e'.repeat(30)}`);
  assert.throws(() => matcherFor(longList, expired), { cause: 'limit:scanDeadlineMs' });
  const matcher = matcherFor([ENTRY], expired);
  assert.throws(() => matcher.entryLines('d'.repeat(2 * CHECKPOINT_STEPS), 10), { cause: 'limit:scanDeadlineMs' });
  assert.throws(() => matcher.hasEntry('d/'.repeat(CHECKPOINT_STEPS)), { cause: 'limit:scanDeadlineMs' });
});
