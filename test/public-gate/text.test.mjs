import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createWordingMatcher, hasValidTextConfig, scanIssues, scanReports, scanWording, wordingEntryLines } from '../../scripts/public-gate/rules-text.mjs';
import {
  CONFIG_FILE, REPO_ROOT, completeArgs, createAnnotatedTag, createHistory, createRepo, gateArgs, git, historyArgs, makeTempDir, runCheckReport, runGate, runHistory, sha256, walkFiles, writeList,
} from '../lib/gate-fixtures.mjs';

const CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
const LIMITS = CONFIG.limits;
const OID = 'b'.repeat(40);
/** The tests write a number sign as `@`, so no line of this file reads as an issue reference. */
const h = (text) => text.replaceAll('@', '#');
const file = (name, text, oid = OID) => ({ path: name, bytes: Buffer.from(text), oid, position: 1 });
const { owner: ORG, repositories: PUBLIC_REPOS } = CONFIG.publicRepositories;
const UNLISTED_REPO = ['no', 'such', 'repo'].join('-');
const [OTHER_OWNER, OTHER_REPO] = [['some', 'one'].join(''), ['any', 'thing'].join('')];

// ---- R-REPORT -------------------------------------------------------------------------------------------------------

const reportFindings = (name, text) => scanReports({ entries: [file(name, text)], limits: LIMITS });

test('reports: a working-report file name or a working-notes directory fails', () => {
  const failing = ['FIX-REPORT.md', 'docs/pr-report.md', 'a/b/Progress.md', '.fix-tmp/body.md', 'x/.stack/notes.txt', '.stack/PACK.md'];
  for (const name of failing) {
    const findings = reportFindings(name, 'text\n');
    assert.deepEqual(findings.map(({ rule, kind }) => [rule, kind]), [['R-REPORT', 'path']], name);
  }
  for (const name of ['docs/progress-notes.md', 'README.md', 'stack/a.md', 'a.fix-tmp.md']) assert.deepEqual(reportFindings(name, 'text\n'), [], name);
});

const MARKERS = [['frozen', 'input'], ['canonical', 'snapshot'], ['review', 'round']];
const headerFindings = (text, name = 'doc.md') => reportFindings(name, text);

test('reports: a Markdown file with a frozen-input, canonical-snapshot or review-round header fails', () => {
  for (const [first, second] of MARKERS) {
    const title = `${first[0].toUpperCase()}${first.slice(1)} ${second}`;
    for (const text of [`# ${title}: 3c20053\n`, `## ${title} (abc1234)\n`, `# ${title}\n`, `Intro\n\n${title}\n=====\n`, `---\n${first}-${second}: abc\n---\n# Doc\n`,
      `**${title}:** abc1234\n`, `## 2. ${title} 3\n`, `# ${first}_${second} 4\n`]) {
      assert.deepEqual(headerFindings(text).map(({ rule, kind }) => [rule, kind]), [['R-REPORT', 'content']], JSON.stringify(text));
    }
  }
  assert.equal(headerFindings('# Intro\n\n## Review round 3\n').at(0).line, 3);
});

test('reports: a heading that only starts with the words, a header past the first twenty lines and a file that is not Markdown pass', () => {
  assert.deepEqual(headerFindings('# Review-round headers\n\nBody.\n'), []);
  assert.deepEqual(headerFindings('# Review rounds in general\n'), []);
  assert.deepEqual(headerFindings(`${'line\n'.repeat(20)}# Review round 3\n`), []);
  assert.deepEqual(headerFindings('# Review round 3\n', 'doc.txt'), []);
});

// ---- R-ISSUE --------------------------------------------------------------------------------------------------------

const issueFindings = (name, text, config = CONFIG, oid = OID) => scanIssues({ entries: [file(name, text, oid)], config, limits: LIMITS });

const FAILING_REFERENCES = [
  'PR @12', 'PR@12', 'issue @12', 'issue@12', 'name@12', '`@12`', '**@12**', '|@12|', '>@12<', '{@12}', 'ab@1', 'see @888', "'item @1'", '[@12](../../pull/12)',
  '@12/@13', 'PR @12/13', '<td>@12</td>', 'Background: @142', 'Background: @142 added the first cache.', '- Border: @12 moved the check.', '// Background: @142 added this guard.',
  'background: @142 added the cache', '- --wording-list: the list file (added in @12)', '**Background:** the first attempt is in @142.', '// fill: see @12',
  '/* Border: @12 moved the check. */', 'content: "color: fixed in @12";', 'content: "fixed in @12";', '/* workaround for @12 */', '/* background: @12 */',
  'accent-color: @12;', '<style>.x::after{content:"see @12"}</style>', 'color: red; see @12',
];
const PASSING_REFERENCES = [
  'color:@888', 'border:1px solid @8884', '--ok: @116329', '&@39;', 'PKCS @12', 'PKCS@12', '<hex@1>', 'page.html@12', 'notes.md@3', 'docs/a.md@12', 'https://example.com/a@12',
  '[x](@12)', 'href="@3"', '"color: @12"', '/* background: @12; */', 'a { background: @12 }', 'fill="@12"', '<meta name="theme-color" content="@123">', 'style="accent-color:@12"',
  'box-shadow: 0 0 2px @888;', 'version@1.2', 'see @abc',
];

test('issue references: a bare #n in prose, a fenced example, a code comment or an executable string literal fails; owner/repo#n for a listed public repository, colours and fragments pass; each of F’s six upstream deprecation-metadata links passes only its exact disposition after the owner accepts OWNER-LINKS; without that decision it remains a finding, and an altered or additional occurrence fails', () => {
  for (const name of ['a.md', 'a.css', 'a.mjs']) {
    for (const line of FAILING_REFERENCES) assert.equal(issueFindings(name, h(`${line}\n`)).length, 1, `${name}: ${line}`);
    for (const line of PASSING_REFERENCES) assert.deepEqual(issueFindings(name, h(`${line}\n`)), [], `${name}: ${line}`);
  }
  assert.equal(issueFindings('a.css', h('/*\n * ref: @12\n */\n.x::after { content: "see: @12"; }\n')).length, 2);
  assert.equal(issueFindings('a.md', h('The inline `<style>` element was added in @12.\nIt ends at `</style>`.\n')).length, 1);
  assert.equal(issueFindings('a.md', h('```js\n// see @12\n```\n')).length, 1);
  assert.equal(issueFindings('a.md', h('PR @12 and issue @13 and @14\n'))[0].line, 1);
  assert.deepEqual(issueFindings('a.md', h(`${ORG}/${PUBLIC_REPOS[0]}@12 and ${ORG.toUpperCase()}/${PUBLIC_REPOS[1].toUpperCase()}@3\n`)), []);
  for (const bad of [`${ORG}/${UNLISTED_REPO}@12`, `other/${PUBLIC_REPOS[0]}@12`, `${ORG}/${PUBLIC_REPOS[0]}-x@12`]) assert.equal(issueFindings('a.md', h(`${bad}\n`)).length, 1, bad);
});

test('issue references: a link to a repository of the organisation that is not on the public list fails', () => {
  const [listed] = PUBLIC_REPOS;
  const failing = [
    `https://github.com/${ORG}/${UNLISTED_REPO}`, `http://github.com/${ORG}/${UNLISTED_REPO}/blob/main/a`, `github.com/${ORG}/${UNLISTED_REPO}`, `www.github.com/${ORG}/${UNLISTED_REPO}`,
    `git@github.com:${ORG}/${UNLISTED_REPO}.git`, `ssh://git@github.com/${ORG}/${UNLISTED_REPO}`, `https://raw.githubusercontent.com/${ORG}/${UNLISTED_REPO}/main/a`,
    `https://api.github.com/repos/${ORG}/${UNLISTED_REPO}/pulls`, `https:\\/\\/github.com\\/${ORG}\\/${UNLISTED_REPO}`, `https://github.com/${ORG.toLowerCase()}/${UNLISTED_REPO.toUpperCase()}`,
    `https://github.com/${ORG}/${listed}-x`, `(see https://github.com/${ORG}/${UNLISTED_REPO}).`,
    `https://github.com/${ORG}/${UNLISTED_REPO}/issues/7`, `https://github.com/${OTHER_OWNER}/${listed}/pull/7`, `https://github.com/${OTHER_OWNER}/${OTHER_REPO}/pulls`, `https://github.com/${OTHER_OWNER}/${OTHER_REPO}/discussions/9`,
  ];
  for (const link of failing) assert.equal(issueFindings('a.md', `${link}\n`).length, 1, link);
  const passing = [`https://github.com/${ORG}/${listed}`, `git@github.com:${ORG}/${listed}.git`, `https://github.com/${ORG}/${listed}/issues/7`, `https://github.com/${ORG.toUpperCase()}/${listed.toUpperCase()}/pull/3`,
    `https://github.com/${ORG}`, `https://github.com/orgs/${ORG}/discussions`, `https://github.com/${OTHER_OWNER}/${OTHER_REPO}`, `https://example.com/${ORG}/${UNLISTED_REPO}`];
  for (const link of passing) assert.deepEqual(issueFindings('a.md', `${link}\n`), [], link);
});

test('issue references: a number sign after a dotted repository of the organisation is a reference, not a file fragment', () => {
  const dotted = ['private', 'repo'].join('.');
  const config = { ...CONFIG, publicRepositories: { owner: ORG, repositories: [...PUBLIC_REPOS, 'listed.repo', 'listed.js'] } };
  for (const bad of [`${ORG}/${dotted}@12`, `${ORG.toUpperCase()}/${dotted}@12`, `${ORG}/${dotted}.md@12`, `${ORG}/${dotted}.js@12`, `${ORG}/listed.repo-x@12`, `see ${ORG}/${dotted}@12.`]) {
    assert.equal(issueFindings('a.md', h(`${bad}\n`), config).length, 1, bad);
  }
  for (const good of [`${ORG}/listed.repo@12`, `${ORG.toUpperCase()}/LISTED.JS@12`, `${OTHER_OWNER}/${dotted}@12`, `${OTHER_OWNER}/page.html@12`, `docs/${ORG}/${dotted}.md@12`]) {
    assert.deepEqual(issueFindings('a.md', h(`${good}\n`), config), [], good);
  }
  assert.equal(issueFindings('a.md', `https://github.com/${ORG}/${dotted}\n`, config).length, 1);
});

const LOCKFILE_PATHS = ['stdio-mcp/package-lock.json', 'http-mcp/wallet-build/package-lock.json'];
const DEPRECATED_VALUE_SHA256 = {
  ics23: '73db8b1fb39b70e63f1b64d8d5a7d41f7873b8d4fa8a5455f8955bfae5d3829e', crypto: '1ae46a6eb64871e470bbe6cda47a9676f54ec6d7b8ada88c01f69da140130fb6',
  request: '2520e437d9b0330c48889295afc16ae18dfa95fecadaea9b1952ae79716c263c',
};
const DISPOSITION_REASON = 'upstream deprecation notice copied by npm into the lockfile; not written here';
const lockfileRow = (lockfilePath, blob, name, line, value) => ({
  path: lockfilePath, blob, field: `packages["node_modules/${name}"].deprecated`, line, valueSha256: DEPRECATED_VALUE_SHA256[value], reason: DISPOSITION_REASON,
});
const SIX_DISPOSITIONS = [
  lockfileRow(LOCKFILE_PATHS[0], '2d064ce7cbe3858df1f04b34157864c444aa6ae9', '@confio/ics23', 1167, 'ics23'),
  lockfileRow(LOCKFILE_PATHS[0], '2d064ce7cbe3858df1f04b34157864c444aa6ae9', '@cosmjs/crypto', 1295, 'crypto'),
  lockfileRow(LOCKFILE_PATHS[0], '2d064ce7cbe3858df1f04b34157864c444aa6ae9', 'request', 15700, 'request'),
  lockfileRow(LOCKFILE_PATHS[1], '3eb3a13163a28d7612ec08546d84a8261ef90ca3', '@confio/ics23', 1139, 'ics23'),
  lockfileRow(LOCKFILE_PATHS[1], '3eb3a13163a28d7612ec08546d84a8261ef90ca3', '@cosmjs/crypto', 1267, 'crypto'),
  lockfileRow(LOCKFILE_PATHS[1], '3eb3a13163a28d7612ec08546d84a8261ef90ca3', 'request', 15590, 'request'),
];

function realLockfiles() {
  return LOCKFILE_PATHS.map((lockfilePath, position) => {
    const absolute = path.join(REPO_ROOT, lockfilePath);
    return { path: lockfilePath, bytes: readFileSync(absolute), oid: execFileSync('git', ['hash-object', absolute], { encoding: 'utf8' }).trim(), position: position + 1 };
  });
}

test('issue references: the six upstream lockfile links pass only their exact dispositions in the committed lockfiles', () => {
  assert.deepEqual(CONFIG.lockfileDispositions, SIX_DISPOSITIONS);
  const entries = realLockfiles();
  assert.deepEqual(entries.map(({ oid }) => oid), [SIX_DISPOSITIONS[0].blob, SIX_DISPOSITIONS[3].blob]);
  assert.deepEqual(scanIssues({ entries, config: CONFIG, limits: LIMITS }), []);
  assert.equal(scanIssues({ entries, config: { ...CONFIG, lockfileDispositions: [] }, limits: LIMITS }).length, 6);
  const changed = { path: 'other/package-lock.json', blob: 'c'.repeat(40), field: 'packages["node_modules/other"].deprecated', line: 2, valueSha256: 'd'.repeat(64) };
  SIX_DISPOSITIONS.forEach((row, index) => {
    for (const [name, value] of Object.entries(changed)) {
      const lockfileDispositions = SIX_DISPOSITIONS.map((candidate, at) => (at === index ? { ...candidate, [name]: value } : candidate));
      assert.equal(scanIssues({ entries, config: { ...CONFIG, lockfileDispositions }, limits: LIMITS }).length, 1, `${name} of entry ${index}`);
    }
  });
});

const LOCK_PATH = 'sub/package-lock.json';
const FIXTURE_DEPRECATION = `use the fixed release, see https://github.com/other/${PUBLIC_REPOS[0]}/issues/7`;
const lockfileText = (extraPackages = {}, deprecated = FIXTURE_DEPRECATION) => `${JSON.stringify({
  lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/old': { version: '1.0.0', deprecated }, ...extraPackages },
}, null, 2)}\n`;
const deprecatedLine = (text) => text.split('\n').findIndex((line) => line.includes('"deprecated"')) + 1;
const fixtureRow = (text, over = {}) => ({
  path: LOCK_PATH, blob: OID, field: 'packages["node_modules/old"].deprecated', line: deprecatedLine(text), valueSha256: sha256(FIXTURE_DEPRECATION), reason: 'fixture', ...over,
});
const lockfileFindings = (text, rows, oid = OID) => issueFindings(LOCK_PATH, text, { ...CONFIG, lockfileDispositions: rows }, oid);

test('issue references: a changed line, blob, field or value fails, an extra occurrence fails and an empty array fails every occurrence', () => {
  const text = lockfileText();
  assert.deepEqual(lockfileFindings(text, [fixtureRow(text)]), []);
  for (const over of [{ line: deprecatedLine(text) + 1 }, { blob: 'c'.repeat(40) }, { field: 'packages["node_modules/new"].deprecated' }, { valueSha256: sha256('other') }, { path: 'x/package-lock.json' }]) {
    assert.equal(lockfileFindings(text, [fixtureRow(text, over)]).length, 1, JSON.stringify(over));
  }
  assert.equal(lockfileFindings(text, [fixtureRow(text)], 'e'.repeat(40)).length, 1);
  assert.equal(lockfileFindings(text, []).length, 1);
  const other = `see https://github.com/other/${PUBLIC_REPOS[0]}/issues/8`;
  const twoLinks = lockfileText({ 'node_modules/more': { version: '2.0.0', deprecated: other } });
  assert.deepEqual(lockfileFindings(twoLinks, [fixtureRow(twoLinks)]).map(({ line }) => line), [deprecatedLine(twoLinks) + 4]);
  const outsideDeprecated = lockfileText({ 'node_modules/more': { version: '2.0.0', description: FIXTURE_DEPRECATION } });
  assert.equal(lockfileFindings(outsideDeprecated, [fixtureRow(outsideDeprecated)]).length, 1);
});

test('issue references: a malformed publicRepositories or lockfileDispositions section is invalid configuration', () => {
  assert.equal(hasValidTextConfig(CONFIG), true);
  const row = SIX_DISPOSITIONS[0];
  const invalid = [
    { publicRepositories: undefined }, { publicRepositories: { owner: 'a b', repositories: ['x'] } }, { publicRepositories: { owner: ORG, repositories: 'x' } },
    { publicRepositories: { owner: ORG, repositories: ['x', 'x'] } }, { publicRepositories: { owner: ORG, repositories: [''] } }, { publicRepositories: { owner: ORG, repositories: ['a/b'] } },
    { lockfileDispositions: undefined }, { lockfileDispositions: [row, row] }, { lockfileDispositions: [{ ...row, reason: '' }] }, { lockfileDispositions: [{ ...row, blob: 'xyz' }] },
    { lockfileDispositions: [{ ...row, valueSha256: 'abc' }] }, { lockfileDispositions: [{ ...row, line: 0 }] }, { lockfileDispositions: [{ ...row, line: 1.5 }] },
    { lockfileDispositions: [{ ...row, path: 'a/b.json' }] }, { lockfileDispositions: [{ ...row, field: undefined }] }, { lockfileDispositions: [{ ...row, extra: 1 }] },
  ];
  for (const change of invalid) assert.equal(hasValidTextConfig({ ...CONFIG, ...change }), false, JSON.stringify(change));
});

const LOCKFILE_STALE_ENTRY = { path: SIX_DISPOSITIONS[0].path, content: '{}\n' };

test('issue references: a lockfile held at another blob than its disposition stops the run, and a tree without the lockfile path does not', () => {
  const stale = runGate(gateArgs(createRepo([LOCKFILE_STALE_ENTRY]), 'generic'));
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /^stale-lockfile-disposition: /);
  assert.equal(runGate(gateArgs(createRepo([{ path: 'a.txt', content: 'a\n' }]), 'generic')).status, 0);
  const history = createHistory([{ files: { [LOCKFILE_STALE_ENTRY.path]: LOCKFILE_STALE_ENTRY.content } }]);
  const staleHistory = runHistory(historyArgs(history, writeList(['private-entry'])));
  assert.equal(staleHistory.status, 2);
  assert.match(staleHistory.stderr, /^stale-lockfile-disposition: /);
});

// ---- R-WORDING ------------------------------------------------------------------------------------------------------

const TERM = ['flarn', 'quux'].join(' ');
const [FIRST, SECOND] = TERM.split(' ');
const TOOL = ['zorp', 'lint'].join('-');
const SNAKE = ['snake', 'case', 'entry'].join('_');
const SPACED = ['two', 'spaces'].join('  ');
const REVIEW = ['security', 'review'].join(' ');
const HOLD = `The external ${REVIEW} is on hold`;
const matcher = createWordingMatcher([TERM, TOOL, SNAKE, SPACED], () => {});
const wordingFindings = (name, text) => scanWording({ entries: [file(name, text)], wordingMatcher: matcher, limits: LIMITS });
const findingLines = (name, text, list = [TERM]) => scanWording({ entries: [file(name, text)], wordingMatcher: createWordingMatcher(list, () => {}), limits: LIMITS }).map(({ line }) => line);

test('wording: the prohibited vocabulary in prose, a skill, a command file or a manifest description fails; an internal review-tool name fails', () => {
  for (const name of ['README.md', 'docs/a.txt', 'skills/demo/SKILL.md', 'commands/demo.md', 'notes.yml', 'LICENSE']) {
    assert.deepEqual(wordingFindings(name, `Intro.\n\nThis mentions ${TERM} here.\n`).map(({ rule, kind, line }) => [rule, kind, line]), [['R-WORDING', 'content', 3]], name);
    assert.equal(wordingFindings(name, `Uses ${TOOL.toUpperCase()} daily.\n`).length, 1, name);
  }
  const manifest = JSON.stringify({ name: 'demo', description: `A demo with ${TERM}`, nested: { list: ['fine', `and ${TOOL}`] } }, null, 2);
  assert.deepEqual(wordingFindings('.claude-plugin/plugin.json', manifest).map(({ line }) => line), [3, 7]);
  assert.equal(wordingFindings('broken.json', `{ "description": "${TERM}", `).length, 1);
  assert.equal(wordingFindings('page.html', `<p>About <b>${FIRST}</b> ${SECOND}</p>`).length, 1);
  assert.equal(wordingFindings('page.html', `<img alt="${TERM}" src="x.png">`).length, 1);
});

test('wording: an HTML comment, a tag or an attribute between or inside the words of an entry hides nothing, whatever it holds', () => {
  for (const note of ['x', 'ordinary note', 'a > b', `${FIRST}-${SECOND}`]) {
    for (const page of [`<p>${FIRST}<!-- ${note} --> ${SECOND}</p>`, `<p>${FIRST}<span title="${note}"> ${SECOND}</span></p>`, `<p>${FIRST} <span data-x='${note}'>${SECOND}</span></p>`]) {
      for (const name of ['page.html', 'a.md']) assert.deepEqual(findingLines(name, page), [1], `${name}: ${page}`);
    }
  }
  for (const page of [`${FIRST.slice(0, 2)}<b>${FIRST.slice(2)}</b> ${SECOND}`, `<p>${FIRST}<span\n  class="x"> ${SECOND}</span></p>`, `${FIRST.slice(0, 2)}<span\nclass="x"\n>${FIRST.slice(2)} ${SECOND}`,
    `${FIRST}<!-- one\n\ntwo --> ${SECOND}`]) {
    assert.deepEqual(findingLines('page.html', page), [1], page);
  }
  for (const page of [`<!-- ${TERM} -->`, `<p title="${TERM}">x</p>`, `<img alt="${TERM}">`, `<p aria-label="${TERM}">x</p>`, `<p aria-label='${FIRST}\n${SECOND}'>x</p>`, `<input value=${FIRST}&nbsp;${SECOND}>`]) {
    assert.deepEqual(findingLines('page.html', page), [1], page);
  }
});

test('wording: a Markdown link, image, reference, escape, block quote or inline HTML between the words of an entry hides nothing', () => {
  for (const text of [`${FIRST} [${SECOND}](https://example.com)`, `${FIRST} [${SECOND}][r]\n\n[r]: https://example.com`, `![${FIRST} ${SECOND}](u.png)`, `[${FIRST} [${SECOND}]](u)`,
    `${FIRST} [${SECOND}](<u v> "title")`, `\\*${FIRST}\\* ${SECOND}`, `> ${FIRST}\n> ${SECOND}`, `${FIRST}<!-- x --> ${SECOND}`, `${FIRST}<br>${SECOND}`, `${FIRST}&nbsp;${SECOND}`]) {
    assert.deepEqual(findingLines('a.md', `Intro.\n\n${text}\n`), [3], JSON.stringify(text));
  }
  assert.deepEqual(findingLines('a.md', `[x]: https://example.com/${FIRST}-${SECOND}\n\nfine [x]\n`), []);
});

test('wording: a page of unclosed script starts, comment openers or unmatched angle brackets is read once, and nothing after a script start is hidden', { timeout: 60_000 }, () => {
  assert.deepEqual(wordingFindings('page.html', '<script '.repeat(200_000)), []);
  assert.deepEqual(wordingFindings('page.html', '<'.repeat(1_000_000)), []);
  assert.equal(wordingFindings('page.html', `${'<!--'.repeat(1_000_000)}${TERM}`).length, 1);
  for (const page of [`<p>${TERM}</p><script>var a = 1;`, `<script>var a = 1;<p>${TERM}</p>`, `<script>${TERM}</script>`, `<STYLE>${TERM}</STYLE>`, `<script a="b>c">${TERM}</script>`,
    `<p title="a <script b">x</p><p>${TERM}</p>`, `<p data-x='<script'>${TERM}</p>`, `<!-- <script --><p>${TERM}</p>`, `<p>x</p><!-- never closed ${TERM}`, `<p>x</p><div class="${TERM}`,
    `<p>a < b</p><p>${TERM}</p>`, `<!doctype html><p>${TERM}</p>`, `<![CDATA[ ${TERM} ]]>`, `<p>&lt;script&gt;</p><p>${TERM}</p>`]) {
    assert.equal(wordingFindings('page.html', page).length, 1, page);
  }
});

test('wording: a finding is at the first line of its paragraph, counted in the file; a blank line inside a comment or tag does not end a paragraph', () => {
  assert.deepEqual(findingLines('page.html', `<p\n  title="x"\n>a</p>\n<!-- one\n\ntwo -->\n\n<p>${TERM}</p>`), [8]);
  assert.deepEqual(findingLines('page.html', `<!-- one\n\ntwo ${TERM} -->`), [1]);
  assert.deepEqual(findingLines('a.md', `a\r\n\r\nb\r\n${TERM}\r\n`), [3]);
});

test('wording: only the six known terminated character references are decoded; any other terminated reference is refused at its line', () => {
  assert.deepEqual(findingLines('a.md', 'a &amp; b &lt; c &gt; d &quot; e &#39; f &nbsp; g, a & b, a && b, a &= b\n'), []);
  assert.deepEqual(findingLines('a.md', `${FIRST}&nbsp;${SECOND}\n`), [1]);
  const refused = ['caf&eacute;', '&#233;', '&#xe9;', `${FIRST}&#32;${SECOND}`, '&#x20;', '&#10;', '&#150;', '&#0;', '&#xD800;', '&#1114112;', '&hyphen;', '&constructor;',
    '&copy2;', '&notit;', '&AMP;', '&#039;', '&#;'];
  for (const reference of refused) {
    for (const name of ['a.md', 'page.html', 'a.txt']) assert.deepEqual(findingLines(name, `fine\n\nx ${reference} y\n`, ['unlisted-entry']), [3], `${name}: ${reference}`);
  }
  assert.deepEqual(findingLines('page.html', '<p title="a&hyphen;b">x</p>', ['unlisted-entry']), [1]);
  assert.deepEqual(findingLines('m.json', JSON.stringify({ description: 'a &#32; b' }, null, 2), ['unlisted-entry']), [2]);
});

test('wording: an ampersand that starts neither a numeric nor a legacy named reference is literal outside HTML and SVG blobs', () => {
  const literal = ['R&D', 'AT&T', 'Q&A', 'a&b', '&foo', '&#', '&#x', '&#xyz', '&Copy', '&Nbsp', '&Notit','security&review', '&company=1'];
  for (const reference of literal) {
    for (const name of ['a.md', 'a.txt', 'a.xml', 'LICENSE']) assert.deepEqual(findingLines(name, `fine\n\nx ${reference} y\n`, ['unlisted-entry']), [], `${name}: ${reference}`);
  }
  for (const reference of ['R&D', 'AT&T', 'Q&A', 'a&b', '&foo']) {
    for (const name of ['page.html', 'page.htm', 'page.svg', 'PAGE.HTML', 'PAGE.HTM', 'PAGE.SVG']) assert.deepEqual(findingLines(name, `fine\n\nx ${reference} y\n`, ['unlisted-entry']), [3], `${name}: ${reference}`);
  }
  assert.deepEqual(findingLines('a.md', `${FIRST}&D ${SECOND}`), []);
  assert.deepEqual(findingLines('a.md', 'R&D tool', ['R&D tool']), [1]);
});

test('wording: a numeric reference or a legacy named reference counts without its semicolon, as the longest legacy name that is a prefix of the text', () => {
  const counted = ['caf&eacute', '&#233', '&#xE9', '&#XE9', '&#102larn', '&#x66', '&copy2', '&notit', '&amp', '&#39', 'security&nbspreview', '?x=1&copy=2', '&copyright', '&nbspquux', '&ampere', '&sup2x'];
  for (const reference of counted) {
    for (const name of ['a.md', 'a.txt', 'a.xml', 'LICENSE', 'page.html', 'page.svg']) assert.deepEqual(findingLines(name, `fine\n\nx ${reference} y\n`, ['unlisted-entry']), [3], `${name}: ${reference}`);
  }
});

test('wording: raw HTML in Markdown with a reference without its semicolon is refused at its line', () => {
  assert.deepEqual(findingLines('a.md', '<div>\nflarn&nbspquux\n</div>\n', ['unlisted-entry']), [2]);
  assert.deepEqual(findingLines('a.md', '<p>&#102larn quux</p>\n', ['unlisted-entry']), [1]);
});

test('wording: the legacy name list holds the 106 names HTML5 decodes without a semicolon, and each counts as a prefix', () => {
  const names = ['AElig', 'AMP', 'Aacute', 'Acirc', 'Agrave', 'Aring', 'Atilde', 'Auml', 'COPY', 'Ccedil', 'ETH', 'Eacute', 'Ecirc', 'Egrave', 'Euml', 'GT', 'Iacute', 'Icirc', 'Igrave', 'Iuml',
    'LT', 'Ntilde', 'Oacute', 'Ocirc', 'Ograve', 'Oslash', 'Otilde', 'Ouml', 'QUOT', 'REG', 'THORN', 'Uacute', 'Ucirc', 'Ugrave', 'Uuml', 'Yacute', 'aacute', 'acirc', 'acute', 'aelig',
    'agrave', 'amp', 'aring', 'atilde', 'auml', 'brvbar', 'ccedil', 'cedil', 'cent', 'copy', 'curren', 'deg', 'divide', 'eacute', 'ecirc', 'egrave', 'eth', 'euml', 'frac12', 'frac14',
    'frac34', 'gt', 'iacute', 'icirc', 'iexcl', 'igrave', 'iquest', 'iuml', 'laquo', 'lt', 'macr', 'micro', 'middot', 'nbsp', 'not', 'ntilde', 'oacute', 'ocirc', 'ograve', 'ordf', 'ordm',
    'oslash', 'otilde', 'ouml', 'para', 'plusmn', 'pound', 'quot', 'raquo', 'reg', 'sect', 'shy', 'sup1', 'sup2', 'sup3', 'szlig', 'thorn', 'times', 'uacute', 'ucirc', 'ugrave', 'uml',
    'uuml', 'yacute', 'yen', 'yuml'];
  assert.equal(names.length, 106);
  assert.equal(new Set(names).size, 106);
  for (const name of names) assert.deepEqual(findingLines('a.md', `x &${name}q y\n`, ['unlisted-entry']), [1], name);
});

test('wording: JSON query strings keep literal ampersands in keys and nested values', () => {
  const text = JSON.stringify({ '?x=1&company=2': { urls: ['?x=1&company=2', '?q=R&D&company=AT&T'] } }, null, 2);
  assert.deepEqual(findingLines('.claude-plugin/plugin.json', text, ['unlisted-entry']), []);
});

test('wording: YAML anchors and aliases keep literal ampersands', () => {
  const text = 'defaults: &defaults\n  team: R&D\n  company: AT&T\nbase: &base\n  <<: *defaults\n';
  for (const name of ['manifest.yml', 'manifest.yaml']) assert.deepEqual(findingLines(name, text, ['unlisted-entry']), [], name);
});

test('wording: a YAML anchor that starts with a legacy name is still read as a reference and refused', () => {
  const text = 'defaults: &eth_mainnet\n  team: R&D\nbase: &params\n  <<: *params\n';
  for (const name of ['manifest.yml', 'manifest.yaml']) assert.deepEqual(findingLines(name, text, ['unlisted-entry']), [1, 3], name);
});

test('wording: a JSON query string key or value that starts with a legacy name is still read as a reference and refused', () => {
  const text = JSON.stringify({ '?a=1&param=2': { urls: ['https://example.test/?a=1&region=eu', 'BTC&ETH'] } }, null, 2);
  assert.deepEqual(findingLines('.claude-plugin/plugin.json', text, ['unlisted-entry']), [2, 4, 5]);
});

test('wording: a Markdown link query that starts with a legacy name is still read as a reference and refused', () => {
  assert.deepEqual(findingLines('README.md', 'fine\n\n[docs](https://example.test/page?a=1&section=2)\n', ['unlisted-entry']), [3]);
});

test('wording: a line of a million character references is checked within a small heap, as a blob and as pull-request text', () => {
  const module = new URL('../../scripts/public-gate/rules-text.mjs', import.meta.url).href;
  const code = `import { createWordingMatcher, scanWording, wordingEntryLines } from ${JSON.stringify(module)};
    const matcher = createWordingMatcher(['zzz entry'], () => {});
    const limits = { maxReportEntries: 100 };
    const read = (text) => [scanWording({ entries: [{ path: 'a.md', bytes: Buffer.from(text), oid: 'a'.repeat(40), position: 1 }], wordingMatcher: matcher, limits }).length,
      wordingEntryLines(text, matcher, 100, { readMarkup: true }).length];
    console.log(JSON.stringify([read('&a'.repeat(1 << 20)), read('&a;'.repeat(1 << 20)), read('&amp;'.repeat(1 << 20))]));`;
  const output = execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output.trim(), '[[0,0],[1,1],[0,0]]');
});

test('wording: a source file is not read in any source extension that R-EVAL parses, in any case; Markdown, HTML, SVG and text are', () => {
  for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.d.ts', 'a.d.cts', 'a.d.mts', 'dir/A.JSX', 'dir/A.CTS', 'b.MJS', 'c.Ts', 'a.css', 'a.sh']) {
    assert.deepEqual(wordingFindings(name, `const a = '${TERM}';\n`), [], name);
  }
  for (const name of ['a.md', 'A.MD', 'a.html', 'a.htm', 'a.svg', 'a.txt', 'a.xml', 'a.mdx', 'Makefile']) assert.equal(wordingFindings(name, `${TERM}\n`).length, 1, name);
});

test('wording: an entry split across a line break, with doubled spaces, emphasis or invisible characters, fails; an entry holding emphasis or a doubled space matches the text that holds it', () => {
  for (const text of [`${FIRST}\n${SECOND}`, `${FIRST}   ${SECOND}`, `**${FIRST}** _${SECOND}_`, `${FIRST}\u00a0${SECOND}`, `${FIRST}\u200b ${SECOND}`, `${FIRST}\t${SECOND}`, `${FIRST}\r\n${SECOND}`]) {
    assert.equal(wordingFindings('a.md', text).length, 1, JSON.stringify(text));
  }
  assert.equal(wordingFindings('a.md', `uses ${SNAKE} in text`).length, 1);
  assert.equal(wordingFindings('a.md', `uses ${SNAKE.replaceAll('_', '')} in text`).length, 1);
  assert.equal(wordingFindings('a.md', 'uses two spaces in text').length, 1);
  assert.equal(wordingFindings('a.md', `${FIRST}\n\n${SECOND}`).length, 0);
});

test('wording: an entry that is empty after normalisation or holds a tab is refused as a malformed wording list', () => {
  for (const entry of ['__', '**', '\u200b', 'a\tb']) assert.throws(() => createWordingMatcher([entry], () => {}), { cause: 'wording-list-malformed' }, JSON.stringify(entry));
});

test('wording: only a closed fence whose language is a shell may hold entries; the text after a fence marker, a quoted or unlabelled fence and a fence in HTML are read', () => {
  const command = `run ${TERM}`;
  for (const fence of [`\`\`\`sh\n${command}\n\`\`\``, `~~~bash\n${command}\n~~~`, `\`\`\`\`console\n${command}\n\`\`\`\``, `\`\`\`powershell\n${command}\n\`\`\``, `\`\`\`SH title\n${command}\n\`\`\`\`  `]) {
    assert.deepEqual(wordingFindings('a.md', `Before.\n\n${fence}\n\nAfter.\n`), [], fence);
  }
  for (const fence of [`\`\`\`\n${command}\n\`\`\``, `\`\`\`text\n${command}\n\`\`\``, `\`\`\`sh\n${command}\n`, `\`\`\`\n$ ${command}\n> more\n\`\`\``, `\`\`\`\n> ${command}\n\`\`\``,
    `\`\`\`sh ${TERM}\nls\n\`\`\``, `~~~sh\n${command}\n\`\`\``, `\`\`\`sh\`\`\`\n${command}\n\`\`\``, `<div>\n\`\`\`sh\n${command}\n\`\`\`\n</div>`, `<!--\n\`\`\`sh\n-->\n${command}\n\`\`\``]) {
    assert.equal(wordingFindings('a.md', `Before.\n\n${fence}\n`).length, 1, fence);
  }
  assert.equal(wordingFindings('a.md', `\`\`\`sh\nThe external ${REVIEW} is complete.\n\`\`\`\n`).length, 1);
});

test('wording: a file of many closed fences or a million unclosed fence openers is read once per line and still finds an entry after them', { timeout: 60_000 }, () => {
  for (const pair of ['```\n```\n', '~~~\n~~~\n', '```\n~~~\n']) {
    assert.equal(wordingFindings('a.md', `${pair.repeat(60_000)}\n${TERM}\n`).length, 1, JSON.stringify(pair));
  }
  assert.equal(wordingFindings('a.md', `${'```sh x\n'.repeat(1_000_000)}${TERM}\n`).length, 1);
});

test('wording: a manifest is read by every string literal, so a repeated key\'s earlier value and a key hold nothing back, each at its own line', () => {
  const cases = [
    [`{"description":"${TERM}","description":"safe"}`, [1]],
    [`{\n "a": {\n "d": "${TERM}",\n "d": "ok"\n }\n}`, [3]],
    [`{"flarn\\u0020quux":"x","${TERM}":1}`, [1]],
    [`{"d":"flarn\\u0020quux","d":"ok"}`, [1]],
    [`[{"x":"${TERM}","x":"ok"}]`, [1]],
    [`{"the ${REVIEW} passed": true}`, [1]],
    [`{\n"d": "ok",\n"d": "${TERM}"\r\n}`, [3]],
    [`{"d":"${TERM}"}`, [1]],
    [`{"d":"ok","e":"fine"}`, []],
  ];
  for (const [text, lines] of cases) assert.deepEqual(findingLines('p.json', text), lines, JSON.stringify(text));
});

test('wording: a manifest nested twenty thousand deep or holding a very long array is read without a stack overflow', () => {
  assert.deepEqual(findingLines('deep.json', `${'['.repeat(20_000)}"${TERM}"${']'.repeat(20_000)}`), [1]);
  assert.deepEqual(findingLines('deep.json', `${'{"a":'.repeat(20_000)}"x"${'}'.repeat(20_000)}`), []);
  assert.deepEqual(findingLines('wide.json', JSON.stringify(Array.from({ length: 300_000 }, () => 'x'))), []);
});

test('wording: the actual negative disclaimers, the carried approved status sentences and the held-write executable strings pass', () => {
  const cited = [['OVERNIGHT-PACKAGING.md', 6, 6], ['EMBEDDED-WALLET-TESTER.md', 8, 8], ['TESTER-QUICKSTART.md', 29, 30], ['EMBEDDED-WALLET-TESTER.md', 4, 5], ['OVERNIGHT-CORE.md', 6, 7], ['OVERNIGHT-UI.md', 5, 6]];
  for (const [name, from, to] of cited) {
    const lines = readFileSync(path.join(REPO_ROOT, 'http-mcp/docs', name), 'utf8').split('\n');
    let [first, last] = [from - 1, to - 1];
    while (first > 0 && lines[first - 1].trim() !== '') first -= 1;
    while (last < lines.length - 1 && lines[last + 1].trim() !== '') last += 1;
    assert.deepEqual(wordingFindings(name, lines.slice(first, last + 1).join('\n')), [], `${name}:${from}`);
  }
  const executable = ['http-mcp/src/portal/wallet-rpc.mjs', 'http-mcp/public/portal/embedded-wallet/sdk-provider.mjs', 'http-mcp/public/portal/portal.js', 'http-mcp/public/portal/embedded-wallet/ui.mjs'];
  for (const name of executable) assert.deepEqual(wordingFindings(name, readFileSync(path.join(REPO_ROOT, name), 'utf8')), [], name);
  assert.deepEqual(wordingFindings('a.mjs', `const message = '${TERM}';\n`), []);
  assert.deepEqual(wordingFindings('a.md', `It is **not** a ${REVIEW}, and _not_ ${REVIEW}ed either.\n`), []);
});

test('wording: only the approved status clause passes; a reason, another status or a disclaimer followed by a different status fails, also when markup splits it', () => {
  const passing = [
    `${HOLD}.`, `${HOLD.toLowerCase()}.`, `- ${HOLD}.`, `# ${HOLD}`, `Not a ${REVIEW}. ${HOLD}.`, `Not a ${REVIEW}, not live\nexecution. The\nexternal ${REVIEW} is on\nhold.`,
    `Offline only; ${HOLD.toLowerCase()}.`, `Offline only (${HOLD.toLowerCase()}).`, `Not an independent ${REVIEW}; ${HOLD.toLowerCase()}.`, `It is not ${REVIEW}ed.`, `Not independent-${REVIEW.split(' ')[0]} review.`,
    `${HOLD}. Funding was cut.`, `${HOLD}. ${HOLD}.`, `> ${HOLD}.`,
  ];
  for (const text of passing) assert.deepEqual(wordingFindings('a.md', `${text}\n`), [], JSON.stringify(text));
  const failing = [
    `The external ${REVIEW} is complete.`, `It is ${REVIEW.replace(' ', '-')}ed.`, 'The external review is complete.', `${HOLD} (pending funding).`, `${HOLD}; funding was cut.`, `${HOLD} because funding was cut.`,
    `Offline (${HOLD.toLowerCase()}); funding was cut.`, `Not a ${REVIEW}; the external review is complete.`, `Not a ${REVIEW}, and the external ${REVIEW} is complete.`,
    `Not a ${REVIEW}. It passed ${REVIEW}.`, 'It was security-reviewed.', 'External review: done.',
    `The external [security](https://example.com) review is complete.`, `The external <b>security</b> review is complete.`, `The external ${REVIEW}<!-- x --> is complete.`,
    `The external security&nbsp;review is complete.`,
  ];
  for (const text of failing) assert.equal(wordingFindings('a.md', `${text}\n`).length, 1, JSON.stringify(text));
  assert.deepEqual(wordingFindings('a.md', `Intro.\n\n${failing[0]}\n`).map(({ line }) => line), [3]);
});

test('wording: any dash, white space, emphasis, underscore or invisible character between the words of a status phrase counts as a gap', () => {
  const [SECURITY, EXTERNAL, WORD] = ['security', 'external', REVIEW.split(' ')[1]];
  const failing = [
    ['a.md', `The ${EXTERNAL}-${WORD} is complete.`], ['a.md', `The ${EXTERNAL}__${WORD} is complete.`], ['a.md', `The ${EXTERNAL}–${WORD} is complete.`],
    ['a.md', `The ${EXTERNAL}‑${WORD} is complete.`], ['a.md', `The ${SECURITY}‑${WORD} is complete.`], ['a.md', `The ${SECURITY}‐${WORD} is complete.`],
    ['a.yml', `${EXTERNAL}_${WORD}: complete`], ['a.yml', `${SECURITY}_${WORD}: passed`], ['a.json', `{"${EXTERNAL}_${WORD}": "complete"}`],
    ['a.md', `The **${EXTERNAL}**${WORD} is complete.`], ['a.md', `The ${EXTERNAL}­${WORD} is complete.`], ['a.md', `The ${EXTERNAL} ${SECURITY}-\n${WORD} is complete.`],
    ['a.md', `The ${EXTERNAL}-\n${WORD} is complete.`], ['a.md', `The ${EXTERNAL} ${SECURITY}-${WORD} is on hold.`], ['a.md', `The se**cur**ity ${WORD} is complete.`],
  ];
  for (const [name, text] of failing) assert.equal(wordingFindings(name, `${text}\n`).length, 1, JSON.stringify(text));
  const passing = [
    `Not a ${SECURITY}–${WORD}.`, `Not a ${REVIEW.replace(' ', '-')}.`, `It is _not_ ${SECURITY}‑${WORD}ed.`, `Not an independent–${REVIEW}.`, `**${HOLD}.**`, `_${HOLD}._`,
    `The *${EXTERNAL}* ${REVIEW} is on hold.`, `* ${HOLD}.`, `\`${SECURITY}${WORD[0].toUpperCase()}${WORD.slice(1)}ed\` is \`false\`.`,
  ];
  for (const text of passing) assert.deepEqual(wordingFindings('a.md', `${text}\n`), [], JSON.stringify(text));
});

test('wording: in a blob an entry passes only wholly inside the approved clause or a disclaimer; one that crosses either fails', () => {
  assert.deepEqual(findingLines('a.md', `${HOLD}.\n\nIt is not a ${REVIEW}.\n`, [REVIEW]), []);
  assert.deepEqual(findingLines('a.md', `This is not a ${REVIEW} ${FIRST} today.\n`, [`${REVIEW.split(' ')[1]} ${FIRST}`]), [1]);
  assert.deepEqual(findingLines('a.md', `${HOLD}. Funding was cut.\n`, ['hold. Funding']), [1]);
  assert.deepEqual(findingLines('a.md', `Intro: ${HOLD.toLowerCase()}.\n`, [`intro: ${HOLD.split(' ')[0].toLowerCase()}`]), [1]);
  assert.deepEqual(findingLines('page.html', `<p>Held. ${HOLD}.</p>`, [REVIEW]), []);
});

test('wording: the approved clause passes inside rendered markup', () => {
  for (const page of [`<p>${HOLD}.</p>`, `<p>${HOLD}<!-- x -->.</p>`, `[${HOLD}](u).`, `<p title="Not a ${REVIEW}">${HOLD}.</p>`]) assert.deepEqual(findingLines('page.html', page, ['unlisted-entry']), [], page);
});

test('wording: commit, tag and pull-request text are matched with no exemption, so the approved clause or a disclaimer holding an entry is found', () => {
  const lines = (text, list, readMarkup = false) => wordingEntryLines(text, createWordingMatcher(list, () => {}), 10, { readMarkup });
  assert.deepEqual(lines(`${HOLD}.`, [REVIEW]), [1]);
  assert.deepEqual(lines(`Intro.\n\nThe external ${REVIEW.split(' ')[0]}\n${REVIEW.split(' ')[1]} is on hold.`, [REVIEW]), [3]);
  assert.deepEqual(lines(`It is not a ${REVIEW}.`, [REVIEW]), [1]);
  assert.deepEqual(lines(`${HOLD} pending audit.`, ['hold pending']), [1]);
  assert.deepEqual(lines(`${FIRST} [${SECOND}](u)`, [TERM]), []);
  assert.deepEqual(lines(`${FIRST} [${SECOND}](u)`, [TERM], true), [1]);
  assert.deepEqual(lines(`${FIRST}<!-- x --> ${SECOND}`, [TERM], true), [1]);
});

test('wording: pull-request text is read with the six known character references decoded and any other reference found, as a blob is', () => {
  const lines = (text, list, readMarkup = true) => wordingEntryLines(text, createWordingMatcher(list, () => {}), 10, { readMarkup });
  assert.deepEqual(lines("Acme's tool", ["Acme's tool"]), [1]);
  assert.deepEqual(lines('Acme&#39;s tool', ["Acme's tool"]), [1]);
  assert.deepEqual(lines('Intro.\n\nR&amp;D tool', ['R&D tool']), [3]);
  assert.deepEqual(lines('Acme&#x27;s tool', ["Acme's tool"]), [1]);
  assert.deepEqual(lines('Intro.\n\nfine\nAcme&apos;s tool', ["Acme's tool"]), [4]);
  assert.deepEqual(lines('Acme&#39;s tool', ["Acme's tool"], false), []);
  assert.deepEqual(lines('Acme&#x27;s tool', ["Acme's tool"], false), []);
});

// ---- the list and the CLI -------------------------------------------------------------------------------------------

/** Runs a complete gate whose wording list is `listFile(repo)`. */
const runWithWordingList = (listFile) => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  return runGate(completeArgs(repo, writeList(['private-entry']), ['--wording-list', listFile(repo)]));
};

test('wording list: a list inside the repository, missing, not UTF-8, empty, padded or over a limit is refused with its own cause', () => {
  const written = (content) => () => {
    const file = path.join(makeTempDir('wording'), 'list.txt');
    writeFileSync(file, content);
    return file;
  };
  const cases = [
    [(repo) => { const inside = path.join(repo.dir, 'list.txt'); writeFileSync(inside, `${TERM}\n`); return inside; }, 'wording-list-in-repo'],
    [() => path.join(makeTempDir('none'), 'none.txt'), 'wording-list-unreadable'],
    [written(Buffer.from([0x61, 0xff, 0x0a])), 'wording-list-malformed'], [written('# only a comment\n'), 'wording-list-empty'],
    [written(`${TERM} \n`), 'wording-list-malformed'], [written(`${TERM}\n__\n`), 'wording-list-malformed'],
    [written(Array.from({ length: 2001 }, (_, index) => `entry-${index}`).join('\n')), 'limit:maxWordingEntries'], [written('e'.repeat(65_537)), 'limit:maxWordingListBytes'],
  ];
  for (const [listFile, cause] of cases) {
    const result = runWithWordingList(listFile);
    assert.equal(result.status, 2, cause);
    assert.match(result.stderr, new RegExp(`^${cause}: `), cause);
  }
});

test('wording list: the flag is required in complete scope and refused in generic scope', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const list = writeList(['private-entry']);
  const withoutFlag = runGate(gateArgs(repo, 'complete', ['--private-list', list, '--expected-root', repo.commit]));
  assert.match(withoutFlag.stderr, /^bad-arguments: /);
  const generic = runGate(gateArgs(repo, 'generic', ['--wording-list', writeList([TERM])]));
  assert.match(generic.stderr, /^bad-arguments: /);
  const complete = runGate(completeArgs(repo, list, ['--wording-list', writeList([TERM])]));
  assert.equal(complete.status, 0, complete.stderr);
});

const reportRules = (result) => JSON.parse(result.stdout).findings.map(({ rule }) => rule);

test('history: --pr-text accepts ordinary ampersands in keys and nested values', () => {
  const history = createHistory([{ files: { 'a.md': 'plain\n' }, message: 'plain' }]);
  const prText = path.join(makeTempDir('pr'), 'pr.json');
  writeFileSync(prText, JSON.stringify([{ 'R&D': { title: 'AT&T Q&A', body: 'R&D\n\n?x=1&company=2\n\na&b &foo' } }]));
  const result = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([TERM]), '--pr-text', prText], 'main'));
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(reportRules(result), []);
});

test('history: --pr-text refuses a numeric or legacy named reference without its semicolon, in raw HTML too', () => {
  const history = createHistory([{ files: { 'a.md': 'plain\n' }, message: 'plain' }]);
  for (const body of ['<div>\nflarn&nbspquux\n</div>', '<p>&#102larn quux</p>', 'a &copyright b', 'a &#x66 b']) {
    const prText = path.join(makeTempDir('pr'), 'pr.json');
    writeFileSync(prText, JSON.stringify([{ body }]));
    const result = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([TERM]), '--pr-text', prText], 'main'));
    assert.equal(result.status, 1, `${body}: ${result.stdout || result.stderr}`);
    assert.ok(reportRules(result).length > 0 && reportRules(result).every((rule) => rule === 'R-WORDING'), body);
  }
});

test('wording list: a wording entry in prose is an R-WORDING finding and not an R-PRIVATE one, and the reverse; the report names the list by its digest', () => {
  const repo = createRepo([{ path: 'a.md', content: `uses ${TERM}\n` }, { path: 'b.md', content: 'mentions private-entry\n' }]);
  const result = runGate(completeArgs(repo, writeList(['private-entry']), ['--wording-list', writeList([TERM])]));
  assert.equal(result.status, 1);
  assert.deepEqual(reportRules(result).sort(), ['R-PRIVATE', 'R-WORDING']);
  assert.equal(JSON.parse(result.stdout).scanner.wordingListSha256, sha256(`${TERM}\n`));
  const generic = JSON.parse(runGate(gateArgs(repo, 'generic')).stdout);
  assert.equal(generic.rules.find(({ id }) => id === 'R-WORDING').status, 'not-run');
  assert.equal('wordingListSha256' in generic.scanner, false);
});

test('wording list: a report made under another wording list is refused by check-report as made under another policy', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const report = runGate(completeArgs(repo, writeList(['private-entry']), ['--wording-list', writeList([TERM])]));
  const dir = makeTempDir('check');
  const reportFile = path.join(dir, 'report.json');
  writeFileSync(reportFile, report.stdout);
  const context = { ...JSON.parse(report.stdout).scanner };
  const contextFile = path.join(dir, 'context.json');
  writeFileSync(contextFile, JSON.stringify(context));
  assert.equal(runCheckReport(['--report', reportFile, '--head', repo.commit, '--context', contextFile]).status, 0);
  writeFileSync(contextFile, JSON.stringify({ ...context, wordingListSha256: sha256('another') }));
  const refused = runCheckReport(['--report', reportFile, '--head', repo.commit, '--context', contextFile]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^report-policy-differs: /);
});

test('history: R-WORDING finds an entry in a tree file, in a commit message, in a wrapped commit message, in a tag message and in the pull-request text', () => {
  const [first, second] = TERM.split(' ');
  const history = createHistory([{ files: { 'a.md': 'plain\n' }, message: 'plain' }, { files: { 'a.md': `uses ${TERM}\n` }, message: `${first}\n${second}` }, { files: { 'a.md': 'plain\n' }, message: `mentions ${TERM}` }]);
  createAnnotatedTag(history.dir, 'v1', history.commits[0], { message: `tag about ${TERM}` });
  const prText = path.join(makeTempDir('pr'), 'pr.json');
  writeFileSync(prText, JSON.stringify([{ body: `${first}\n${second}` }]));
  const result = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([TERM]), '--pr-text', prText], 'main,v1'));
  assert.equal(result.status, 1, result.stderr);
  const kinds = JSON.parse(result.stdout).findings.filter(({ rule }) => rule === 'R-WORDING').map(({ kind }) => kind).sort();
  assert.deepEqual(kinds, ['content', 'message', 'message', 'message', 'pr-text']);
  const harmless = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList(['harmless-entry'])], 'main'));
  assert.equal(harmless.status, 0, harmless.stderr);
  assert.equal(JSON.parse(harmless.stdout).scanner.wordingListSha256, sha256('harmless-entry\n'));
});

test('history: with the approved clause holding a listed entry, R-WORDING finds it in an author header, a wrapped commit message, a tag message and the pull-request text', () => {
  const [word, rest] = REVIEW.split(' ');
  const author = { name: HOLD, email: 'someone@example.com' };
  const history = createHistory([{ files: { 'a.md': `${HOLD}.\n` }, message: 'plain' }, { message: `The external ${word}\n${rest} is on hold.`, author }]);
  createAnnotatedTag(history.dir, 'v1', history.commits[0], { message: `${HOLD}.` });
  const prText = path.join(makeTempDir('pr'), 'pr.json');
  writeFileSync(prText, JSON.stringify([{ body: `${HOLD}.` }]));
  const result = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([REVIEW]), '--pr-text', prText], 'main,v1'));
  assert.equal(result.status, 1, result.stderr);
  const kinds = JSON.parse(result.stdout).findings.filter(({ rule }) => rule === 'R-WORDING').map(({ kind }) => kind).sort();
  assert.deepEqual(kinds, ['author', 'message', 'message', 'pr-text']);
});

const ALLOWED = 'Project <project@example.invalid>';
const outputOf = (run) => `${run.stdout}${run.stderr}`;
/** The object id of a commit on `history`'s second commit whose headers after the committer line are `headers`, or of a tag on it (`tag`). */
const rawObject = (history, headers, tag = false) => {
  const [parent] = history.commits.slice(-1);
  const raw = tag
    ? `object ${parent}\ntype commit\ntag t1\ntagger ${ALLOWED} 1700000000 +0000\n${headers}\n\nplain\n`
    : `tree ${git(history.dir, ['rev-parse', `${parent}^{tree}`])}\nparent ${parent}\nauthor ${ALLOWED} 1700000000 +0000\ncommitter ${ALLOWED} 1700000000 +0000\n${headers}\n\nplain\n`;
  return git(history.dir, ['hash-object', '-t', tag ? 'tag' : 'commit', '-w', '--literally', '--stdin'], { input: Buffer.from(raw) });
};
const runOnObject = (history, object, extra = []) => runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([TERM]), ...extra], object));

test('history: a header field that git wraps on lines starting with a space is read joined, so an entry across the fold is found; a blank continuation joins nothing', () => {
  const history = createHistory([{}, {}]);
  const [first, second] = TERM.split(' ');
  const mergetag = `mergetag object ${history.commits[0]}\n type commit\n tag v1\n tagger ${ALLOWED} 1700000000 +0000\n \n a ${first}\n ${second} b`;
  for (const [headers, tag] of [[`x-note ${first}\n ${second}`, false], [`x-note ${first}\n ${second}`, true], [mergetag, false]]) {
    const object = rawObject(history, headers, tag);
    const run = runOnObject(history, object);
    assert.equal(run.status, 1, run.stderr);
    const { findings } = JSON.parse(run.stdout);
    assert.deepEqual(findings, [{ rule: 'R-WORDING', kind: 'header', commit: object, location: `${object}:header` }], JSON.stringify(headers));
    assert.ok(!outputOf(run).includes(TERM));
  }
  const blank = runOnObject(history, rawObject(history, `x-note ${first}\n \n ${second}`));
  assert.equal(blank.status, 0, blank.stderr);
  const folded = runOnObject(history, rawObject(history, 'x-note a\n b'), ['--allowed-identity', ALLOWED]);
  assert.equal(folded.status, 0, folded.stderr);
});

test('history: a manifest whose earlier value of a repeated key held an entry in an early commit is found though a later commit removes the file', () => {
  const history = createHistory([{}, { files: { 'plugin.json': `{"description":"${TERM}","description":"safe"}` } }, { files: { 'a.txt': 'ok\n' } }]);
  const run = runHistory(historyArgs(history, writeList(['private-entry']), ['--wording-list', writeList([TERM])]));
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).findings, [{ rule: 'R-WORDING', kind: 'content', commit: history.commits[1], location: `${history.commits[1]}:1`, line: 1 }]);
  assert.ok(!outputOf(run).includes(TERM));
});

test('self-scan: the gate\'s own sources, tests and docs have no finding under an invented list used as both lists, and a joined entry in a comment is found', () => {
  const own = ['scripts/public-gate', 'test/public-gate', 'docs'].flatMap(walkFiles);
  const list = writeList([TERM]);
  const files = own.map((name) => ({ path: path.relative(REPO_ROOT, name), content: readFileSync(name) }));
  const clean = runGate(completeArgs(createRepo(files), list, ['--wording-list', list]));
  assert.equal(clean.status, 0, clean.stdout);
  const planted = runGate(completeArgs(createRepo([...files, { path: 'scripts/public-gate/planted.mjs', content: `// ${TERM}\n` }]), list, ['--wording-list', list]));
  assert.equal(planted.status, 1);
  assert.deepEqual(reportRules(planted), ['R-PRIVATE']);
});
