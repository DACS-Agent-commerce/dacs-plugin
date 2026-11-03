import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runBounded } from '../lib/run-bounded.mjs';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';

/** The id of the rule that reports what the scanner found in the target's blobs. */
export const SECRET_RULE_ID = 'R-SECRET';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY_FILE = path.join(REPO_ROOT, '.gitleaks.toml');
const RUN_DIRECTORY_PREFIX = 'gate-secret-scan-';
const PRIVATE_BINARY_NAME = 'gitleaks';
const IGNORE_FILE_NAME = '.gitleaksignore';
const LEAKS_EXIT_CODE = 3;
const VERSION_DEADLINE_MS = 30_000;
const VERSION_OUTPUT_BYTES = 4096;
/** A scanner version: three dot-separated numbers. */
export const SEMVER = /^\d+\.\d+\.\d+$/;
const RULING_KEYS = ['blob', 'line', 'path', 'reason', 'rule'];
/**
 * The scanner skips a file as binary when the file type of its first read is an application type, and some of those types
 * are recognised by bytes at a fixed offset (tar at 257, DICOM at 128, ISO at 32769) as well as at offset 0. Each blob is
 * therefore written behind a one-line header of text that spans every such offset the blob could reach, so no byte the
 * target controls sits where the scanner looks: SHORT_HEADER_BYTES passes the last offset below 262 (tar's `ustar` ends
 * at 261); a blob that can reach the ISO check (a first read of 32774 bytes or more) gets LONG_HEADER_BYTES instead.
 */
const SHORT_HEADER_BYTES = 262;
const LONG_HEADER_BYTES = 32_774;
const HEADER_LINES = 1;

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isRuling = (entry) => entry !== null && typeof entry === 'object' && isDeepStrictEqual(Object.keys(entry).sort(), RULING_KEYS)
  && typeof entry.path === 'string' && entry.path !== '' && FULL_OBJECT_ID.test(entry.blob) && typeof entry.rule === 'string' && entry.rule !== ''
  && Number.isSafeInteger(entry.line) && entry.line > 0 && typeof entry.reason === 'string' && entry.reason !== '';

/** True when `config` names the scanner version and holds `secretBaseline` and `secretExceptions` as lists of exact rulings: path, blob id, rule id, line and reason. */
export const hasValidSecretConfig = (config) => SEMVER.test(config.scanner?.version)
  && [config.secretBaseline, config.secretExceptions].every((list) => Array.isArray(list) && list.every(isRuling));

/** The scan's identity for the report: the scanner version, the SHA-256 of the policy file and the SHA-256 of the baseline and exception entries. */
export function secretScanIdentity(config) {
  return {
    scannerVersion: config.scanner.version,
    scannerPolicySha256: sha256Of(readFileSync(POLICY_FILE)),
    secretExceptionsSha256: sha256Of(JSON.stringify({ baseline: config.secretBaseline, exceptions: config.secretExceptions })),
  };
}

const coversOccurrence = (rulings, entry, rule, line) => rulings.some((ruling) => ruling.path === entry.path && ruling.blob === entry.oid && ruling.rule === rule && ruling.line === line);

function requireNoStaleException(entries, exceptions) {
  const stale = exceptions.find((exception) => !entries.some((entry) => entry.path === exception.path && entry.oid === exception.blob));
  if (stale) throw new GateInputError('stale-secret-exception', 'a secretExceptions entry names a path and blob the target does not hold');
}

/** Copies the scanner to `directory`, checks the copy's SHA-256 and version, and returns the copy's path; only that copy is ever run. */
async function privateVerifiedBinary({ binary, sha256, version, directory, environment, signal }) {
  const copy = path.join(directory, PRIVATE_BINARY_NAME);
  try {
    await copyFile(binary, copy);
    await chmod(copy, 0o700);
  } catch (error) {
    throw new GateInputError('scanner-missing', `the gitleaks binary cannot be copied (${error.code ?? error.name})`);
  }
  if (sha256Of(await readFile(copy)) !== sha256) throw new GateInputError('scanner-checksum-mismatch', 'the gitleaks binary does not match its SHA-256');
  const result = await runBounded({ command: copy, args: ['version'], env: environment, signal, maxOutputBytes: VERSION_OUTPUT_BYTES, deadlineMs: VERSION_DEADLINE_MS });
  if (result.status !== 0 || result.stdout.toString().trim() !== version) throw new GateInputError('scanner-version-mismatch', `the gitleaks binary does not report version ${version}`);
  return copy;
}

/** The text a blob is written behind: one line `#` plus spaces, long enough that no fixed-offset file-type check can read the blob's bytes. */
const scanHeader = (blobBytes) => {
  const size = blobBytes + SHORT_HEADER_BYTES >= LONG_HEADER_BYTES ? LONG_HEADER_BYTES : SHORT_HEADER_BYTES;
  return `#${' '.repeat(size - 2)}\n`;
};

/** Writes each distinct blob once under the neutral name `b<n>`, behind its one-line header; returns Map(name -> the entries that hold that blob). */
async function exportBlobs(entries, directory) {
  const occurrences = new Map();
  const namesByBlob = new Map();
  for (const entry of entries.filter(({ bytes }) => bytes)) {
    if (!namesByBlob.has(entry.oid)) {
      const name = `b${namesByBlob.size + 1}`;
      namesByBlob.set(entry.oid, name);
      occurrences.set(name, []);
      await writeFile(path.join(directory, name), Buffer.concat([Buffer.from(scanHeader(entry.bytes.length)), entry.bytes]), { flag: 'wx', mode: 0o600 });
    }
    occurrences.get(namesByBlob.get(entry.oid)).push(entry);
  }
  return occurrences;
}

/** The run-owned ignore: a baseline ruling, remapped to a neutral name, only for a blob whose every occurrence is that ruling's own path and blob. */
function remappedBaseline(baseline, occurrences) {
  return [...occurrences].flatMap(([name, entries]) => baseline
    .filter((ruling) => entries.every((entry) => entry.path === ruling.path && entry.oid === ruling.blob))
    .map((ruling) => `${name}:${ruling.rule}:${ruling.line + HEADER_LINES}\n`)).join('');
}

const malformedReport = (why) => new GateInputError('scanner-report-malformed', `the scanner report ${why}`);

/** Reads the scanner's JSON report: at most `maxScanReportBytes`, a list of at most `maxReportEntries` items of { File, RuleID, StartLine }. */
async function readReport(file, limits) {
  const { size } = await stat(file).catch(() => { throw malformedReport('was not written'); });
  if (size > limits.maxScanReportBytes) throw new GateInputError('limit:maxScanReportBytes', `the scanner report is over ${limits.maxScanReportBytes} bytes`);
  let items;
  try {
    items = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw malformedReport('is not JSON');
  }
  if (!Array.isArray(items)) throw malformedReport('is not a list');
  if (items.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `the scanner reported more than ${limits.maxReportEntries} findings`);
  const valid = items.every((item) => typeof item?.File === 'string' && typeof item.RuleID === 'string' && Number.isSafeInteger(item.StartLine) && item.StartLine > 0);
  if (!valid) throw malformedReport('has an item without a file, rule and line');
  return items;
}

/** Maps each reported (neutral name, rule, line) to its occurrences, with the line counted from the blob's own first line, and keeps those no ruling covers, one finding per occurrence and line. */
function occurrenceFindings(items, occurrences, rulings) {
  const findings = new Map();
  for (const { File, RuleID, StartLine } of items) {
    const entries = occurrences.get(path.posix.basename(File));
    if (!entries) throw malformedReport('names a file the scan did not hold');
    const line = StartLine - HEADER_LINES;
    if (line < 1) throw malformedReport('names a line of the header, not of a blob');
    for (const entry of entries.filter((candidate) => !coversOccurrence(rulings, candidate, RuleID, line))) {
      findings.set(`${entry.position}:${line}`, { rule: SECRET_RULE_ID, kind: 'content', entry, line });
    }
  }
  return [...findings.values()];
}

/**
 * Scans the exact blobs of `entries` (from readCommitObjects) with the pinned gitleaks, which `scanner` ({ binary, sha256 })
 * names. A private copy of the binary must match the SHA-256 and report `config.scanner.version` before anything is
 * written. Each distinct blob is written once under a neutral name in a fresh private folder (removed on every exit) and
 * scanned with the gate's own policy and a run-owned ignore. Findings are judged per occurrence: one that a baseline or
 * `secretExceptions` ruling covers exactly (path, blob, rule, line) is dropped. Returns findings `{ rule, kind, entry, line }`.
 * Throws GateInputError: stale-secret-exception, scanner-missing, -checksum-mismatch, -version-mismatch, -failed,
 * scanner-report-malformed, limit:maxScanReportBytes or limit:maxReportEntries; RunBoundedError for a deadline, an output
 * over the cap, an interrupt or a spawn failure.
 */
export async function scanSecrets({ entries, config, scanner, signal }) {
  requireNoStaleException(entries, config.secretExceptions);
  const directory = await mkdtemp(path.join(tmpdir(), RUN_DIRECTORY_PREFIX));
  try {
    const environment = { LC_ALL: 'C', HOME: directory };
    const binary = await privateVerifiedBinary({ binary: scanner.binary, sha256: scanner.sha256, version: config.scanner.version, directory, environment, signal });
    const blobDirectory = path.join(directory, 'blobs');
    await mkdir(blobDirectory);
    const occurrences = await exportBlobs(entries, blobDirectory);
    const ignoreFile = path.join(directory, IGNORE_FILE_NAME);
    const reportFile = path.join(directory, 'report.json');
    await writeFile(ignoreFile, remappedBaseline(config.secretBaseline, occurrences), { flag: 'wx', mode: 0o600 });
    const args = [
      'dir', '--config', POLICY_FILE, '--gitleaks-ignore-path', ignoreFile, '--redact=100', '--ignore-gitleaks-allow', '--no-banner',
      '--report-format', 'json', '--report-path', reportFile, '--exit-code', String(LEAKS_EXIT_CODE), '.',
    ];
    const { status } = await runBounded({
      command: binary, args, cwd: blobDirectory, env: environment, signal, maxOutputBytes: config.limits.secretScanOutputBytes, deadlineMs: config.limits.secretScanDeadlineMs,
    });
    if (status !== 0 && status !== LEAKS_EXIT_CODE) throw new GateInputError('scanner-failed', `the scanner exited with status ${status}`);
    const items = await readReport(reportFile, config.limits);
    if ((status === LEAKS_EXIT_CODE) !== (items.length > 0)) throw malformedReport('disagrees with the scanner status');
    return occurrenceFindings(items, occurrences, [...config.secretBaseline, ...config.secretExceptions]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
