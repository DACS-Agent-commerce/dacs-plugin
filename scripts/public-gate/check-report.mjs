import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { EXIT, loadConfig, REGISTERED_RULE_IDS, requireValue } from './gate.mjs';
import { IDENTITY_RULE_ID } from './history.mjs';
import { describeSelectedRefs, FULL_OBJECT_ID, GateInputError, resolveSelectedRefs } from './objects.mjs';
import { SHA256_HEX, STATUSES, writeDiagnostic } from './redact.mjs';
import { SEMVER } from './secret-scan.mjs';

/** Largest report or review context accepted; a file over it is refused after reading at most one byte more. */
const MAX_CHECK_FILE_BYTES = 1024 * 1024;

const FLAGS = ['--report', '--head', '--context', '--repo', '--refs'];
const HISTORY_SCOPE = 'history';
const REPORT_KEYS = ['findings', 'rules', 'scanner', 'scope', 'target', 'unscannable'];
/** The review context: exactly these fields, each matching its pattern. Later checks add theirs with the report fields they bind. */
const CONTEXT_FIELDS = {
  gateRevision: SHA256_HEX, configSha256: SHA256_HEX, scannerVersion: SEMVER, scannerPolicySha256: SHA256_HEX, secretExceptionsSha256: SHA256_HEX, expectedRoot: FULL_OBJECT_ID, wordingListSha256: SHA256_HEX,
};
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

/** True when `target` has the shape of a history report's: its heads are object ids, its refs and the number of commits are present. */
const hasHistoryTarget = (target) => hasExactKeys(target, ['commits', 'heads', 'refs']) && Array.isArray(target.refs)
  && Array.isArray(target.heads) && target.heads.every((head) => FULL_OBJECT_ID.test(head));

const hasTreeTarget = (target) => hasExactKeys(target, ['commit', 'tree']) && FULL_OBJECT_ID.test(target.commit) && FULL_OBJECT_ID.test(target.tree);

/**
 * True when `report` has the shape the gate writes: `target` is exactly a commit and a tree id (a history report's: its heads, refs and
 * commit count), `rules` entries are exactly an id and a known status, `findings` and `unscannable` are lists.
 */
function hasGateShape({ scope, target, rules, findings, unscannable }) {
  return (scope === HISTORY_SCOPE ? hasHistoryTarget(target) : hasTreeTarget(target))
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

/** Resolves the refs the run being checked selects, from `--repo` and `--refs` (as in history mode); throws ChoiceError `bad-arguments` without them. */
function resolveRunRefs(flags) {
  const repo = requireValue(flags, '--repo');
  return resolveSelectedRefs({ repo, refs: requireValue(flags, '--refs').split(','), limits: loadConfig().limits });
}

/**
 * Judges `report` (a parsed gate report) against the head and the review context. It trusts nothing in the report: the
 * expected values are the head, this gate's registered rule ids and the context's scanner identity, and for a history
 * report the refs of the run being checked (`selectedRefs`, as resolveSelectedRefs returns them), which it must name with
 * the same full names and object ids, tag objects included, and whose heads must be exactly the distinct commits of those
 * refs, sorted. Returns undefined when the report is a passing complete report
 * with the head as its commit, or a passing history report with the head among its heads, else the cause of the first refusal.
 */
function refusalCause(report, { head, context, selectedRefs }) {
  const isHistory = report.scope === HISTORY_SCOPE;
  if (report.scope !== 'complete' && !isHistory) return 'report-not-complete';
  if (!(isHistory ? report.target.heads : [report.target.commit]).includes(head)) return 'report-other-head';
  const heads = isHistory ? [...new Set(selectedRefs.map(({ commit }) => commit))].sort() : [];
  if (isHistory && !(isDeepStrictEqual(report.target.refs, describeSelectedRefs(selectedRefs)) && isDeepStrictEqual(report.target.heads, heads))) return 'report-refs-differ';
  const registeredIds = isHistory ? [...REGISTERED_RULE_IDS, IDENTITY_RULE_ID] : REGISTERED_RULE_IDS;
  const reportedIds = Array.isArray(report.rules) ? report.rules.map((rule) => rule?.id).sort() : [];
  if (!isDeepStrictEqual(reportedIds, [...registeredIds].sort())) return 'report-rules-differ';
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
    const report = readReport(reportFile);
    const context = readContext(contextFile);
    const selectedRefs = report.scope === HISTORY_SCOPE ? await resolveRunRefs(flags) : undefined;
    const cause = refusalCause(report, { head, context, selectedRefs });
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
