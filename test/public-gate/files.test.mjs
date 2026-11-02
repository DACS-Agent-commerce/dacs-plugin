import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, deflateRawSync, gzipSync } from 'node:zlib';
import { unscannableEntries } from '../../scripts/public-gate/gate.mjs';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { scanArchives, scanEnvTemplates, scanHostingFiles } from '../../scripts/public-gate/rules-files.mjs';
import { createRepo, gateArgs, git, REPO_ROOT, runGate, sha256 } from '../lib/gate-fixtures.mjs';

const LIMITS = { maxReportEntries: 1000 };
const TEMPLATE = 'http-mcp/.env.example';
const FILE_RULES = ['R-ENV', 'R-HOSTING', 'R-ARCHIVE'];
const TAR_BLOCK_BYTES = 512;
const ZIP_SIGNATURES = [[0x01, 0x02], [0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].map((tail) => Buffer.from([0x50, 0x4b, ...tail]));
const PLANTED_BLOB = 'b'.repeat(40);
const LINEAR_SCAN_DEADLINE_MS = 10_000;
const ENV_REFUSED = ['R-ENV content .env.example 1'];

/** Planted values are built here, so no value that reads as a credential is written out in this file. */
const realValue = () => ['wombat', 'quartz', 'ember', '7731'].join('-');

const toEntries = (files) => Object.entries(files).map(([file, content], index) => ({ position: index + 1, path: file, oid: PLANTED_BLOB, bytes: Buffer.from(content) }));

/** Each finding as `<rule> <kind> <path> <line>`, in the order the rule returned them. */
function scanned(scan, files, limits = LIMITS) {
  return scan({ entries: toEntries(files), config: {}, limits }).map((finding) => `${finding.rule} ${finding.kind} ${finding.entry.path} ${finding.line ?? '-'}`);
}

const envFindings = (text, file = '.env.example') => scanned(scanEnvTemplates, { [file]: text });

/** One tar header block for `name` holding `size` bytes, its unused bytes set to `fill`, `magic` at byte 257 and a valid checksum. */
function tarHeader({ name = 'secret.env', size = 0, fill = 0, magic = '', type = '0' } = {}) {
  const block = Buffer.alloc(TAR_BLOCK_BYTES, fill);
  block.write(name, 0);
  block.write('0000644 ', 100);
  block.write('0000000 ', 108);
  block.write('0000000 ', 116);
  block.write(`${size.toString(8).padStart(11, '0')} `, 124);
  block.write('00000000000 ', 136);
  block.write(' '.repeat(8), 148);
  block.write(type, 156);
  block.write(magic, 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(7, '0')} `, 148);
  return block;
}

/** A v7 tar with no NUL byte that is valid UTF-8 (GNU tar lists and extracts its `secret.env`). */
function textOnlyTar() {
  const content = Buffer.alloc(TAR_BLOCK_BYTES, 0x20);
  content.write('API_TOKEN=abc\n');
  return Buffer.concat([tarHeader({ name: `${'./'.repeat(45)}secret.env`, size: 14, fill: 0x20 }), content]);
}

/** A zip end-of-central-directory record whose comment-length field says `length` (default: the comment's real length). */
function zipEndRecord(comment = '', length = comment.length) {
  const record = Buffer.alloc(22);
  record.set(ZIP_SIGNATURES[2]);
  record.writeUInt16LE(length, 20);
  return Buffer.concat([record, Buffer.from(comment)]);
}

const zipLocalHeader = () => Buffer.concat([ZIP_SIGNATURES[1], Buffer.alloc(26)]);

test('env templates: the carried http-mcp template passes as it stands, and a gate run on the head finds nothing for the file rules', () => {
  const carried = readFileSync(path.join(REPO_ROOT, TEMPLATE), 'utf8');
  assert.deepEqual(scanned(scanEnvTemplates, { [TEMPLATE]: carried }), []);
  const head = { dir: REPO_ROOT, commit: git(REPO_ROOT, ['rev-parse', 'HEAD']) };
  const report = JSON.parse(runGate(gateArgs(head, 'generic')).stdout);
  assert.deepEqual(report.findings.filter((finding) => FILE_RULES.includes(finding.rule)), []);
});

test('env templates: each public setting passes only its typed value, and the token lifetime keeps 60 to 3600', () => {
  const settings = {
    DACS_ACCESS_TOKEN_TTL_SECONDS: [['60', '900', '3600', '"900"'], ['59', '3601', '0', '-60', '900.5', '1e3', '0x384', '0060', '+900', 'soon', '<seconds>']],
    PORT: [['0', '8787', '65535'], ['65536', '80a']],
    DACS_RATE_LIMIT_PER_MINUTE: [['10', '100000'], ['9', '100001']],
    DACS_TRUST_PROXY: [['0', '1'], ['2', 'true']],
    DACS_AUTH_MODE: [['builtin', 'external'], ['Builtin', 'REPLACE_ME']],
    DACS_EMBEDDED_WALLET_WRITES: [['off', 'simulated-loopback', 'testnet-held'], ['on']],
    DACS_LOG_LEVEL: [['debug', 'info', 'warn', 'error', 'silent'], ['verbose', realValue()]],
    DACS_PUBLIC_ORIGIN: [['https://dacs-plugin.example.invalid', 'http://127.0.0.1:8787', 'https://dacs-plugin.example.invalid/'], [
      `https://user:${realValue()}@dacs-plugin.example.invalid`, `https://${realValue()}@dacs-plugin.example.invalid`, `https://dacs-plugin.example.invalid/${realValue()}`,
      `https://dacs-plugin.example.invalid?key=${realValue()}`, 'https://dacs-plugin.example.invalid#x', 'ftp://dacs-plugin.example.invalid', 'https://DACS-plugin.example.invalid', realValue()]],
    DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN: [['http://127.0.0.1:<fixture-port>'], ['http://127.0.0.1:<port-7731>', 'http://<host>:1', 'http://127.0.0.1:<fixture-port>/x']],
    DACS_ALLOWED_REDIRECT_ORIGINS: [['https://chatgpt.com', 'https://chatgpt.com,https://dacs-plugin.example.invalid'], ['https://chatgpt.com, https://chatgpt.com', 'https://chatgpt.com,', `https://chatgpt.com,${realValue()}`]],
    DACS_CIMD_ALLOWED_HOSTS: [['chatgpt.com', 'chatgpt.com,dacs-plugin.example.invalid'], ['chatgpt', 'https://chatgpt.com', 'Chatgpt.com', `chatgpt.com,${realValue()}`]],
    HOST: [['0.0.0.0', '127.0.0.1'], ['0.0.0.0:8787', realValue()]],
    DACS_DATA_DIR: [['/data', '/var/lib/dacs-data'], ['data', '/data/', '/data dir', realValue()]],
    DACS_CHAIN_NETWORK: [['demos-testnet'], ['demos-testnet-7731', 'Demos', realValue()]],
  };
  for (const [key, [passing, failing]] of Object.entries(settings)) {
    for (const value of ['', ...passing]) assert.deepEqual(envFindings(`${key}=${value}\n`), [], `${key}=${value} passes`);
    for (const value of failing) assert.deepEqual(envFindings(`${key}=${value}\n`), ENV_REFUSED, `${key}=${value} fails`);
  }
});

test('env templates: every key that is not a listed public setting may only be empty or a placeholder, whatever its name', () => {
  const unlisted = ['DACS_OAUTH_COOKIE_KEYS', 'AUTHKEY', 'COOKIEKEY', 'CLIENTSECRET', 'AWSSecretKey', 'TOKEN2', 'PRIVATEKEYS', 'JWT_KEY', 'DACS_IDENTITY_GITHUB_PAT',
    'BEARER', 'AUTHORIZATION', 'WALLET_KEY', 'WEBHOOK_URL', 'ZORBLAT_QUIM', 'LOG_LEVEL', 'dacs_log_level', 'RESEED', 'constructor', 'toString', '__proto__'];
  const placeholders = ['', '""', "''", 'REPLACE_ME', 'CHANGE_ME', 'xxx', 'XXXXXXXX', '${FROM_SECRET_MANAGER}', '<your-key>', 'your-api-token-here'];
  for (const key of unlisted) {
    for (const line of [`${key}=${realValue()}`, `${key}="${realValue()}"`, `export ${key}=${realValue()}`, `# ${key}=${realValue()}`]) assert.deepEqual(envFindings(`${line}\n`), ENV_REFUSED, line);
    for (const value of placeholders) assert.deepEqual(envFindings(`${key}=${value}\n`), [], `${key}=${value} passes`);
  }
});

test('env templates: placeholders are a closed set: shell defaults, dashed slots and labels with digits are real values', () => {
  const notPlaceholders = [`\${X:-${realValue()}}`, '${value-with-dashes}', '${}', `<${realValue()}>`, '<>', '<Your-Key>', 'your-key-7731-here', 'your--here', 'changeme', 'replace_me', 'xx', `REPLACE_ME${realValue()}`];
  for (const value of notPlaceholders) assert.deepEqual(envFindings(`API_TOKEN=${value}\n`), ENV_REFUSED, value);
});

test('env templates: commented assignments are read in every form, prose comments pass, and any other line fails', () => {
  const value = realValue();
  for (const line of [`# API_TOKEN = ${value}`, `#API_TOKEN: ${value}`, `## API_TOKEN=${value}`, `##API_TOKEN=${value}`, `#  export API_TOKEN=${value}`,
    `# DACS_LOG_LEVEL=${value}`, `# builtin: ${value}`, `# Authorization: ${value}`]) assert.deepEqual(envFindings(`${line}\n`), ENV_REFUSED, line);
  const carriedProse = ['# Authorization: builtin (wallet-login OAuth 2.1 server at /oauth) or external.',
    '# builtin: comma-separated random secrets, >= 32 chars each, for OAuth cookies.', "# external: your identity provider's exact issuer identifier."];
  for (const line of [...carriedProse, '# A note about tokens and secrets.', '#', '﻿# heading']) assert.deepEqual(envFindings(`${line}\n`), [], line);
  for (const line of [value, `API_TOKEN = REPLACE_ME`, 'API_TOKEN: REPLACE_ME', '-----BEGIN NOTE-----'])assert.deepEqual(envFindings(`${line}\n`), ENV_REFUSED, line);
  assert.deepEqual(envFindings(`DACS_LOG_LEVEL=info\r\n\r\n${value}\rAPI_TOKEN=\n`), ['R-ENV content .env.example 3']);
});

test('env templates: a template that is not readable text is a finding, not a pass', () => {
  for (const bytes of [Buffer.from([0x41, 0x00, 0x42]), Buffer.from([0x41, 0xff])]) assert.deepEqual(scanned(scanEnvTemplates, { 'http-mcp/.env.example': bytes }), ['R-ENV content http-mcp/.env.example -']);
});

test('file names: R-ENV reads every env template, stage-named ones included; R-HOSTING leaves those and source files alone', () => {
  const planted = `API_TOKEN=${realValue()}\n`;
  const templates = ['.env.example', '.env.sample', '.env.template', 'prod.env.example', 'http-mcp/.env.sample', '.env.production.example', 'http-mcp/.env.local.sample',
    '.env.prod.template', 'app/.ENV.Staging.Example', 'x.env.staging.sample', 'env.example', 'env.production.example'];
  for (const file of templates) {
    assert.deepEqual(envFindings(planted, file), [`R-ENV content ${file} 1`], `${file} is read by R-ENV`);
    assert.deepEqual(scanned(scanHostingFiles, { [file]: planted }), [], `${file} is not refused by name`);
  }
  for (const file of ['http-mcp/env.mjs', 'notes.example', 'config.env.json', '.env.example.md', 'dacs.service.example']) assert.deepEqual(envFindings(planted, file), [], `${file} is not an env template`);
  const sources = ['src/env.mjs', 'auth.service.mjs', 'src/auth.service.test.mjs', 'docs/deployment.md', 'src/redeploy/run.mjs', 'deploy.md', 'src/service.mjs', 'docs/caddyfile-notes.md'];
  assert.deepEqual(scanned(scanHostingFiles, Object.fromEntries(sources.map((file) => [file, 'x\n']))), []);
});

test('hosting files: deploy paths, systemd units, Caddyfiles and real env files fail, template and backup names included', () => {
  // config.env.json is refused on purpose: a name with an `env` segment that is not a template is read as a real env file.
  const refused = ['deploy/up.sh', 'http-mcp/deploy/notes/readme.md', 'Deploy/up.sh', 'deploy/.env.example', 'dacs.service', 'etc/DACS.Service', 'dacs.service.example',
    'dacs.service.sample', 'dacs.service.template', 'dacs.service.bak', 'Caddyfile', 'ops/caddyfile', 'Caddyfile.example', 'Caddyfile.sample', 'Caddyfile.template',
    'Caddyfile.prod', 'Caddyfile.bak', 'prod.caddyfile', '.env', 'http-mcp/.env.production', 'prod.env', '.env.example.md', 'config.env.json'];
  assert.deepEqual(scanned(scanHostingFiles, Object.fromEntries(refused.map((file) => [file, 'x\n']))), refused.map((file) => `R-HOSTING path ${file} -`));
});

test('file names: a name with very many segments is parsed in linear time', () => {
  // A quadratic parse of these names takes minutes; the child process is killed long before that.
  const script = `import * as rules from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts/public-gate/rules-files.mjs')).href)};
    const names = ['.env' + '.env'.repeat(100000) + 'x', '.env' + '.x'.repeat(200000) + '.example', 'dacs' + '.service'.repeat(50000) + '.mjs'];
    const entries = names.map((name, index) => ({ position: index + 1, path: name, oid: 'b'.repeat(40), bytes: Buffer.from('x\\n') }));
    for (const scan of [rules.scanEnvTemplates, rules.scanHostingFiles, rules.scanArchives]) scan({ entries, config: {}, limits: { maxReportEntries: 10 } });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: LINEAR_SCAN_DEADLINE_MS });
  assert.equal(result.signal, null, 'the scan finished before its deadline');
  assert.equal(result.status, 0, result.stderr);
});

test('archives: every tar form fails, text-only v7 and a tar behind a text block included, with or without a binary disposition and under any name', () => {
  const archives = {
    v7: Buffer.concat([tarHeader({ size: 4 }), Buffer.alloc(TAR_BLOCK_BYTES)]),
    textV7: textOnlyTar(),
    textV7Behind: Buffer.concat([Buffer.alloc(TAR_BLOCK_BYTES, 0x61), textOnlyTar()]),
    ustar: tarHeader({ magic: 'ustar\x0000' }),
    gnu: tarHeader({ magic: 'ustar  \x00' }),
    pax: tarHeader({ magic: 'ustar\x0000', type: 'x' }),
    empty: Buffer.alloc(2 * TAR_BLOCK_BYTES),
  };
  for (const [form, bytes] of Object.entries(archives)) {
    for (const file of ['docs/notes.md', 'assets/logo.png', 'a.tar']) {
      const config = { textExtensions: ['.md'], binaryDispositions: [{ path: file, sha256: sha256(bytes), reason: 'reviewed in this test' }] };
      const entries = [{ position: 1, path: file, oid: PLANTED_BLOB, bytes }];
      if (file === 'assets/logo.png' || form.startsWith('text')) assert.deepEqual(unscannableEntries(entries, config), [], `${form} ${file} is readable`);
      assert.deepEqual(scanArchives({ entries, config, limits: LIMITS }).map((finding) => `${finding.rule} ${finding.kind}`), ['R-ARCHIVE content'], `${form} ${file}`);
    }
  }
  const badChecksum = Buffer.from(textOnlyTar());
  badChecksum.write('0000001 ', 148);
  const prose = 'A long note that stays prose. '.repeat(40);
  assert.deepEqual(scanned(scanArchives, { 'a/bad-checksum.txt': badChecksum, 'a/prose.md': prose, 'a/ustar.txt': `ustar ${prose}` }), []);
});

test('archives: zip, gzip and other compressed blobs fail; a zip signature anywhere in text fails; prose that only names one passes', () => {
  const stub = Buffer.from('#!/bin/sh\nexec unzip "$0"\n');
  const planted = {
    'tools/setup.sh': Buffer.concat([stub, zipLocalHeader(), zipEndRecord()]),
    'tools/overstated.dat': Buffer.concat([stub, zipLocalHeader(), zipEndRecord('', 500)]),
    'tools/understated.dat': Buffer.concat([stub, zipLocalHeader(), zipEndRecord('comment longer than its length', 0)]),
    'tools/maximum.dat': Buffer.concat([stub, zipEndRecord('c'.repeat(0xffff))]),
    'tools/trailing.dat': Buffer.concat([stub, zipEndRecord(), Buffer.from('padding')]),
    'docs/notes.txt': gzipSync('hello'),
    'a/deflate.bin': deflateRawSync('hello'),
    'a/brotli.bin': brotliCompressSync('hello'),
    'a/xz.bin': Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04]),
    'a/bzip2.bin': Buffer.concat([Buffer.from('BZh91AY&SY'), Buffer.from([0x8f, 0xe1, 0x22, 0x7c])]),
    'a/7z.bin': Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
    'a/zstd.bin': Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58]),
    ...Object.fromEntries(ZIP_SIGNATURES.map((signature, index) => [`text/signature-${index}.md`, Buffer.concat([Buffer.from('notes '), signature, Buffer.from(' more notes\n')])])),
    'text/far.md': Buffer.concat([Buffer.from('notes '), ZIP_SIGNATURES[2], Buffer.alloc(70_000, 0x41)]),
  };
  assert.deepEqual(scanned(scanArchives, planted), Object.keys(planted).map((file) => `R-ARCHIVE content ${file} -`));
  assert.deepEqual(scanned(scanArchives, { 'a/escaped.md': 'the end record starts PK\\x05\\x06\n', 'a/pk.txt': 'PK is text\n', 'a/empty.txt': '' }), []);
});

test('archives: any vendor directory fails by path in any letter case, and a vendor-like name does not', () => {
  assert.deepEqual(scanned(scanArchives, { 'vendor/lib/a.js': 'x\n', 'http-mcp/Vendor/b.js': 'x\n', 'VENDOR/c.js': 'x\n' }), ['R-ARCHIVE path vendor/lib/a.js -', 'R-ARCHIVE path http-mcp/Vendor/b.js -', 'R-ARCHIVE path VENDOR/c.js -']);
  assert.deepEqual(scanned(scanArchives, { 'src/vendors.mjs': 'x\n', 'docs/vendor.md': 'x\n' }), []);
});

test('file rules: findings past the report limit fail with the limit cause', () => {
  const overLimit = [[scanEnvTemplates, { '.env.example': 'API_TOKEN=bad\n'.repeat(3) }], [scanHostingFiles, { 'a.service': '', 'b.service': '', 'c.service': '' }], [scanArchives, { 'vendor/a': '', 'vendor/b': '', 'vendor/c': '' }]];
  for (const [scan, files] of overLimit) assert.throws(() => scanned(scan, files, { maxReportEntries: 2 }), (error) => error instanceof GateInputError && error.cause === 'limit:maxReportEntries');
});

test('the gate registers the three file rules, reports each one, and refuses a binary even when it is unreviewed', () => {
  const clean = JSON.parse(runGate(gateArgs(createRepo([{ path: 'a.txt', content: 'clean\n' }]), 'generic')).stdout);
  assert.deepEqual(clean.rules.map((rule) => rule.id), ['R-ACCOUNT', 'R-ARCHIVE', 'R-ENV', 'R-HOST', 'R-HOSTING', 'R-IP', 'R-PRIVATE']);
  assert.deepEqual(clean.findings, []);

  const planted = createRepo([
    { path: 'deploy/up.sh', content: 'x\n' },
    { path: '.env.example', content: `API_TOKEN=${realValue()}\n` },
    { path: 'dacs.service.example', content: `[Service]\nEnvironment="DACS_OAUTH_COOKIE_KEYS=${realValue()}"\n` },
    { path: 'http-mcp/.env.sample', content: '../secrets/real.env', mode: '120000' },
  ]);
  const findings = JSON.parse(runGate(gateArgs(planted, 'generic')).stdout).findings.filter((finding) => FILE_RULES.includes(finding.rule));
  assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.kind} ${finding.line ?? '-'}`).sort(), ['R-ENV content 1', 'R-ENV content 1', 'R-HOSTING path -', 'R-HOSTING path -']);

  const binary = createRepo([{ path: 'assets/bundle.bin', content: tarHeader() }]);
  const result = runGate(gateArgs(binary, 'generic'));
  assert.equal(result.status, 2, 'an unreviewed binary is unscannable');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.kind]), [['R-ARCHIVE', 'content']]);
  assert.equal(report.rules.find((rule) => rule.id === 'R-ARCHIVE').status, 'findings');
});
