import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RunBoundedError, runBounded } from '../lib/run-bounded.mjs';
import { GateInputError } from './objects.mjs';
import { textOf } from './rules-address.mjs';

/** Id of the rule that refuses dynamic code evaluation outside the exactly listed generated files. */
export const EVAL_RULE_ID = 'R-EVAL';

const PARSER_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-eval-child.mjs');
const SCRIPT_KIND_BY_EXTENSION = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx' };
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
/** The `type` values of an HTML script element that a browser runs as code; any other type is a data block. */
const SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);
const UNIT_CAUSES = ['eval-parse-error', 'eval-computed-member'];
const GENERATED_KEYS = ['path', 'reason', 'sha256'];
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/dgi;
const EVENT_HANDLER = /\s(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/dgi;
const TYPE_ATTRIBUTE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(quot|amp|lt|gt|apos));/gi;

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

/** Returns a function from a character index to its 1-based line; the indexes it is asked for must not decrease. */
function lineCounter(text) {
  let line = 1;
  let from = 0;
  return (index) => {
    for (let at = text.indexOf('\n', from); at !== -1 && at < index; at = text.indexOf('\n', from)) {
      line += 1;
      from = at + 1;
    }
    return line;
  };
}

const decodeEntities = (value) => value.replace(ENTITY, (whole, hex, decimal, name) => {
  if (name) return NAMED_ENTITIES[name.toLowerCase()];
  const codePoint = hex ? parseInt(hex, 16) : Number(decimal);
  return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : whole;
});

/** The code an HTML blob runs inline, as units { kind, text, firstLine }: each executable script body, and each event-handler attribute as a function body. */
function htmlUnits(html) {
  const scriptLine = lineCounter(html);
  const scripts = [...html.matchAll(SCRIPT_ELEMENT)].flatMap((match) => {
    const type = TYPE_ATTRIBUTE.exec(match[1]);
    const isCode = SCRIPT_TYPES.has((type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase());
    return isCode && match[2].trim() !== '' ? [{ kind: 'js', text: match[2], firstLine: scriptLine(match.indices[2][0]) }] : [];
  });
  const handlerLine = lineCounter(html);
  const handlers = [...html.matchAll(EVENT_HANDLER)].map((match) => ({
    kind: 'js', text: `(function () {${decodeEntities(match[2] ?? match[3] ?? match[4])}\n})`, firstLine: handlerLine(match.index + 1),
  }));
  return [...scripts, ...handlers];
}

/** The units of code in a text blob at `file`: the whole file for a script extension, the inline code for HTML, none otherwise. */
function unitsOf(file, text) {
  const extension = path.posix.extname(file).toLowerCase();
  if (Object.hasOwn(SCRIPT_KIND_BY_EXTENSION, extension)) return [{ kind: SCRIPT_KIND_BY_EXTENSION[extension], text, firstLine: 1 }];
  return HTML_EXTENSIONS.has(extension) ? htmlUnits(text) : [];
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
 * unscannable { entry, cause } with cause eval-parse-error, eval-computed-member, eval-parse-timeout or limit:maxEvalUnitBytes.
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

  function occurrencesIn(entries) {
    const occurrences = [];
    for (const entry of entries) {
      if (entry.path === null || entry.kind !== 'blob' || !entry.bytes) continue;
      const key = `${entry.path}\0${sha256Of(entry.bytes)}`;
      if (listedPaths.has(entry.path)) {
        heldPaths.add(entry.path);
        heldExact.add(key);
      }
      const text = exact.has(key) ? null : textOf(entry);
      if (text === null) continue;
      const units = unitsOf(entry.path, text).map((unit) => ({ ...unit, key: `${unit.kind}\0${sha256Of(unit.text)}` }));
      if (units.length > 0) occurrences.push({ entry, units });
    }
    return occurrences;
  }

  async function scan(entries) {
    const occurrences = occurrencesIn(entries);
    await parseMissing(occurrences.flatMap(({ units }) => units));
    const findings = [];
    const unscannable = [];
    for (const { entry, units } of occurrences) {
      const lines = new Set(units.flatMap(({ key, firstLine }) => results.get(key).lines.map((line) => firstLine + line - 1)));
      lines.forEach((line) => findings.push({ rule: EVAL_RULE_ID, kind: 'content', entry, line }));
      new Set(units.flatMap(({ key }) => results.get(key).cause ?? [])).forEach((cause) => unscannable.push({ entry, cause }));
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
