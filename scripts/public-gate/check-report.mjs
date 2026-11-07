import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { EXIT, REGISTERED_RULE_IDS, requireValue } from './gate.mjs';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';
import { SHA256_HEX, STATUSES, writeDiagnostic } from './redact.mjs';

/** Largest report or review context accepted; a file over it is refused after reading at most one byte more. */
const MAX_CHECK_FILE_BYTES = 1024 * 1024;

const FLAGS = ['--report', '--head', '--context'];
const REPORT_KEYS = ['findings', 'rules', 'scanner', 'scope', 'target', 'unscannable'];
/** The review context: exactly these fields, each matching its pattern. Later checks add theirs with the report fields they bind. */
const CONTEXT_FIELDS = { gateRevision: SHA256_HEX, configSha256: SHA256_HEX, expectedRoot: FULL_OBJECT_ID };
const ROUTE = 'check-report.stderr';

/** Reads `file` as one JSON object of at most MAX_CHECK_FILE_BYTES; throws GateInputError `<subject>-unreadable`, `<subject>-malformed` or `limit:maxCheckFileBytes`. */
function readJsonObject(file, subject) {
  let text;
  try {
    // Non-blocking, so a FIFO is refused by the check below instead of waiting for a writer.
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(descriptor).isFile()) throw new GateInputError(`${subject}-unreadable`, `--${subject} is not a regular file`);
      const buffer = Buffer.alloc(MAX_CHECK_FILE_BYTES + 1);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (length > MAX_CHECK_FILE_BYTES) throw new GateInputError('limit:maxCheckFileBytes', `--${subject} is over ${MAX_CHECK_FILE_BYTES} bytes`);
      text = buffer.toString('utf8', 0, length);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    throw error instanceof GateInputError ? error : new GateInputError(`${subject}-unreadable`, `--${subject} cannot be read (${error.code ?? error.name})`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* not JSON: refused below */ }
  throw new GateInputError(`${subject}-malformed`, `--${subject} is not a JSON object`);
}

const hasExactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), keys);

/** True when `report` has the shape the gate writes: `target` is exactly a commit and a tree id, `rules` entries are exactly an id and a known status, `findings` and `unscannable` are lists. */
function hasGateShape({ target, rules, findings, unscannable }) {
  return hasExactKeys(target, ['commit', 'tree']) && FULL_OBJECT_ID.test(target.commit) && FULL_OBJECT_ID.test(target.tree)
    && Array.isArray(rules) && rules.every((rule) => hasExactKeys(rule, ['id', 'status']) && typeof rule.id === 'string' && STATUSES.includes(rule.status))
    && Array.isArray(findings) && Array.isArray(unscannable);
}

function readReport(file) {
  const report = readJsonObject(file, 'report');
  if (!isDeepStrictEqual(Object.keys(report).sort(), REPORT_KEYS) || !hasGateShape(report)) throw new GateInputError('report-malformed', '--report does not hold exactly the report fields');
  return report;
}

function readContext(file) {
  const context = readJsonObject(file, 'context');
  const valid = isDeepStrictEqual(Object.keys(context).sort(), Object.keys(CONTEXT_FIELDS).sort())
    && Object.entries(CONTEXT_FIELDS).every(([name, pattern]) => typeof context[name] === 'string' && pattern.test(context[name]));
  if (!valid) throw new GateInputError('context-malformed', '--context does not hold exactly the review context fields');
  return context;
}

/**
 * Judges `report` (a parsed gate report) against the head and the review context. It trusts nothing in the report: the
 * expected values are the head, this gate's registered rule ids and the context's scanner identity. Returns undefined
 * when the report is a complete passing one for exactly those, else the cause of the first refusal.
 */
function refusalCause(report, { head, context }) {
  if (report.scope !== 'complete') return 'report-not-complete';
  if (report.target?.commit !== head) return 'report-other-head';
  const reportedIds = Array.isArray(report.rules) ? report.rules.map((rule) => rule?.id).sort() : [];
  if (!isDeepStrictEqual(reportedIds, [...REGISTERED_RULE_IDS].sort())) return 'report-rules-differ';
  if (!isDeepStrictEqual(report.scanner, context)) return 'report-policy-differs';
  const passing = report.rules.every((rule) => rule.status === 'passed') && isDeepStrictEqual(report.findings, []) && isDeepStrictEqual(report.unscannable, []);
  return passing ? undefined : 'report-not-passing';
}

/**
 * Runs check-report for `argv` (`--report <file> --head <full-sha> --context <file>`) and returns the exit code: 0 the
 * report is a complete passing report for the head under the context, 1 it is refused, 2 missing, oversized or malformed
 * input. It writes nothing on success and only a cause and its fixed text on failure.
 */
async function main(argv) {
  try {
    const flags = parseFlags(argv, FLAGS);
    const head = requireValue(flags, '--head', FULL_OBJECT_ID);
    const reportFile = requireValue(flags, '--report');
    const contextFile = requireValue(flags, '--context');
    const cause = refusalCause(readReport(reportFile), { head, context: readContext(contextFile) });
    if (cause === undefined) return EXIT.pass;
    await writeDiagnostic(cause, ROUTE);
    return EXIT.findings;
  } catch (error) {
    await writeDiagnostic(error instanceof ChoiceError || error instanceof GateInputError ? error.cause : 'internal-error', ROUTE);
    return EXIT.unusable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
