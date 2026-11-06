import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hasValidTextConfig, scanIssues, scanReports } from '../../scripts/public-gate/rules-text.mjs';
import { CONFIG_FILE, REPO_ROOT, createHistory, createRepo, gateArgs, historyArgs, runGate, runHistory, sha256, writeList } from '../lib/gate-fixtures.mjs';

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
