import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RunBoundedError, runBounded } from '../lib/run-bounded.mjs';
import { classifyBlob } from './classify.mjs';
import { GateInputError } from './objects.mjs';
import { textOf } from './rules-address.mjs';

/** Id of the rule that refuses dynamic code evaluation outside the exactly listed generated files. */
export const EVAL_RULE_ID = 'R-EVAL';

const PARSER_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-eval-child.mjs');
/** The unit kind of each extension the rule reads: a JS or TS file, or an HTML file whose code only the child takes out. */
const UNIT_KIND_BY_EXTENSION = new Map(Object.entries({ '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.html': 'html', '.htm': 'html' }));
/** Whether a lower-case file extension is parsed as HTML by the eval rule. */
export const isHtmlExtension = (extension) => UNIT_KIND_BY_EXTENSION.get(extension) === 'html';
const UNIT_CAUSES = ['eval-parse-error', 'eval-computed-member', 'eval-too-deep', 'eval-html-unreadable'];
const GENERATED_KEYS = ['path', 'reason', 'sha256'];

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * Whether `config.evalGeneratedFiles` is well formed: a list of { path, sha256 (64 lower-case hex digits), reason }, no other
 * key and no path twice. Each entry exempts exactly the file at that path with exactly those bytes.
 */
export function hasValidEvalConfig({ evalGeneratedFiles }) {
  return Array.isArray(evalGeneratedFiles)
    && evalGeneratedFiles.every((row) => row !== null && typeof row === 'object' && isDeepStrictEqual(Object.keys(row).sort(), GENERATED_KEYS) && isText(row.path) && /^[0-9a-f]{64}$/.test(row.sha256) && isText(row.reason))
    && new Set(evalGeneratedFiles.map((row) => row.path)).size === evalGeneratedFiles.length;
}

/** Splits `units` into runs whose texts hold at most `maxBytes` together; a unit over it is alone in its run. */
function batchesOf(units, maxBytes) {
  const batches = [];
  let bytes = 0;
  for (const unit of units) {
    const size = Buffer.byteLength(unit.text);
    if (batches.length === 0 || bytes + size > maxBytes) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1).push(unit);
    bytes += size;
  }
  return batches;
}

const parserFailure = () => new GateInputError('eval-parser-failed', 'the eval parser stopped with an error status or wrote an unexpected result');

/** The parser's results for `count` units, checked against the protocol; throws GateInputError(eval-parser-failed) for anything else. */
function decodeResults(stdout, count, maxLines) {
  let results;
  try {
    results = JSON.parse(stdout.toString('utf8')).results;
  } catch {
    throw parserFailure();
  }
  const isResult = (result) => result !== null && typeof result === 'object' && Array.isArray(result.lines) && result.lines.length <= maxLines
    && result.lines.every((line) => Number.isSafeInteger(line) && line > 0) && (result.cause === undefined || UNIT_CAUSES.includes(result.cause));
  if (!Array.isArray(results) || results.length !== count || !results.every(isResult)) throw parserFailure();
  return results.map(({ lines, cause }) => ({ lines, cause }));
}

/**
 * Creates the eval rule's scanner for one run. `config` holds `evalGeneratedFiles`, `limits` the eval limits and `maxReportEntries`;
 * `parser` ({ command, args }) is the parser child, replaceable only for tests. The scanner keeps each parsed unit's result by the
 * unit's kind and the SHA-256 of its text, so shared bytes are parsed once; every occurrence is still judged by its own path.
 * `scan(entries)` returns { findings, unscannable } for the entries ({ path, kind, bytes, ... }) of one tree:
 * findings { rule, kind: 'content', entry, line } for each line of dynamic evaluation outside an exact generated file, and
 * unscannable { entry, cause } with cause eval-symlink, eval-not-text, eval-parse-error, eval-computed-member, eval-too-deep, eval-html-unreadable, eval-parse-timeout or limit:maxEvalUnitBytes.
 * It throws GateInputError for a bad parser reply (eval-parser-failed), too many findings (limit:maxReportEntries) and
 * the run-bounded causes (output limit, spawn failure, interrupt). `requireNoStaleException()` throws
 * GateInputError(stale-eval-exception) when a listed path was scanned only at other bytes than its entry names.
 */
export function createEvalScanner({ config, limits, signal, parser = { command: process.execPath, args: [PARSER_CHILD] } }) {
  const listed = config.evalGeneratedFiles;
  const exact = new Set(listed.map((row) => `${row.path}\0${row.sha256}`));
  const listedPaths = new Set(listed.map((row) => row.path));
  const heldPaths = new Set();
  const heldExact = new Set();
  const results = new Map();
  const maxLines = limits.maxReportEntries + 1;

  async function parseBatch(batch) {
    const input = JSON.stringify({ units: batch.map(({ kind, text }) => ({ kind, text })), maxLines });
    let parsed;
    try {
      const { status, stdout } = await runBounded({ ...parser, env: {}, input, signal, maxOutputBytes: limits.maxEvalOutputBytes, deadlineMs: limits.evalDeadlineMs });
      if (status !== 0) throw parserFailure();
      parsed = decodeResults(stdout, batch.length, maxLines);
    } catch (error) {
      if (!(error instanceof RunBoundedError && error.cause === 'subprocess-timeout')) throw error;
      parsed = batch.map(() => ({ lines: [], cause: 'eval-parse-timeout' }));
    }
    batch.forEach(({ key }, index) => results.set(key, parsed[index]));
  }

  async function parseMissing(units) {
    const pending = new Map();
    for (const unit of units) {
      if (results.has(unit.key) || pending.has(unit.key)) continue;
      if (Buffer.byteLength(unit.text) > limits.maxEvalUnitBytes) results.set(unit.key, { lines: [], cause: 'limit:maxEvalUnitBytes' });
      else pending.set(unit.key, unit);
    }
    for (const batch of batchesOf([...pending.values()], limits.maxEvalBatchBytes)) await parseBatch(batch);
  }

  /**
   * What the rule makes of one entry, decided in this order: nothing for a path without a script or HTML extension or one the reader
   * already reports as unscannable; `eval-symlink` for a symlink, never followed and never exempt; `eval-not-text` for a blob
   * that is not text; nothing for an exact generated file; else the unit { kind, text, key } to judge.
   */
  function outcomeOf(entry) {
    const kind = entry.path === null ? undefined : UNIT_KIND_BY_EXTENSION.get(path.posix.extname(entry.path).toLowerCase());
    if (kind === undefined || entry.problem || !entry.bytes) return {};
    const text = textOf(entry);
    if (text === null && classifyBlob(entry.path, entry.bytes, config).problem) return {};
    if (entry.kind === 'symlink') return { cause: 'eval-symlink' };
    if (text === null) return { cause: 'eval-not-text' };
    if (listedPaths.has(entry.path)) {
      const listedKey = `${entry.path}\0${sha256Of(entry.bytes)}`;
      heldPaths.add(entry.path);
      heldExact.add(listedKey);
      if (exact.has(listedKey)) return {};
    }
    return { unit: { kind, text, key: `${kind}\0${sha256Of(text)}` } };
  }

  async function scan(entries) {
    const outcomes = entries.map((entry) => ({ entry, ...outcomeOf(entry) }));
    await parseMissing(outcomes.flatMap(({ unit }) => unit ?? []));
    const findings = [];
    const unscannable = [];
    for (const { entry, cause, unit } of outcomes) {
      const result = unit === undefined ? { lines: [], cause } : results.get(unit.key);
      result.lines.forEach((line) => findings.push({ rule: EVAL_RULE_ID, kind: 'content', entry, line }));
      if (result.cause !== undefined) unscannable.push({ entry, cause: result.cause });
      if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
    }
    return { findings, unscannable };
  }

  function requireNoStaleException() {
    if (listed.some((row) => heldPaths.has(row.path) && !heldExact.has(`${row.path}\0${row.sha256}`))) {
      throw new GateInputError('stale-eval-exception', 'an evalGeneratedFiles entry names a path the target holds only at other bytes');
    }
  }

  return { scan, requireNoStaleException };
}
