import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GITLEAKS_PIN } from '../../scripts/ci/install-gitleaks.mjs';

const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A GitHub-token-shaped value built at run time, so no key-shaped literal is committed. */
export const plantedKey = () => `${['ghp', '_'].join('')}${Array.from(randomBytes(36), (byte) => BASE62[byte % BASE62.length]).join('')}`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The stub's program: `version` prints the configured version; `dir` records what it was given (arguments, working folder,
 * the SHA-256 of every file under its source folder after the wrapper's one-line header, that header's size, each file's
 * inode, the ignore and config files) to the log, then reports one finding per configured marker found in a file, on the
 * line the real scanner would give (counted from the first line of the file, header included; line 0 for a find with no
 * marker, which matches on the file name alone), leaves out each one the ignore file names as `file:rule:line`, as the
 * real scanner does, and exits with the configured status.
 * `hang` never exits; `flood` writes past any cap.
 */
const STUB_SOURCE = (settings) => `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const settings = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
const after = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'version') {
  fs.appendFileSync(settings.log, JSON.stringify({ args, self: process.argv[1] }) + '\\n');
  console.log(settings.version);
  process.exit(0);
}
const source = args[args.length - 1];
const files = Object.fromEntries(fs.readdirSync(source).map((name) => [name, fs.readFileSync(source + '/' + name)]));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const headerBytes = (bytes) => bytes.indexOf(10) + 1;
const afterHeader = (bytes) => bytes.subarray(headerBytes(bytes));
const readOptional = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
fs.appendFileSync(settings.log, JSON.stringify({
  args, self: process.argv[1], cwd: process.cwd(), source, blobs: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(afterHeader(bytes))])),
  headers: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: headerBytes(bytes), first: bytes.subarray(0, 1).toString('latin1'), size: bytes.length }])),
  inodes: Object.fromEntries(Object.keys(files).map((name) => [name, fs.statSync(source + '/' + name).ino])),
  ignore: readOptional(after('--gitleaks-ignore-path')), configSha256: digest(fs.readFileSync(after('--config'))),
}) + '\\n');
if (settings.flood) { process.stdout.write(Buffer.alloc(1 << 20, 97)); }
if (settings.hang) setInterval(() => {}, 1000);
else {
  const ignored = new Set((readOptional(after('--gitleaks-ignore-path')) ?? '').split('\\n'));
  const lineOf = (bytes, marker) => (marker === undefined ? 0 : 1 + bytes.subarray(0, bytes.indexOf(marker)).filter((byte) => byte === 10).length);
  const found = Object.entries(files).flatMap(([name, bytes]) => settings.finds
    .filter(({ marker, file }) => (marker === undefined || bytes.toString('latin1').includes(marker)) && (file === undefined || new RegExp(file).test(name)))
    .map(({ marker, rule }) => ({ File: name, RuleID: rule, StartLine: lineOf(bytes, marker) })))
    .filter(({ File, RuleID, StartLine }) => !ignored.has(File + ':' + RuleID + ':' + StartLine));
  fs.writeFileSync(after('--report-path'), settings.rawReport ?? JSON.stringify(found));
  process.exit(settings.exitCode ?? (found.length > 0 ? 3 : 0));
}
`;

/**
 * Writes a stub gitleaks program. Returns { binary, sha256, calls() } where `calls()` lists every invocation it logged; a
 * `version` call is { args, self } and a `dir` call also holds the folder, blob digests, ignore and config it was given.
 * `settings`: version, finds [{ marker?, rule, file? }] (`file`: a pattern the scanned file's name must match), exitCode, rawReport, hang, flood.
 */
export function writeStubGitleaks(settings = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gate-stub-gitleaks-'));
  const log = path.join(directory, 'calls.log');
  const binary = path.join(directory, 'gitleaks');
  writeFileSync(binary, STUB_SOURCE({ version: GITLEAKS_PIN.version, finds: [], ...settings, log }));
  chmodSync(binary, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { binary, sha256: sha256(readFileSync(binary)), calls };
}

/** Skips test `t` and returns true when `scanner` (from findPinnedGitleaks) is null; in CI a missing binary fails instead, so it cannot pass as a skip. */
export function skipWithoutScanner(t, scanner) {
  if (scanner) return false;
  assert.ok(!process.env.CI, 'CI must provide the pinned gitleaks (GITLEAKS_BIN or PATH)');
  t.skip('the pinned gitleaks is not installed here');
  return true;
}

/** The real gitleaks named by GITLEAKS_BIN, or on PATH, when it reports the pinned version; else null. Returns { binary, sha256 }. */
export function findPinnedGitleaks() {
  const binary = process.env.GITLEAKS_BIN || (() => {
    try {
      return execFileSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  if (!binary) return null;
  try {
    const reported = execFileSync(binary, ['version'], { encoding: 'utf8' }).trim();
    return reported === GITLEAKS_PIN.version ? { binary, sha256: sha256(readFileSync(binary)) } : null;
  } catch {
    return null;
  }
}
