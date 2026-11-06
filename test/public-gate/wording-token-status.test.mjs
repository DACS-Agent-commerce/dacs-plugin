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

test('wording token status: existing plain status and the approved clause inside comments and attributes are found', () => {
  for (const phrase of [`The ${EXTERNAL} ${REVIEW} is complete.`, `${HOLD}.`]) {
    for (const token of [(value) => `<!-- ${value} -->`, (value) => `<p title="${value}">x</p>`]) assert.deepEqual(findingLines(token(phrase)), [1]);
  }
});

test('wording token status: rendered approved prose, negative disclaimers, camelCase names and source files still pass', () => {
  for (const text of [`<p>${HOLD}.</p>`, `<!-- Not a ${SECURITY} ${REVIEW}. -->`, `<img alt="Not a ${SECURITY} ${REVIEW}.">`, `<img alt="${EXTERNAL}Review: false">`]) {
    assert.deepEqual(findingLines(text), [], text);
  }
  for (const extension of ['js', 'mjs', 'ts', 'jsx']) assert.deepEqual(findingLines(`<img alt="${EXTERNAL}_${REVIEW}: complete">`, `a.${extension}`), []);
});
