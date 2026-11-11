import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const gaps = [
  ['space', ' '], ['underscore', '_'], ['emphasis', '**'], ['backtick', '`'], ['soft hyphen', '\u00ad'], ['zero-width space', '\u200b'],
  ['no-break space reference', '&nbsp;'], ['escaped underscore', '\\_'], ['escaped emphasis', '\\*'], ['escaped hyphen', '\\-'],
];

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

for (const [label, lineBreak] of [['line feed', '\n'], ['carriage return', '\r'], ['CRLF', '\r\n']]) {
  test(`wording token status: a link title with an escaped ${label} between the words is found`, () => {
    for (const kind of [EXTERNAL, SECURITY]) {
      assert.deepEqual(findingLines(`Intro.\n\n[label](u "${kind}\\${lineBreak}${REVIEW}: done")\n`, 'a.md'), [3]);
    }
  });

  test(`wording token status: a reference title with an escaped ${label} between the words is found`, () => {
    for (const kind of [EXTERNAL, SECURITY]) {
      assert.deepEqual(findingLines(`Intro.\n\n[label]: u "${kind}\\${lineBreak}${REVIEW}: done"\n`, 'a.md'), [3]);
    }
  });
}

test('wording token status: a reference title in single quotes is found across an escaped line break, a blank line ends it, and a backslash with no open title joins nothing', () => {
  assert.deepEqual(findingLines(`Intro.\n\n[label]: u '${EXTERNAL}\\\n${REVIEW}: done'\n`, 'a.md'), [3]);
  assert.deepEqual(findingLines(`Intro.\n\n[label]: u "${EXTERNAL}\\\n\n${REVIEW}: done"\n`, 'a.md'), []);
  assert.deepEqual(findingLines(`Intro.\n\n[label]: C:\\tools\\\n${EXTERNAL}\n${REVIEW}: done\n`, 'a.md'), [3]);
});

for (const [label, lineBreak] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`wording token status: a comment that opens on the last line of a continued reference title is found (${label})`, () => {
    const text = `Intro.${lineBreak}${lineBreak}[a]: u "x\\${lineBreak}y" <!--${lineBreak}${SECURITY} ${REVIEW} passed -->${lineBreak}`;
    assert.deepEqual(findingLines(text, 'a.md'), [3]);
  });

  test(`wording token status: a link title that opens on the last line of a continued reference title is found (${label})`, () => {
    const text = `Intro.${lineBreak}${lineBreak}[a]: u "x\\${lineBreak}y" [l](v "${lineBreak}${SECURITY} ${REVIEW} passed")${lineBreak}`;
    assert.deepEqual(findingLines(text, 'a.md'), [3]);
  });
}

test('wording token status: a link title with a backslash at the end of a line and no review words is not found', () => {
  assert.deepEqual(findingLines('[label](u "first\\\nsecond")', 'a.md'), []);
});

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

test('wording token status: a link destination, reference definition, src or href value, autolink or reference label holding the words is found, as in plain text', () => {
  for (const name of [`${SECURITY}-${REVIEW}.md`, `${EXTERNAL}_${REVIEW}.png`]) {
    for (const text of [`[doc](docs/${name})`, `[doc]: docs/${name}`, `<img src="${name}">`, `<a href="https://example.com/${name}">x</a>`, `<https://example.com/${name}>`, `[${name}]: https://example.com`]) {
      assert.deepEqual(findingLines(text), [1], text);
    }
    assert.deepEqual(findingLines(`See docs/${name}.`), [1]);
  }
});

test('wording token status: a paragraph of a million short markup tokens is read within a small heap and still finds a status after them', () => {
  const module = new URL('../../scripts/public-gate/rules-text.mjs', import.meta.url).href;
  const code = `import { createWordingMatcher, scanWording } from ${JSON.stringify(module)};
    const matcher = createWordingMatcher(['zzz entry'], () => {});
    const read = (text) => scanWording({ entries: [{ path: 'a.md', bytes: Buffer.from(text), oid: 'a'.repeat(40), position: 1 }], wordingMatcher: matcher, limits: { maxReportEntries: 100 } }).length;
    console.log(JSON.stringify([read(']'.repeat(1 << 21)), read('<!-- a -->'.repeat(1 << 18)), read(']'.repeat(1 << 20) + '<!-- ${EXTERNAL}_${REVIEW}: complete -->')]));`;
  const output = execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output.trim(), '[0,0,1]');
});

test('wording token status: a multi-word list entry is not matched across an underscore, emphasis or backtick in a paragraph that holds markup', () => {
  const entryMatcher = createWordingMatcher(['listed entry'], () => {});
  const listLines = (text, name) => scanWording({
    entries: [{ path: name, bytes: Buffer.from(text), oid: 'b'.repeat(40), position: 1 }], wordingMatcher: entryMatcher, limits,
  }).map(({ line }) => line);
  for (const markup of ['<b>x</b>', '[a](u)', '&amp;', '\\.']) {
    for (const gap of ['_', '*', '`']) assert.deepEqual(listLines(`listed${gap}entry ${markup}`, 'a.md'), [], `${gap} ${markup}`);
    assert.deepEqual(listLines(`listed entry ${markup}`, 'a.md'), [1], markup);
  }
  assert.deepEqual(listLines(JSON.stringify({ note: 'listed_entry <b>x</b>' }), 'manifest.json'), []);
  assert.deepEqual(listLines(JSON.stringify({ note: 'listed entry <b>x</b>' }), 'manifest.json'), [1]);
});

test('wording token status: rendered approved prose, negative disclaimers, camelCase names and source files still pass', () => {
  for (const text of [`<p>${HOLD}.</p>`, `<!-- Not a ${SECURITY} ${REVIEW}. -->`, `<img alt="Not a ${SECURITY} ${REVIEW}.">`, `<img alt="${EXTERNAL}Review: false">`]) {
    assert.deepEqual(findingLines(text), [], text);
  }
  for (const extension of ['js', 'mjs', 'ts', 'jsx']) assert.deepEqual(findingLines(`<img alt="${EXTERNAL}_${REVIEW}: complete">`, `a.${extension}`), []);
});
