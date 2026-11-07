import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { hasValidAddressConfig, hasValidIpDispositions, refusedMetadataEmails, refusedMetadataHosts, refusedMetadataIps, scanAccounts, scanHosts, scanIps } from '../../scripts/public-gate/rules-address.mjs';
import { CONFIG_FILE, createHistory, createRepo, gateArgs, git, historyArgs, REPO_ROOT, runGate, runHistory, sha256, writeList } from '../lib/gate-fixtures.mjs';

/** Planted names are built here, so no unlisted host or account is written out in this file. */
const name = (...labels) => labels.join('.');
const LISTED = name('registry', 'harbor', 'dev');
const OTHER = name('node1', 'harbor', 'dev');
const ATTACKER = name('attacker', 'xyz');
const ATTACKER_ENCODED = ATTACKER.replaceAll('.', '%2e');
/** An escape that is not UTF-8, a double-encoded dot, an encoded slash and an encoded NUL: none resolves to a host. */
const UNDECODABLE_HOSTS = ['%ff.example.com', 'example.com%2fx', 'evil%252ecom', 'example.com%00'];
const urlOf = (host) => `https://${host}/x`;
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

const PLANTED_BLOB = 'b'.repeat(40);

function toEntries(files, oid) {
  return Object.entries(files).map(([file, content], index) => ({ position: index + 1, path: file, oid, bytes: Buffer.from(content) }));
}

/** Each finding as `<rule> <kind> <path> <line>`, in the order the rule returned them; every file is the blob `oid`. */
function scanned(scan, files, config = CONFIG, oid = PLANTED_BLOB) {
  return scan({ entries: toEntries(files, oid), config, limits: LIMITS }).map((finding) => `${finding.rule} ${finding.kind} ${finding.entry.path} ${finding.line ?? '-'}`);
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

test('hosts: a protocol-relative URL host fails in prose and data and in a quoted string in code; a `//` comment, a regex, a listed and a reserved host do not', () => {
  const files = {
    'docs/relative.md': [`load //${OTHER}/path`, `<img src=//${ATTACKER_ENCODED}/a.png>`, `//github.com/x and //${name('cdn', 'example', 'net')}/y`, `https://${OTHER}/x`].join('\n') + '\n',
    'conf/relative.json': `{ "cdn": "//${OTHER}/lib.js" }\n`,
    'src/relative.mjs': [`const a = "//${OTHER}/x";`, `const b = '//user@${OTHER}:8443/x';`, `// ${OTHER} in a comment`, `//${OTHER}/x in a comment`,
      'const re = /^([a-z][a-z\\d+\\-.]*:)?\\/\\//i;', "const c = '//github.com/x';"].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content docs/relative.md 1', 'R-HOST content docs/relative.md 2', 'R-HOST content docs/relative.md 4',
    'R-HOST content conf/relative.json 1', 'R-HOST content src/relative.mjs 1', 'R-HOST content src/relative.mjs 2']);
  assert.deepEqual(refusedMetadataHosts(`subject\n\nsee //${ATTACKER}/x and //github.com/y`, CONFIG), [ATTACKER]);
});

test('hosts: in a CSS file an unquoted protocol-relative URL in `url(...)` fails like a quoted one, in any letter case and with spaces; a listed host passes, and a `//` after anything else is not read', () => {
  const files = {
    'web/site.css': [`.a { background-image: url(//${OTHER}/i.png); }`, `@import url(//${OTHER}/base.css);`, `.b { background: url( //${OTHER}/i.png ); }`, `.c { background: URL(//${OTHER}/i.png); }`,
      '.d { background: url(//github.com/i.png); }', `/* see //${OTHER} */`].join('\n') + '\n',
    'src/style.mjs': [`const css = \`background: url(//${OTHER}/i.png)\`;`, `foo(url(// ${OTHER} note`].join('\n') + '\n',
  };
  const config = { ...CONFIG, textExtensions: [...CONFIG.textExtensions, '.css'] };
  assert.deepEqual(scanned(scanHosts, files, config), [1, 2, 3, 4].map((line) => `R-HOST content web/site.css ${line}`).concat('R-HOST content src/style.mjs 1'));
});

test('hosts: a percent-encoded dot, an upper-case encoding or a trailing dot in a URL host does not hide an unlisted host', () => {
  const files = {
    'docs/encoded.md': [ATTACKER_ENCODED, `${ATTACKER.toUpperCase()}.`, ATTACKER_ENCODED.replace('%2e', '%2E'), `${ATTACKER}%2e`].map((host) => urlOf(host)).join('\n') + '\n',
    'src/encoded.mjs': `const url = '${urlOf(ATTACKER_ENCODED)}';\n`,
  };
  assert.deepEqual(scanned(scanHosts, files), [1, 2, 3, 4].map((line) => `R-HOST content docs/encoded.md ${line}`).concat('R-HOST content src/encoded.mjs 1'));
});

test('hosts: an encoded form of a listed host passes, and an encoded subdomain of it fails', () => {
  const files = { 'docs/encoded.md': ['github%2ecom', 'GITHUB%2Ecom.', 'api%2egithub%2ecom'].map((host) => urlOf(host)).join('\n') + '\n' };
  assert.deepEqual(scanned(scanHosts, files), ['R-HOST content docs/encoded.md 3']);
});

test('hosts: a URL host whose escapes cannot be decoded or normalised fails, and a template placeholder still passes', () => {
  const files = {
    'docs/undecodable.md': UNDECODABLE_HOSTS.map((host) => urlOf(host)).join('\n') + '\n',
    'docs/templates.md': ['%s', '%(host)s'].map((host) => urlOf(host)).join(' and ') + '\n',
  };
  assert.deepEqual(scanned(scanHosts, files), [1, 2, 3, 4].map((line) => `R-HOST content docs/undecodable.md ${line}`));
});

test('hosts and IPs: an encoded IP literal in a URL gets the same result as the plain one', () => {
  const encodedLoopback = { 'docs/ip.md': 'http://127%2e0%2e0%2e1/\n' };
  const encodedPublic = { 'docs/ip.md': `http://${PUBLIC_V4.replaceAll('.', '%2e')}/\n` };
  const plainPublic = { 'docs/ip.md': `http://${PUBLIC_V4}/\n` };
  assert.deepEqual(scanned(scanIps, encodedLoopback, NO_DISPOSITIONS), scanned(scanIps, { 'docs/ip.md': 'http://127.0.0.1/\n' }, NO_DISPOSITIONS));
  assert.deepEqual(scanned(scanIps, encodedPublic, NO_DISPOSITIONS), ['R-IP content docs/ip.md 1']);
  assert.deepEqual(scanned(scanIps, encodedPublic, NO_DISPOSITIONS), scanned(scanIps, plainPublic, NO_DISPOSITIONS));
  assert.deepEqual(scanned(scanHosts, { ...encodedLoopback, 'docs/other.md': encodedPublic['docs/ip.md'] }), []);
});

test('commit metadata: the host and IP checks read an encoded URL host as the host it resolves to, and refuse one that cannot be decoded', () => {
  assert.deepEqual(refusedMetadataHosts(`subject\n\nhttps://${ATTACKER_ENCODED}/a and https://${ATTACKER}./b`, CONFIG), [ATTACKER]);
  assert.deepEqual(refusedMetadataHosts('https://github%2ecom/x', CONFIG), []);
  assert.deepEqual(refusedMetadataHosts(urlOf(UNDECODABLE_HOSTS[0]), CONFIG), [UNDECODABLE_HOSTS[0]]);
  assert.deepEqual(refusedMetadataIps(`http://${PUBLIC_V4.replaceAll('.', '%2e')}/`), [PUBLIC_V4]);
  assert.deepEqual(refusedMetadataIps('http://127%2e0%2e0%2e1/'), []);
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

/** Planted address literals are built here from their parts, so none is written out in this file. */
const ipv4 = (...octets) => octets.join('.');
const ipv6 = (...groups) => groups.join(':');
const PUBLIC_V4 = ipv4(8, 8, 4, 4);
const PRIVATE_V4 = ipv4(10, 0, 0, 7);
const SHARED_V4 = ipv4(100, 64, 0, 1);
const LINK_LOCAL_V4 = ipv4(169, 254, 1, 1);
const PUBLIC_V6 = ipv6('2606', '4700', '', '1111');
const UNIQUE_LOCAL_V6 = ipv6('fd12', '3456', '789a', '', '1');
const LINK_LOCAL_V6 = ipv6('fe80', '', '1');
const MAPPED_PUBLIC = ipv6('', '', 'ffff', PUBLIC_V4);
const MAPPED_PUBLIC_HEX = ipv6('', '', 'ffff', '808', '404');
const MAPPED_LOOPBACK = ipv6('', '', 'ffff', ipv4(127, 0, 0, 1));
const MAPPED_LOOPBACK_HEX = ipv6('', '', 'ffff', '7f00', '1');
const EXPANDED_LOOPBACK = ipv6(0, 0, 0, 0, 0, 0, 0, 1);
const COMMON_NAME_OID = ipv4(2, 5, 4, 3);
const QUOTED_CONTEXT ="= '<ip>';";
const OID_CHUNK = 'http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-7OGVXGZV.mjs';
const OID_CHUNK_BLOB = 'c420e04e0b82c351d8726241668da69301690713';
const OID_LINE = 5;
const LOOPBACK_TEST = 'http-mcp/test/oauth-loopback.test.mjs';
const LOOPBACK_LINE = 161;
const SHIPPED_CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
const NO_DISPOSITIONS = { ...CONFIG, ipDispositions: [] };

const disposition = (file, line, value, oid = PLANTED_BLOB) => ({ path: file, blob: oid, line, context: QUOTED_CONTEXT, sha256: sha256(value), reason: 'reviewed in this test' });

/** A reviewed target's own blob, read from Git at test time. */
function blobAt(file) {
  const shown = spawnSync('git', ['-C', REPO_ROOT, 'show', `HEAD:${file}`], { maxBuffer: 1 << 26 });
  assert.equal(shown.status, 0, shown.stderr.toString());
  return { oid: git(REPO_ROOT, ['rev-parse', `HEAD:${file}`]), text: shown.stdout.toString('utf8') };
}

/** The lines on which R-IP reports `text` as the blob `oid` at `file`, under `config`. */
const refusedLinesOf = (file, { oid, text }, config) => scanIps({ entries: [{ position: 1, path: file, oid, bytes: Buffer.from(text) }], config, limits: LIMITS }).map(({ line }) => line);

/** `text` with `edit` applied to its 1-based line `number`. */
const withLineEdited = ({ oid, text }, number, edit) => ({ oid, text: text.split('\n').map((line, index) => (index + 1 === number ? edit(line) : line)).join('\n') });

test('addresses: public, private IPv4, shared, unique-local IPv6 and link-local literals each fail when planted in code, config, prose and a path name; loopback and unspecified bind settings, reserved documentation examples, the two IPv4-mapped loopback literals and the expanded IPv6 loopback literal at http-mcp/test/oauth-loopback.test.mjs:161 pass; the 55 ASN.1 object-identifier tokens on line 5 of http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-7OGVXGZV.mjs pass only under their exact per-token dispositions; a public address added on that line outside the listed tokens and a mapped non-loopback address fail; an exact reviewed disposition passes only its own path, blob, line, context and value', () => {
  const planted = {
    'src/server.mjs': `const ok = 1;\nconst host = '${PUBLIC_V4}';\n`,
    'conf/net.json': `{\n  "peer": "${PRIVATE_V4}:8080"\n}\n`,
    'docs/net.md': [`shared ${SHARED_V4} here`, `link ${LINK_LOCAL_V4}.`, `unique [${UNIQUE_LOCAL_V6}]:443`, `scoped ${LINK_LOCAL_V6}%eth0`, `public ${PUBLIC_V6}`].join('\n') + '\n',
    [`mirrors/${PUBLIC_V4}/notes.md`]: 'nothing here\n',
    [`${PRIVATE_V4}.md`]: 'nothing here\n',
    [`nodes/${LINK_LOCAL_V6}/notes.md`]: 'nothing here\n',
  };
  assert.deepEqual(scanned(scanIps, planted, NO_DISPOSITIONS), [
    'R-IP content src/server.mjs 2', 'R-IP content conf/net.json 2', 'R-IP content docs/net.md 1', 'R-IP content docs/net.md 2', 'R-IP content docs/net.md 3',
    'R-IP content docs/net.md 4', 'R-IP content docs/net.md 5', `R-IP path mirrors/${PUBLIC_V4}/notes.md -`, `R-IP path ${PRIVATE_V4}.md -`, `R-IP path nodes/${LINK_LOCAL_V6}/notes.md -`,
  ]);

  const permitted = {
    'conf/bind.yaml': [
      'host: 127.0.0.1', `bind: ${ipv4(127, 8, 9, 10)}:3000`, 'listen: 0.0.0.0', 'v6: ::1', 'v6: [::1]:8080', 'any: [::]:80',
      `docs: ${ipv4(192, 0, 2, 1)}, ${ipv4(198, 51, 100, 77)}, ${ipv4(203, 0, 113, 254)}`, `doc6: ${ipv6('2001', 'db8', '', 1)} and ${ipv6('2001', 'db8', 0, 0, 0, 0, 0, 'ff')} and ${ipv6('2001', 'DB8', '', 2)}`,
    ].join('\n') + '\n',
    'docs/not-addresses.md': ['version 1.2.3.4.5 and 1.3.6.1.4.1.311', 'time 12:30:45 and mac aa:bb:cc:dd:ee:ff', 'call std::vector and a ::: b', `range ${ipv4(300, 1, 1, 1)} and v1.2.3.4`].join('\n') + '\n',
  };
  assert.deepEqual(scanned(scanIps, permitted, NO_DISPOSITIONS), []);

  const mapped = ({ quote = "'", loopback = MAPPED_LOOPBACK, extra = '' } = {}) => ({ 'src/mapped.mjs': [
    `a = '${MAPPED_PUBLIC}';`, `b = '${MAPPED_PUBLIC_HEX}';`, `c = ${quote}${loopback}${quote};`, `d = '${MAPPED_LOOPBACK_HEX}';`, `e = '${EXPANDED_LOOPBACK}';${extra}`,
  ].join('\n') + '\n' });
  const reviewed = (oid = PLANTED_BLOB, file = 'src/mapped.mjs') => ({ ...CONFIG, ipDispositions: [
    disposition(file, 3, MAPPED_LOOPBACK, oid), disposition(file, 4, MAPPED_LOOPBACK_HEX, oid), disposition(file, 5, EXPANDED_LOOPBACK, oid),
  ] });
  const lines = (files, config, oid) => scanned(scanIps, files, config, oid).map((finding) => Number(finding.split(' ').at(-1)));
  assert.deepEqual(lines(mapped(), NO_DISPOSITIONS), [1, 2, 3, 4, 5]);
  assert.deepEqual(lines(mapped(), reviewed()), [1, 2]);
  assert.deepEqual(lines(mapped({ loopback: ipv6('', '', 'ffff', ipv4(127, 0, 0, 2)) }), reviewed()), [1, 2, 3]);
  assert.deepEqual(lines(mapped({ quote: '"' }), reviewed()), [1, 2, 3]);
  assert.deepEqual(lines(mapped({ extra: ' // more' }), reviewed()), [1, 2, 5], 'the three characters after an occurrence are part of its context');
  assert.deepEqual(lines(mapped(), reviewed(), 'c'.repeat(40)), [1, 2, 3, 4, 5]);
  assert.deepEqual(lines(mapped(), reviewed(PLANTED_BLOB, 'src/other.mjs')), [1, 2, 3, 4, 5]);
  assert.deepEqual(lines({ 'src/mapped.mjs': `\n${mapped()['src/mapped.mjs']}` }, reviewed()), [2, 3, 4, 5, 6]);

  const chunk = blobAt(OID_CHUNK);
  assert.equal(chunk.oid, OID_CHUNK_BLOB);
  const oidDispositions = SHIPPED_CONFIG.ipDispositions.filter((entry) => entry.path === OID_CHUNK);
  assert.equal(oidDispositions.length, 55);
  assert.ok(oidDispositions.every((entry) => entry.blob === OID_CHUNK_BLOB && entry.line === OID_LINE));
  assert.deepEqual(refusedLinesOf(OID_CHUNK, chunk, SHIPPED_CONFIG), []);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, chunk, NO_DISPOSITIONS), [OID_LINE]);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, chunk, { ...SHIPPED_CONFIG, ipDispositions: SHIPPED_CONFIG.ipDispositions.slice(1) }), [OID_LINE], 'a token without its own disposition fails');
  assert.deepEqual(refusedLinesOf(OID_CHUNK, withLineEdited(chunk, OID_LINE, (line) => `${line};x="${PUBLIC_V4}"`), SHIPPED_CONFIG), [OID_LINE]);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, withLineEdited(chunk, OID_LINE, (line) => `${line};O("${PUBLIC_V4}","x")`), SHIPPED_CONFIG), [OID_LINE]);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, withLineEdited(chunk, OID_LINE, (line) => line.replace(`O("${COMMON_NAME_OID}"`, `P("${COMMON_NAME_OID}"`)), SHIPPED_CONFIG), [OID_LINE]);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, { ...chunk, text: `\n${chunk.text}` }, SHIPPED_CONFIG), [OID_LINE + 1]);
  assert.deepEqual(refusedLinesOf('http-mcp/public/other.mjs', chunk, SHIPPED_CONFIG), [OID_LINE]);
  assert.deepEqual(refusedLinesOf(OID_CHUNK, { ...chunk, oid: 'c'.repeat(40) }, SHIPPED_CONFIG), [OID_LINE]);

  const loopback = blobAt(LOOPBACK_TEST);
  assert.deepEqual(refusedLinesOf(LOOPBACK_TEST, loopback, SHIPPED_CONFIG), []);
  assert.deepEqual(refusedLinesOf(LOOPBACK_TEST, loopback, NO_DISPOSITIONS), [LOOPBACK_LINE]);
  assert.deepEqual(refusedLinesOf(LOOPBACK_TEST, withLineEdited(loopback, LOOPBACK_LINE, (line) => line.replace(MAPPED_LOOPBACK_HEX, MAPPED_PUBLIC_HEX)), SHIPPED_CONFIG), [LOOPBACK_LINE]);
  assert.deepEqual(refusedLinesOf(LOOPBACK_TEST, withLineEdited(loopback, LOOPBACK_LINE, (line) => line.replace(MAPPED_LOOPBACK, MAPPED_PUBLIC)), SHIPPED_CONFIG), [LOOPBACK_LINE]);
});

test('addresses: a literal written right after a label colon, an underscore or an escaped control character, or after a dotted name, still fails; a version tag, a code scope and a documentation address after a label do not', () => {
  const refusedLines = (...texts) => scanned(scanIps, { 'src/ids.txt': texts.join('\n') + '\n' }, NO_DISPOSITIONS).map((finding) => Number(finding.split(' ').at(-1)));
  const afterLabel = [`ip:${PUBLIC_V6}`, `tcp6:${PUBLIC_V6}`, `host:${PUBLIC_V6}`, `a.b-c:${LINK_LOCAL_V6}`, `add-host name:${UNIQUE_LOCAL_V6}`, `deadbeef:${PUBLIC_V6}`, `ip\\:${PUBLIC_V6}`];
  assert.deepEqual(refusedLines(...afterLabel), afterLabel.map((_, index) => index + 1), 'an IPv6 literal after `label:`');
  const glued = [`NODE_${PRIVATE_V4}`, `${PRIVATE_V4}_backup`, `ip_${PUBLIC_V6}`, `backup.${PRIVATE_V4}.tar`, `"a\\n${PRIVATE_V4}"`, `'\\t${PRIVATE_V4}'`, `x\\r${LINK_LOCAL_V6}`];
  assert.deepEqual(refusedLines(...glued), glued.map((_, index) => index + 1), 'an address after `_`, after a dotted name or an escape, or before `_`');
  assert.deepEqual(scanned(scanIps, { [`logs/server_${PRIVATE_V4}.log`]: 'x\n', [`logs/backup.${PRIVATE_V4}.tar.gz`]: 'x\n' }, NO_DISPOSITIONS), [
    `R-IP path logs/server_${PRIVATE_V4}.log -`, `R-IP path logs/backup.${PRIVATE_V4}.tar.gz -`,
  ]);
  assert.deepEqual(refusedLines(`ip:${ipv6('2001', 'db8', '', 1)}`, 'host:::1', `v${ipv4(1, 2, 3, 4)}`, 'std::vector and Node::dead', 'call a.b:12:30:45 at ns1:80', `${ipv4(1, 10, 0, 0, 5)}`), []);
});

test('addresses: seven written groups with `::` at either end, and a `::`-leading literal after a label colon, still fail; a bare scope or a nine-group run does not', () => {
  const refusedLines = (...texts) => scanned(scanIps, { 'src/ids.txt': texts.join('\n') + '\n' }, NO_DISPOSITIONS).map((finding) => Number(finding.split(' ').at(-1)));
  const sevenGroups = [ipv6(1, 2, 3, 4, 5, 6, 7, '', ''), ipv6('', '', 1, 2, 3, 4, 5, 6, 7), `[${ipv6(1, 2, 3, 4, 5, 6, 7, '', '')}]:443`, ipv6('2606', '4700', 1, 2, 3, 4, 5, '', ''), `at ${ipv6('', '', '2606', '4700', 1, 2, 3, 4, 5)}.`];
  assert.deepEqual(refusedLines(...sevenGroups), sevenGroups.map((_, index) => index + 1), 'seven groups and `::` at an end');
  const middle = [ipv6(1, '', 2, 3, 4, 5, 6, 7), ipv6(1, 2, 3, 4, 5, 6, '', 7), ipv6(1, 2, 3, 4, 5, 6, 7, 8)];
  assert.deepEqual(refusedLines(...middle), middle.map((_, index) => index + 1), 'seven groups with `::` inside, and eight groups');
  const afterLabelLeading = [`ip:${MAPPED_PUBLIC_HEX}`, `addr:${ipv6('', '', 'ffff', '0808', '0404')}`, `tcp6:${ipv6('', '', 2)}`, `add-host name:${MAPPED_PUBLIC}`, `ip\\:${MAPPED_PUBLIC_HEX}`, `ip:${ipv6('', '', 1, 2, 3, 4, 5, 6, 7)}`];
  assert.deepEqual(refusedLines(...afterLabelLeading), afterLabelLeading.map((_, index) => index + 1), 'a `::`-leading literal after `label:`');
  assert.deepEqual(refusedLines('host:::1', 'ip::: and ip:::', 'std::vector and Node::dead', ipv6(1, 2, 3, 4, 5, 6, 7, 8, 9)), [], 'permitted loopback after a label, a bare scope, a nine-group run');
});

test('a malformed IP disposition is invalid configuration', () => {
  const entry = disposition(LOCKFILE, 3, PUBLIC_V4);
  assert.equal(hasValidIpDispositions({ ipDispositions: [entry] }), true);
  const malformed = [
    undefined, {}, [null], [{ ...entry, path: '' }], [{ ...entry, blob: 'abc123' }], [{ ...entry, blob: 'B'.repeat(40) }], [{ ...entry, line: 0 }], [{ ...entry, line: '3' }],
    [{ ...entry, line: 1.5 }], [{ ...entry, context: '= value' }], [{ ...entry, sha256: sha256('x').slice(1) }], [{ ...entry, sha256: PUBLIC_V4 }], [{ ...entry, reason: '' }], [entry, { ...entry, reason: undefined }],
  ];
  for (const ipDispositions of malformed) assert.equal(hasValidIpDispositions({ ipDispositions }), false, JSON.stringify(ipDispositions));
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

test('generic scope runs the three address rules; a finding names rule, kind, location and line but never the host, email or address', () => {
  const clean = createRepo([{ path: 'a.md', content: 'See https://example.com/ and mail dev@example.com on 127.0.0.1\n' }]);
  const passing = runGate(gateArgs(clean, 'generic'));
  assert.equal(passing.status, 0, passing.stderr);
  assert.deepEqual(JSON.parse(passing.stdout).rules, [{ id: 'R-ACCOUNT', status: 'passed' }, { id: 'R-ARCHIVE', status: 'passed' }, { id: 'R-ENV', status: 'passed' }, { id: 'R-EVAL', status: 'passed' }, { id: 'R-HOST', status: 'passed' }, { id: 'R-HOSTING', status: 'passed' }, { id: 'R-IP', status: 'passed' }, { id: 'R-ISSUE', status: 'passed' }, { id: 'R-PRIVATE', status: 'not-run' }, { id: 'R-REPORT', status: 'passed' }, { id: 'R-SECRET', status: 'passed' }, { id: 'R-WORDING', status: 'not-run' }]);
  const planted = createRepo([{ path: 'a.md', content: `ok\nSee https://${OTHER}/ and mail dev@${LISTED} via ${PUBLIC_V4}\n` }]);
  const failing = runGate(gateArgs(planted, 'generic'));
  assert.equal(failing.status, 1);
  const report = JSON.parse(failing.stdout);
  assert.deepEqual(report.findings, [
    { rule: 'R-ACCOUNT', kind: 'content', location: `${planted.commit}:1`, line: 2 },
    { rule: 'R-HOST', kind: 'content', location: `${planted.commit}:1`, line: 2 },
    { rule: 'R-IP', kind: 'content', location: `${planted.commit}:1`, line: 2 },
  ]);
  assert.deepEqual(report.rules.map((rule) => rule.status), ['findings', 'findings', 'findings', 'findings', 'findings', 'findings', 'findings', 'findings', 'not-run', 'findings', 'findings', 'not-run']);
  for (const text of [OTHER, LISTED, PUBLIC_V4, 'a.md']) assert.ok(!`${failing.stdout}${failing.stderr}`.includes(text));
});

test('a long unbroken line of letters, dots or hyphens scans in linear time and the gate passes', () => {
  const unbroken = (unit, index) => ({ path: `line-${index}.md`, content: unit.repeat((4 << 20) / unit.length) });
  const repo = createRepo(['a', 'a.', 'a-', 'a@'].map(unbroken));
  const result = runGate(gateArgs(repo, 'generic'), { timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('the shipped configuration allows the funding links in the lint tool\'s lockfile at that path only', () => {
  const funding = (host) => `{ "funding": "https://${host}/donate" }`;
  const lockfile = `${funding(['opencollective', 'com'].join('.'))}\n${funding(['eslint', 'org'].join('.'))}\n`;
  const hostFindings = (file) => JSON.parse(runGate(gateArgs(createRepo([{ path: file, content: lockfile }]), 'generic')).stdout).findings.filter(({ rule }) => rule === 'R-HOST');
  assert.deepEqual(hostFindings('tools/lint/package-lock.json'), []);
  assert.equal(hostFindings('tools/other/package-lock.json').length, 2);
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
