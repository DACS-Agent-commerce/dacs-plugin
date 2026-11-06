import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createWordingMatcher, scanWording } from '../../scripts/public-gate/rules-text.mjs';

const { limits } = JSON.parse(readFileSync(new URL('../../public-gate.config.json', import.meta.url), 'utf8'));
const [EXTERNAL, SECURITY, REVIEW] = ['external', 'security', 'review'];
const HOLD = `The ${EXTERNAL} ${SECURITY} ${REVIEW} is on hold`;
const matcher = createWordingMatcher([['unlisted', 'entry'].join('-')], () => {});
const findingLines = (text, name = 'page.html') => scanWording({
  entries: [{ path: name, bytes: Buffer.from(text), oid: 'b'.repeat(40), position: 1 }], wordingMatcher: matcher, limits,
}).map(({ line }) => line);
const tokens = [
  ['comment', (phrase) => `<!-- ${phrase} -->`],
  ['alt attribute', (phrase) => `<img alt="${phrase}">`],
  ['data attribute', (phrase) => `<p data-note="${phrase}">x</p>`],
  ['title attribute', (phrase) => `<p title="${phrase}">x</p>`],
  ['link title', (phrase) => `[label](u "${phrase}")`],
  ['reference title', (phrase) => `[label]: u "${phrase}"`],
];
const gaps = [['space', ' '], ['underscore', '_'], ['emphasis', '**'], ['backtick', '`'], ['soft hyphen', '\u00ad'], ['zero-width space', '\u200b']];

for (const [name, token] of tokens) {
  for (const [label, gap] of gaps) {
    test(`wording token status: ${name} with ${label} between the words is found`, () => {
      for (const kind of [EXTERNAL, SECURITY]) {
        const text = `Intro.\n\n${token(`${kind}${gap}${REVIEW}: complete`)}\n`;
        for (const extension of ['html', 'md', 'htm', 'svg']) assert.deepEqual(findingLines(text, `a.${extension}`), [3], text);
      }
    });
  }
}

test('wording token status: a data attribute name with an underscore is found', () => {
  assert.deepEqual(findingLines(`<p data-${EXTERNAL}_${REVIEW}="complete">x</p>`), [1]);
});

test('wording token status: emphasis around the second word inside a comment is found', () => {
  assert.deepEqual(findingLines(`<!-- The ${EXTERNAL}**${REVIEW}** is complete. -->`), [1]);
});

test('wording token status: existing plain status and the approved clause inside comments and attributes are found', () => {
  for (const phrase of [`The ${EXTERNAL} ${REVIEW} is complete.`, `${HOLD}.`]) {
    for (const token of [(value) => `<!-- ${value} -->`, (value) => `<p title="${value}">x</p>`]) assert.deepEqual(findingLines(token(phrase)), [1]);
  }
});

test('wording token status: multiline comments and quoted attributes keep the first paragraph line', () => {
  for (const text of [`<!--\n\n${EXTERNAL}_${REVIEW}: complete\n-->`, `<img alt="\n\n${EXTERNAL}_${REVIEW}: complete">`]) {
    assert.deepEqual(findingLines(`Intro.\r\n\r\n${text}`), [3]);
  }
});

test('wording token status: tokens in decoded JSON strings are checked at the literal line', () => {
  const text = JSON.stringify({ description: `<img alt="${EXTERNAL}_${REVIEW}: complete">` }, null, 2);
  assert.deepEqual(findingLines(text, 'manifest.json'), [2]);
});

test('wording token status: rendered approved prose, negative disclaimers, camelCase names and source files still pass', () => {
  for (const text of [`<p>${HOLD}.</p>`, `<!-- Not a ${SECURITY} ${REVIEW}. -->`, `<img alt="Not a ${SECURITY} ${REVIEW}.">`, `<img alt="${EXTERNAL}Review: false">`]) {
    assert.deepEqual(findingLines(text), [], text);
  }
  for (const extension of ['js', 'mjs', 'ts', 'jsx']) assert.deepEqual(findingLines(`<img alt="${EXTERNAL}_${REVIEW}: complete">`, `a.${extension}`), []);
});
