import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { hasValidAddressConfig, refusedMetadataEmails, scanAccounts, scanHosts } from '../../scripts/public-gate/rules-address.mjs';
import { createHistory, createRepo, gateArgs, git, historyArgs, REPO_ROOT, runGate, runHistory, writeList } from '../lib/gate-fixtures.mjs';

/** Planted names are built here, so no unlisted host or account is written out in this file. */
const name = (...labels) => labels.join('.');
const LISTED = name('registry', 'harbor', 'dev');
const OTHER = name('node1', 'harbor', 'dev');
const ATTACKER = name('attacker', 'xyz');
const FORGE_EMAIL = `${['12345', 'harbor-dev'].join('+')}@${name('users', 'noreply', 'github', 'com')}`;
const FORGE_IDENTITY = `Harbor Dev <${FORGE_EMAIL}>`;
const PUBLICATION_IDENTITY = 'DACS Agent Commerce <dacs-plugin@users.noreply.invalid>';
const LOCKFILE = 'stdio-mcp/package-lock.json';
const LIMITS = { maxReportEntries: 1000 };

const CONFIG = {
  textExtensions: ['.js', '.json', '.md', '.mjs', '.txt', '.yaml'],
  allowedHosts: [
    { value: 'example.com', reason: 'reserved name' },
    { value: 'github.com', reason: 'code host' },
  ],
  scopedAllowances: [],
  publicIdentities: [PUBLICATION_IDENTITY, FORGE_IDENTITY],
};

const withHosts = (...values) => ({ ...CONFIG, allowedHosts: [...CONFIG.allowedHosts, ...values.map((value) => ({ value, reason: 'reviewed in this test' }))] });
const withAllowances = (...entries) => ({ ...CONFIG, scopedAllowances: entries.map((entry) => ({ ...entry, reason: 'reviewed in this test' })) });

function toEntries(files) {
  return Object.entries(files).map(([file, content], index) => ({ position: index + 1, path: file, bytes: Buffer.from(content) }));
}

/** Each finding as `<rule> <kind> <path> <line>`, in the order the rule returned them. */
function scanned(scan, files, config = CONFIG) {
  return scan({ entries: toEntries(files), config, limits: LIMITS }).map((finding) => `${finding.rule} ${finding.kind} ${finding.entry.path} ${finding.line ?? '-'}`);
}

test('hosts: a host with no exact allow-list entry in a URL or host:port fails with rule, file and line in code, Markdown, JSON, YAML and a path name', () => {
  const files = {
    'src/client.mjs': `const first = 1;\nconst url = 'https://${OTHER}/rpc';\nconst hostPort = '${OTHER}:8545';\n`,
    'docs/guide.md': `# Guide\nSee https://${OTHER}/docs for details.\n`,
    'conf/endpoints.json': `{\n  "rpc": "${OTHER}:8545"\n}\n`,
    'deploy/app.yaml': `name: app\nendpoint: https://${OTHER}\n`,
    [`mirrors/${OTHER}/notes.md`]: 'nothing here\n',
  };
  assert.deepEqual(scanned(scanHosts, files), [
    'R-HOST content src/client.mjs 2', 'R-HOST content src/client.mjs 3', 'R-HOST content docs/guide.md 2',
    'R-HOST content conf/endpoints.json 2', 'R-HOST content deploy/app.yaml 2', `R-HOST path mirrors/${OTHER}/notes.md -`,
  ]);
  const listed = { 'docs/guide.md': 'See https://example.com/docs and example.com:8443 and localhost:3000.\n' };
  assert.deepEqual(scanned(scanHosts, listed, withHosts('localhost')), []);
});

test('hosts: a subdomain of a listed host fails unless a separate reviewed subdomain rule names it; a listed name used as a label prefix of another domain fails', () => {
  const files = {
    'docs/hosts.md': [`https://${LISTED}/ok`, `https://${LISTED.toUpperCase()}:8443/ok`, `https://api.${LISTED}/sub`, `https://${name(LISTED, ATTACKER)}/prefix`].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanHosts, files, withHosts(LISTED)), ['R-HOST content docs/hosts.md 3', 'R-HOST content docs/hosts.md 4']);
  assert.deepEqual(scanned(scanHosts, files, withHosts(LISTED, `api.${LISTED}`)), ['R-HOST content docs/hosts.md 4']);
});

test('hosts: a quoted bare hostname in code fails; JavaScript property access does not', () => {
  const files = {
    'src/hosts.mjs': [
      'const server = config.server.name;', 'const mode = process.env.NODE_ENV;', "import data from './data.json';",
      `const single = '${OTHER}';`, `const double = "${OTHER}";`, `const template = \`${OTHER}\`;`,
    ].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content src/hosts.mjs 4', 'R-HOST content src/hosts.mjs 5', 'R-HOST content src/hosts.mjs 6']);
});

test('hosts: a reserved name passes with any subdomain, and a name with no dot is no public host', () => {
  const files = { 'docs/reserved.md': 'https://a.b.example.invalid/x\nhttps://rpc.example.org:8443\nhttp://localhost:3000/ and http://machine-one/ and machine-one:8080\n' };
  assert.deepEqual(scanned(scanHosts, files), []);
});

test('hosts: the line of a finding counts CRLF, a lone CR and LF as one line break each', () => {
  const files = { 'docs/mixed.md': `first\r\nsecond\rthird\nhttps://${OTHER}/x\n` };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content docs/mixed.md 4']);
});

test('hosts: a name with a template placeholder or an IP literal is left to other rules, and a URL userinfo does not hide the host', () => {
  const files = { 'src/a.mjs': `const a = \`https://\${host}/x\`;\nconst b = 'http://127.0.0.1:8080/';\nconst c = 'https://user@${OTHER}/x';\n` };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content src/a.mjs 3']);
});

test('accounts: an email outside reserved domains fails in content; the SSH form of a listed code host passes; an exact publicIdentities entry with a code-host no-reply email passes in commit metadata; F\'s exact reserved identity passes both metadata and content rules; an unlisted identity still fails the identity rule', () => {
  const files = {
    'docs/contact.md': [
      `Mail dev@${LISTED} now`, 'Mail dev@example.com now', 'Clone git@github.com:org/repo.git', `Clone git@${OTHER}:org/repo.git`,
      `Clone ${['alice', 'github.com'].join('@')}:org/repo.git`, `Reply ${FORGE_EMAIL}`, `Commit as ${PUBLICATION_IDENTITY}`, 'Package name@1.2.3 and @scope/pkg@1.2.3',
    ].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanAccounts, files), [
    'R-ACCOUNT content docs/contact.md 1', 'R-ACCOUNT content docs/contact.md 4', 'R-ACCOUNT content docs/contact.md 5', 'R-ACCOUNT content docs/contact.md 6',
  ]);
  assert.deepEqual(refusedMetadataEmails(`author ${FORGE_IDENTITY} 1700000000 +0000\nauthor ${PUBLICATION_IDENTITY}\nauthor Other <dev@${LISTED}>`, CONFIG), [`dev@${LISTED}`]);
  assert.deepEqual(refusedMetadataEmails(`author ${FORGE_IDENTITY}`, { ...CONFIG, publicIdentities: [] }), [FORGE_EMAIL]);
  assert.deepEqual(refusedMetadataEmails(`author ${PUBLICATION_IDENTITY}`, { ...CONFIG, publicIdentities: [] }), []);
  const history = createHistory([{ author: { name: 'Other', email: 'other@example.invalid' } }]);
  const identity = runHistory(historyArgs(history, writeList(['no-such-entry']), ['--allowed-identity', 'Project <project@example.invalid>']));
  assert.equal(identity.status, 1);
  assert.ok(JSON.parse(identity.stdout).findings.some((finding) => finding.rule === 'R-IDENTITY'));
});

test('hosts and accounts: a backslash before a delimiter does not hide a host or an email, and a backslash does not make a listed host the host of a URL', () => {
  const files = {
    'conf/escaped.json': [
      String.raw`{"u": "https:\/\/${OTHER}\/rpc"}`, String.raw`{"u": "https:\/\/example.com\/rpc"}`, String.raw`{"m": "dev\@${OTHER}"}`, String.raw`{"m": "git\@github.com:org/repo.git"}`,
    ].join('\n') + '\n',
    'src/escaped.mjs': [`const a = "https:\\/\\/${OTHER}";`, `const b = 'http://${OTHER}\\@github.com/';`, `const c = 'http://github.com\\@${OTHER}/';`].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content conf/escaped.json 1', 'R-HOST content src/escaped.mjs 1', 'R-HOST content src/escaped.mjs 2', 'R-HOST content src/escaped.mjs 3']);
  assert.deepEqual(scanned(scanAccounts, files), ['R-ACCOUNT content conf/escaped.json 3', 'R-ACCOUNT content src/escaped.mjs 2', 'R-ACCOUNT content src/escaped.mjs 3']);
  const controls = { 'src/controls.mjs': `const a = 'https://example.com\\nrest';\nconst b = /^https:\\/\\/(${LISTED.replaceAll('.', '\\.')})\\//;\n` };
  assert.deepEqual(scanned(scanHosts, controls), []);
});

test('accounts: an email whose domain has no dot fails unless reserved or reviewed; package and action references are not emails', () => {
  const internal = ['admin', 'corp'].join('@');
  const files = {
    'docs/internal.md': [
      `Mail ${internal} now`, `Mail ${internal}.`, `Mail ${internal.toUpperCase()}, please`, `Clone ${['git', 'corp'].join('@')}:org/repo.git`, 'Mail dev@localhost and dev@example.invalid',
      'Install name@1.2.3 and @scope/pkg@1.2.3 with uses: actions/checkout@v4', `Version ${internal}.example.invalid is reserved`,
    ].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanAccounts, files), ['R-ACCOUNT content docs/internal.md 1', 'R-ACCOUNT content docs/internal.md 2', 'R-ACCOUNT content docs/internal.md 3', 'R-ACCOUNT content docs/internal.md 4']);
  const reviewed = withAllowances({ path: 'docs/internal.md', rule: 'R-ACCOUNT', value: internal, context: 'email' });
  assert.deepEqual(scanned(scanAccounts, files, reviewed), ['R-ACCOUNT content docs/internal.md 4']);
  assert.deepEqual(refusedMetadataEmails(`author Other <${internal}>`, CONFIG), [internal]);
  assert.deepEqual(refusedMetadataEmails(`author Other <${internal}>`, { ...CONFIG, publicIdentities: [`Other <${internal}>`] }), []);
});

test('accounts: a user in URL userinfo before a domain with no dot fails after `//`; a single `/` before the user is still a package or action reference', () => {
  const user = ['alice', 'corp'].join('@');
  const files = {
    'docs/urls.md': [
      `Clone ssh://${user}/repo`, `Clone git+ssh://${['git', 'corp'].join('@')}/org/repo.git`, `Open //${user}/share`, `Open ssh:\\/\\/${user}\\/repo`,
      `Open ssh://${user.toUpperCase()}:22/repo`, 'Use ssh://git@github.com/org/repo.git', 'Use uses: actions/checkout@v4', 'Use @scope/pkg@latest and https://registry.example.com/pkg@latest',
    ].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanAccounts, files), [1, 2, 3, 4, 5].map((line) => `R-ACCOUNT content docs/urls.md ${line}`));
  const reviewed = withAllowances({ path: 'docs/urls.md', rule: 'R-ACCOUNT', value: user, context: 'email' });
  assert.deepEqual(scanned(scanAccounts, files, reviewed), ['R-ACCOUNT content docs/urls.md 2']);
  assert.deepEqual(refusedMetadataEmails(`author Other <${user}> ssh://${user}/repo`, CONFIG), [user]);
});

test('lockfiles and generated bundles: an inserted unlisted host or account fails; only a reviewed value in its reviewed context passes', () => {
  const lock = `{\n  "resolved": "https://${LISTED}/pkg/-/pkg-1.0.0.tgz",\n  "homepage": "${LISTED}",\n  "author": "dev@${LISTED}"\n}\n`;
  const bundle = `var url = 'https://${LISTED}/x';\n`;
  const reviewed = withAllowances(
    { path: LOCKFILE, rule: 'R-HOST', value: LISTED, context: 'url' },
    { path: LOCKFILE, rule: 'R-ACCOUNT', value: `dev@${LISTED}`, context: 'email' },
    { path: 'http-mcp/dist/bundle.js', rule: 'R-HOST', value: LISTED, context: 'url' },
  );
  const files = { [LOCKFILE]: lock, 'http-mcp/dist/bundle.js': bundle, 'http-mcp/package-lock.json': lock };
  assert.deepEqual(scanned(scanHosts, files, reviewed), [`R-HOST content ${LOCKFILE} 3`, 'R-HOST content http-mcp/package-lock.json 2', 'R-HOST content http-mcp/package-lock.json 3']);
  assert.deepEqual(scanned(scanAccounts, files, reviewed), ['R-ACCOUNT content http-mcp/package-lock.json 4']);
  const inserted = { [LOCKFILE]: `${lock}{ "resolved": "https://${OTHER}/pkg/-/pkg-2.0.0.tgz", "author": "dev@${OTHER}" }\n` };
  assert.deepEqual(scanned(scanHosts, inserted, reviewed), [`R-HOST content ${LOCKFILE} 3`, `R-HOST content ${LOCKFILE} 6`]);
  assert.deepEqual(scanned(scanAccounts, inserted, reviewed), [`R-ACCOUNT content ${LOCKFILE} 6`]);
});

test('lockfiles and generated bundles: the configuration file may hold the values its own entries name, in no other file and for no other value', () => {
  const reviewed = withAllowances({ path: LOCKFILE, rule: 'R-HOST', value: LISTED, context: 'url' }, { path: LOCKFILE, rule: 'R-ACCOUNT', value: `dev@${LISTED}`, context: 'email' });
  const text = `{ "value": "${LISTED}", "other": "dev@${LISTED}" }\n`;
  const files = { 'public-gate.config.json': text, 'docs/copy.json': text, 'other-dir/public-gate.config.json': text };
  assert.deepEqual(scanned(scanHosts, files, reviewed), ['R-HOST content docs/copy.json 1', 'R-HOST content other-dir/public-gate.config.json 1']);
  assert.deepEqual(scanned(scanAccounts, files, reviewed), ['R-ACCOUNT content docs/copy.json 1', 'R-ACCOUNT content other-dir/public-gate.config.json 1']);
  const unreviewed = { 'public-gate.config.json': `{ "value": "${OTHER}" }\n` };
  assert.deepEqual(scanned(scanHosts, unreviewed, reviewed), ['R-HOST content public-gate.config.json 1']);
});

test('a malformed allow-list section is invalid configuration', () => {
  const scoped = { path: LOCKFILE, rule: 'R-HOST', value: LISTED, context: 'url', reason: 'reviewed' };
  assert.equal(hasValidAddressConfig({ ...CONFIG, scopedAllowances: [scoped] }), true);
  const malformed = [
    { ...CONFIG, allowedHosts: undefined }, { ...CONFIG, allowedHosts: [{ value: 'example.com' }] },
    { ...CONFIG, allowedHosts: [{ value: 'Example.com', reason: 'upper case' }] }, { ...CONFIG, allowedHosts: [{ value: 'example.com', reason: '' }] },
    { ...CONFIG, scopedAllowances: [{ ...scoped, rule: 'R-OTHER' }] }, { ...CONFIG, scopedAllowances: [{ ...scoped, context: 'anywhere' }] },
    { ...CONFIG, scopedAllowances: [{ ...scoped, path: '' }] }, { ...CONFIG, scopedAllowances: undefined },
    { ...CONFIG, publicIdentities: ['no angle brackets'] }, { ...CONFIG, publicIdentities: undefined },
  ];
  for (const config of malformed) assert.equal(hasValidAddressConfig(config), false, JSON.stringify(config));
});

test('more findings than maxReportEntries stop the scan with the limit cause', () => {
  const files = { 'docs/many.md': [1, 2, 3].map((number) => `https://${OTHER}/${number}`).join('\n') };
  assert.throws(() => scanHosts({ entries: toEntries(files), config: CONFIG, limits: { maxReportEntries: 2 } }), (error) => error instanceof GateInputError && error.cause === 'limit:maxReportEntries');
});

test('generic scope runs both rules; a finding names rule, kind, location and line but never the host', () => {
  const clean = createRepo([{ path: 'a.md', content: 'See https://example.com/ and mail dev@example.com\n' }]);
  const passing = runGate(gateArgs(clean, 'generic'));
  assert.equal(passing.status, 0, passing.stderr);
  assert.deepEqual(JSON.parse(passing.stdout).rules, [{ id: 'R-ACCOUNT', status: 'passed' }, { id: 'R-HOST', status: 'passed' }, { id: 'R-PRIVATE', status: 'not-run' }]);
  const planted = createRepo([{ path: 'a.md', content: `ok\nSee https://${OTHER}/ and mail dev@${LISTED}\n` }]);
  const failing = runGate(gateArgs(planted, 'generic'));
  assert.equal(failing.status, 1);
  const report = JSON.parse(failing.stdout);
  assert.deepEqual(report.findings, [
    { rule: 'R-ACCOUNT', kind: 'content', location: `${planted.commit}:1`, line: 2 },
    { rule: 'R-HOST', kind: 'content', location: `${planted.commit}:1`, line: 2 },
  ]);
  assert.deepEqual(report.rules.map((rule) => rule.status), ['findings', 'findings', 'not-run']);
  for (const text of [OTHER, LISTED, 'a.md']) assert.ok(!`${failing.stdout}${failing.stderr}`.includes(text));
});

test('a long unbroken line of letters, dots or hyphens scans in linear time and the gate passes', () => {
  const unbroken = (unit, index) => ({ path: `line-${index}.md`, content: unit.repeat((4 << 20) / unit.length) });
  const repo = createRepo(['a', 'a.', 'a-', 'a@'].map(unbroken));
  const result = runGate(gateArgs(repo, 'generic'), { timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('the shipped configuration passes this repository\'s own files under both rules', () => {
  const listed = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  const repo = createRepo(files.map((file) => ({ path: file, content: readFileSync(path.join(REPO_ROOT, file)) })));
  const result = runGate(gateArgs(repo, 'generic'), { timeout: 300_000 });
  const report = JSON.parse(result.stdout);
  const positions = git(repo.dir, ['ls-tree', '-r', '--name-only', repo.commit]).split('\n');
  const found = report.findings.map(({ rule, location, line }) => `${rule} ${positions[Number(location.split(':')[1]) - 1]} ${line ?? '-'}`);
  assert.deepEqual(found, []);
  assert.equal(result.status, 0, result.stderr);
});
