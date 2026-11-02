import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { unscannableEntries } from '../../scripts/public-gate/gate.mjs';
import { GateInputError } from '../../scripts/public-gate/objects.mjs';
import { scanArchives, scanEnvTemplates, scanHostingFiles } from '../../scripts/public-gate/rules-files.mjs';
import { createRepo, gateArgs, REPO_ROOT, runGate, sha256 } from '../lib/gate-fixtures.mjs';

const LIMITS = { maxReportEntries: 1000 };
const TEMPLATE = 'http-mcp/.env.example';
const TAR_MAGIC_OFFSET = 257;
const TAR_BLOCK_BYTES = 512;
const PLANTED_BLOB = 'b'.repeat(40);

/** Planted values are built here, so no value that reads as a credential is written out in this file. */
const realValue = () => ['wombat', 'quartz', 'ember', '7731'].join('-');

const toEntries = (files) => Object.entries(files).map(([file, content], index) => ({ position: index + 1, path: file, oid: PLANTED_BLOB, bytes: Buffer.from(content) }));

/** Each finding as `<rule> <kind> <path> <line>`, in the order the rule returned them. */
function scanned(scan, files, limits = LIMITS) {
  return scan({ entries: toEntries(files), config: {}, limits }).map((finding) => `${finding.rule} ${finding.kind} ${finding.entry.path} ${finding.line ?? '-'}`);
}

const envFindings = (text, file = '.env.example') => scanned(scanEnvTemplates, { [file]: text });

const tarball = () => {
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  block.write('ustar\0', TAR_MAGIC_OFFSET);
  return block;
};
const zipArchive = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]);

test('env templates: the carried http-mcp template passes as it stands; the token lifetime passes from 60 to 3600 and fails outside or non-integer; a credential key with a planted non-placeholder value fails; an unknown secret-named key fails unless empty or a placeholder; table-drive SIGNING_KEY, PRIVATE_KEY, MNEMONIC, SEED_PHRASE, PASSPHRASE, CLIENT_SECRET, API_TOKEN, signing_key, signing-key and signingKey: each runtime-built real value fails, empty and placeholder values pass, and LOG_LEVEL passes as the non-secret control', () => {
  const carried = readFileSync(path.join(REPO_ROOT, TEMPLATE), 'utf8');
  assert.deepEqual(scanned(scanEnvTemplates, { [TEMPLATE]: carried }), []);

  const lifetime = (value) => envFindings(`DACS_ACCESS_TOKEN_TTL_SECONDS=${value}\n`);
  for (const value of ['60', '900', '3600', '']) assert.deepEqual(lifetime(value), [], `lifetime ${value}`);
  for (const value of ['59', '3601', '0', '-60', '900.5', '1e3', '0x384', 'soon']) assert.deepEqual(lifetime(value), ['R-ENV content .env.example 1'], `lifetime ${value}`);

  assert.deepEqual(envFindings('DACS_OAUTH_COOKIE_KEYS=REPLACE_ME\nDACS_OAUTH_COOKIE_KEYS=\n'), []);
  assert.deepEqual(envFindings(`# header\nDACS_OAUTH_COOKIE_KEYS=${realValue()}\n`), ['R-ENV content .env.example 2']);

  const placeholders = ['', 'REPLACE_ME', '<your-key>', 'changeme', '${FROM_SECRET_MANAGER}'];
  for (const key of ['SIGNING_KEY', 'PRIVATE_KEY', 'MNEMONIC', 'SEED_PHRASE', 'PASSPHRASE', 'CLIENT_SECRET', 'API_TOKEN', 'signing_key', 'signing-key', 'signingKey']) {
    assert.deepEqual(envFindings(`${key}=${realValue()}\n`), ['R-ENV content .env.example 1'], `${key} real value`);
    assert.deepEqual(envFindings(`${key}="${realValue()}"\n`), ['R-ENV content .env.example 1'], `${key} quoted real value`);
    assert.deepEqual(envFindings(`# ${key}=${realValue()}\n`), ['R-ENV content .env.example 1'], `${key} commented real value`);
    for (const value of placeholders) assert.deepEqual(envFindings(`${key}=${value}\n`), [], `${key} ${value}`);
  }
  assert.deepEqual(envFindings(`LOG_LEVEL=${realValue()}\nDACS_LOG_LEVEL=info\n`), []);
});

test('env templates: a secret or qualifier word run together with another word is still a secret name; non-secret names stay clear', () => {
  const runTogether = ['AUTHKEY', 'COOKIEKEY', 'COOKIEKEYS', 'CLIENTSECRET', 'GITHUBTOKEN', 'SESSIONSECRET', 'JWTSECRET', 'ADMINPASSWORD', 'APIKEY', 'dacsAuthkey', 'DACS_GITHUBTOKEN'];
  for (const key of runTogether) {
    assert.deepEqual(envFindings(`${key}=${realValue()}\n`), ['R-ENV content .env.example 1'], `${key} real value`);
    assert.deepEqual(envFindings(`# ${key}=${realValue()}\n`), ['R-ENV content .env.example 1'], `${key} commented real value`);
    for (const value of ['', 'REPLACE_ME', '<your-key>']) assert.deepEqual(envFindings(`${key}=${value}\n`), [], `${key} ${value}`);
  }
  for (const key of ['MONKEY', 'TURKEY', 'HOTKEY', 'KEYBOARD', 'LOG_LEVEL', 'DACS_PORT', 'NODE_ENV']) assert.deepEqual(envFindings(`${key}=${realValue()}\n`), [], `${key} is not a secret name`);
});

test('env templates: a line that is not an assignment fails, and only env template names are read', () => {
  assert.deepEqual(envFindings(`first=1\n${realValue()}\n\n# comment\n`), ['R-ENV content .env.example 2']);
  assert.deepEqual(envFindings(`API_TOKEN = ${realValue()}\n`), ['R-ENV content .env.example 1']);
  const planted = `API_TOKEN=${realValue()}\n`;
  for (const file of ['.env.example', 'prod.env.example', 'prod.env.sample', 'http-mcp/.env.sample', 'http-mcp/.env.template']) assert.deepEqual(envFindings(planted, file), [`R-ENV content ${file} 1`], file);
  for (const file of ['.env.production.example', 'http-mcp/.env.local.sample', '.env.prod.template', 'app/.ENV.Staging.Example', '.env.a.b.example', 'prod.env.local.sample', 'env.production.example']) {
    assert.deepEqual(envFindings(planted, file), [`R-ENV content ${file} 1`], `${file} is read by R-ENV`);
    assert.deepEqual(scanned(scanHostingFiles, { [file]: planted }), [], `${file} is not refused by name, since R-ENV reads it`);
  }
  for (const file of ['http-mcp/env.mjs', 'notes.example', 'config.env.json', 'http-mcp/.env.example.md']) assert.deepEqual(envFindings(planted, file), [], file);
});

test('env templates: findings past the report limit fail with the limit cause', () => {
  const lines = 'API_TOKEN=bad\n'.repeat(3);
  assert.throws(() => scanned(scanEnvTemplates, { '.env.example': lines }, { maxReportEntries: 2 }), (error) => error instanceof GateInputError && error.cause === 'limit:maxReportEntries');
});

test('hosting files: a deploy directory, a systemd unit, a Caddyfile or a real env file fails; .example and .template files are scanned instead', () => {
  const refused = {
    'deploy/up.sh': 'x\n', 'http-mcp/deploy/notes/readme.md': 'x\n', 'Deploy/up.sh': 'x\n', 'dacs.service': 'x\n', 'etc/DACS.Service': 'x\n',
    Caddyfile: 'x\n', 'ops/caddyfile': 'x\n', '.env': 'x\n', 'http-mcp/.env.production': 'x\n', 'prod.env': 'x\n',
  };
  assert.deepEqual(scanned(scanHostingFiles, refused), Object.keys(refused).map((file) => `R-HOSTING path ${file} -`));
  const scannedInstead = ['.env.example', '.env.sample', '.env.template', 'dacs.service.example', 'dacs.service.template', 'Caddyfile.example', 'Caddyfile.template',
    'src/env.mjs', 'docs/deployment.md', 'src/redeploy/run.mjs', 'src/service.mjs', 'docs/caddyfile-notes.md'];
  assert.deepEqual(scanned(scanHostingFiles, Object.fromEntries(scannedInstead.map((file) => [file, 'x\n']))), []);
});

test('archives: a committed tarball, gzip or zip fails by content signature whatever its name, and a vendor directory fails', () => {
  const planted = { 'assets/logo.png': tarball(), 'docs/notes.txt': gzipSync('hello'), 'src/readme.md': zipArchive(), 'a.tgz': Buffer.from([0x1f, 0x8b, 0x08]), 'empty.dat': Buffer.from('PK\x05\x06') };
  const entries = Object.entries(planted).map(([file, bytes], index) => ({ position: index + 1, path: file, oid: PLANTED_BLOB, bytes }));
  const findings = scanArchives({ entries, config: {}, limits: LIMITS });
  assert.deepEqual(findings.map(({ rule, kind, entry, line }) => [rule, kind, entry.path, line]), Object.keys(planted).map((file) => ['R-ARCHIVE', 'content', file, undefined]));
  assert.deepEqual(scanned(scanArchives, { 'vendor/lib/a.js': 'x\n', 'http-mcp/Vendor/b.js': 'x\n' }), ['R-ARCHIVE path vendor/lib/a.js -', 'R-ARCHIVE path http-mcp/Vendor/b.js -']);
  assert.deepEqual(scanned(scanArchives, { 'src/vendors.mjs': 'x\n', 'docs/vendor.md': 'x\n', 'src/plain.txt': 'ustar\n', 'src/pk.txt': 'PK is text\n', 'src/sig.bin': Buffer.alloc(TAR_BLOCK_BYTES) }), []);
  const nearMiss = Buffer.alloc(TAR_BLOCK_BYTES);
  nearMiss.write('ustar', TAR_MAGIC_OFFSET + 1);
  assert.deepEqual(scanned(scanArchives, { 'x.bin': nearMiss }), []);
});

test('archives: a zip with a prepended stub or trailing bytes fails by its end-of-central-directory record whatever its comment length says; text that only mentions the signature passes', () => {
  const END_RECORD_BYTES = 22;
  const COMMENT_LENGTH_OFFSET = 20;
  const endRecord = (comment = '') => {
    const record = Buffer.alloc(END_RECORD_BYTES);
    record.set([0x50, 0x4b, 0x05, 0x06]);
    record.writeUInt16LE(comment.length, COMMENT_LENGTH_OFFSET);
    return Buffer.concat([record, Buffer.from(comment)]);
  };
  const overstated = (length, comment = '') => {
    const record = endRecord(comment);
    record.writeUInt16LE(length, COMMENT_LENGTH_OFFSET);
    return record;
  };
  const stub = Buffer.from('#!/bin/sh\nexec unzip "$0"\n');
  const prefixed = Buffer.concat([stub, zipArchive(), endRecord()]);
  const planted = {
    'tools/setup.sh': prefixed,
    'tools/commented.dat': Buffer.concat([stub, endRecord('built by a stub')]),
    'tools/trailing.dat': Buffer.concat([stub, endRecord(), Buffer.from('padding')]),
    'tools/large.dat': Buffer.concat([Buffer.alloc(100000, 0x41), endRecord()]),
    'tools/overstated.dat': Buffer.concat([stub, zipArchive(), overstated(500)]),
    'tools/understated.dat': Buffer.concat([stub, zipArchive(), overstated(0, 'comment longer than its length')]),
    'tools/edge.dat': Buffer.concat([stub, endRecord('c'.repeat(0xffff))]),
  };
  const entries = Object.entries(planted).map(([file, bytes], index) => ({ position: index + 1, path: file, oid: PLANTED_BLOB, bytes }));
  assert.deepEqual(scanArchives({ entries, config: {}, limits: LIMITS }).map((finding) => [finding.rule, finding.kind, finding.entry.path]), Object.keys(planted).map((file) => ['R-ARCHIVE', 'content', file]));

  const clear = {
    'a/far.dat': Buffer.concat([stub, endRecord(), Buffer.alloc(70000, 0x41)]),
    'a/cut.dat': Buffer.concat([stub, endRecord().subarray(0, END_RECORD_BYTES - 1)]),
    'a/text.md': 'the PK\x05\x06 marker\n',
  };
  assert.deepEqual(scanned(scanArchives, clear), []);
});

test('archives: an archive classified as binary still fails the archive rule', () => {
  const bytes = tarball();
  const config = { textExtensions: ['.md'], binaryDispositions: [{ path: 'assets/bundle.bin', sha256: sha256(bytes), reason: 'reviewed in this test' }] };
  const entries = [{ position: 1, path: 'assets/bundle.bin', oid: PLANTED_BLOB, bytes }];
  assert.deepEqual(unscannableEntries(entries, config), [], 'the reviewed binary is classified as readable');
  assert.deepEqual(scanArchives({ entries, config, limits: LIMITS }).map((finding) => finding.rule), ['R-ARCHIVE']);

  const repo = createRepo([{ path: 'assets/bundle.bin', content: bytes }]);
  const result = runGate(gateArgs(repo, 'generic'));
  assert.equal(result.status, 2, 'an unreviewed binary is unscannable');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.kind]), [['R-ARCHIVE', 'content']]);
  assert.equal(report.rules.find((rule) => rule.id === 'R-ARCHIVE').status, 'findings');
});

test('the gate registers the three file rules and reports each one for a clean repository', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const report = JSON.parse(runGate(gateArgs(repo, 'generic')).stdout);
  assert.deepEqual(report.rules.map((rule) => rule.id), ['R-ACCOUNT', 'R-ARCHIVE', 'R-ENV', 'R-HOST', 'R-HOSTING', 'R-IP', 'R-PRIVATE']);
  const planted = createRepo([{ path: 'deploy/up.sh', content: 'x\n' }, { path: '.env.example', content: `API_TOKEN=${realValue()}\n` }]);
  const findings = JSON.parse(runGate(gateArgs(planted, 'generic')).stdout).findings;
  assert.deepEqual(findings.map((finding) => finding.rule).sort(), ['R-ENV', 'R-HOSTING']);
});
