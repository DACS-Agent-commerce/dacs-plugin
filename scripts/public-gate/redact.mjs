import { writeFileSync } from 'node:fs';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';
import { ACCOUNT_RULE_ID, HOST_RULE_ID, IP_RULE_ID } from './rules-address.mjs';
import { EVAL_RULE_ID } from './rules-eval.mjs';
import { ARCHIVE_RULE_ID, ENV_RULE_ID, HOSTING_RULE_ID } from './rules-files.mjs';
import { PRIVATE_RULE_ID } from './rules-private.mjs';
import { ISSUE_RULE_ID, REPORT_RULE_ID } from './rules-text.mjs';
import { SECRET_RULE_ID, SEMVER } from './secret-scan.mjs';

/** Every output route. All output leaves through this module on one of these; later checkers register theirs. */
export const DIAGNOSTIC_ROUTES = Object.freeze({ 'gate.stdout': 'stdout', 'gate.report-file': 'file', 'gate.stderr': 'stderr', 'check-report.stderr': 'stderr', 'install-gitleaks.stderr': 'stderr', 'rules-eval-child.stderr': 'stderr' });

/** Schema values shared by every report: a SHA-256 digest, a rule status and an unscannable entry's cause. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const STATUSES = ['passed', 'findings', 'not-run', 'unscannable'];
export const UNSCANNABLE_CAUSES = ['invalid-utf8-path', 'submodule', 'limit:maxBlobBytes', 'nul-or-invalid-utf8-text', 'binary-without-disposition', 'eval-parse-error', 'eval-computed-member', 'eval-too-deep', 'eval-parse-timeout', 'limit:maxEvalUnitBytes'];
const SCOPES = ['generic', 'complete'];
const RULE_IDS = [ACCOUNT_RULE_ID, HOST_RULE_ID, IP_RULE_ID, EVAL_RULE_ID, ENV_RULE_ID, HOSTING_RULE_ID, ARCHIVE_RULE_ID, REPORT_RULE_ID, ISSUE_RULE_ID, PRIVATE_RULE_ID, SECRET_RULE_ID];
const KINDS = ['path', 'content'];

/** The fixed text printed after each cause; nothing else ever reaches stderr. A `limit:<name>` cause has one shared text. */
const DIAGNOSTICS = {
  'missing-choice': 'a required choice is missing', 'invalid-choice': 'a choice is not one of its allowed values',
  'oversized-choice': 'a choice value is too long', 'bad-arguments': 'the arguments are malformed (see docs/PUBLIC-GATE.md)',
  'invalid-config': 'public-gate.config.json is malformed', 'private-list-unreadable': 'the private list cannot be read as a regular file',
  'private-list-in-repo': 'the private list is inside the repository', 'private-list-empty': 'the private list holds no entry',
  'private-list-malformed': 'the private list is not UTF-8 or has a line with leading or trailing whitespace',
  timeout: 'git did not finish before its deadline', interrupted: 'the run was interrupted', 'git-unavailable': 'git could not run',
  'git-refused': 'git refused the request', 'unknown-commit': 'the repository has no such commit',
  'not-a-commit': '--commit names an object that is not a commit', 'empty-tree': 'the commit has no files',
  'malformed-listing': 'git ls-tree returned a record this gate cannot parse', 'malformed-batch': 'git cat-file returned an unexpected record',
  'missing-object': 'the repository is missing a blob its tree names', 'output-limit': 'git produced more output than allowed',
  'bad-ref': 'a ref is empty or starts with a dash', 'unknown-ref': 'the repository has no commit for one of the refs',
  'unexpected-root': 'the history does not have the expected single root commit',
  'shallow-history': 'the repository is a shallow clone, so its history is cut off',
  'pr-text-unreadable': 'the --pr-text file cannot be read', 'pr-text-malformed': 'the --pr-text file is not a JSON array of objects',
  'output-exists': 'the --out file already exists', 'output-unwritable': 'the --out file cannot be written',
  'evidence-exists': 'the --private-evidence file already exists', 'evidence-unwritable': 'the --private-evidence file cannot be written',
  'report-unreadable': 'the --report file cannot be read as a regular file', 'report-malformed': 'the --report file is not a gate report',
  'context-unreadable': 'the --context file cannot be read as a regular file', 'context-malformed': 'the --context file is not a review context',
  'report-not-complete': 'the report is not a complete-scope report', 'report-other-head': 'the report is for another commit than --head',
  'report-rules-differ': 'the report lists other rules than this gate registers', 'report-policy-differs': 'the report was made under another gate revision, configuration or root than the review context names',
  'report-not-passing': 'the report has a finding, an unscannable entry or a rule that did not pass',
  'download-too-large': 'a download is larger than allowed', 'download-timeout': 'a download did not finish before its deadline',
  'download-http-failure': 'the download server did not answer with success', 'download-truncated': 'a download ended before its announced length',
  'download-checksum-mismatch': 'a download does not match its pinned SHA-256', 'download-redirect-refused': 'a download address or redirect is not an https URL',
  'download-too-many-redirects': 'a download was redirected too many times', 'download-destination-exists': 'the download file already exists',
  'download-failed': 'a download failed before it finished', 'subprocess-timeout': 'a subprocess did not finish before its deadline',
  'subprocess-output-limit': 'a subprocess wrote more output than allowed', 'subprocess-spawn-failed': 'a subprocess could not start',
  'unsupported-platform': 'the pinned gitleaks archive is not for this platform', 'install-exists': 'the gitleaks binary already exists in the folder',
  'install-dir-unwritable': 'the install folder cannot be prepared', 'install-extract-failed': 'the gitleaks archive could not be extracted',
  'install-binary-invalid': 'the archive does not hold gitleaks as a regular file', 'install-version-mismatch': 'the binary does not report the pinned version',
  'scanner-missing': 'the gitleaks binary cannot be copied for the scan', 'scanner-checksum-mismatch': 'the gitleaks binary does not match its SHA-256',
  'scanner-version-mismatch': 'the gitleaks binary does not report the pinned version', 'scanner-failed': 'the scanner stopped with an error status',
  'scanner-report-malformed': 'the scanner report is missing, malformed or disagrees with its status', 'stale-secret-exception': 'a secretExceptions entry names a path and blob the target does not hold',
  'stale-lockfile-disposition': 'a lockfileDispositions entry names a path the target holds only at another blob',
  'stale-eval-exception': 'an evalGeneratedFiles entry names a path the target holds only at other bytes',
  'eval-parser-failed': 'the eval parser stopped with an error status or wrote an unexpected result',
  'internal-error': 'the gate failed unexpectedly', limit: 'a configured limit was reached',
};

/** Returns `value` when it is one of `allowed` (an array) or a string matching it (a RegExp); else throws Error. */
export function checked(value, allowed) {
  if (Array.isArray(allowed) ? allowed.includes(value) : typeof value === 'string' && allowed.test(value)) return value;
  throw new Error('a report value is outside the report schema');
}

/** Returns `value` when it is a positive safe integer; else throws Error. */
export function counted(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new Error('a report number is outside the report schema');
}

function writeNew(file, text, subject, mode) {
  try {
    writeFileSync(file, text, { flag: 'wx', mode });
  } catch (error) {
    throw new GateInputError(`${subject}-${error.code === 'EEXIST' ? 'exists' : 'unwritable'}`, `the ${subject} file cannot be created (${error.code ?? error.name})`);
  }
}

function deliver(route, text, file) {
  const sink = DIAGNOSTIC_ROUTES[route];
  if (sink === 'file') return writeNew(file, text, 'output', 0o666);
  return new Promise((resolve, reject) => {
    process[sink].write(text, (error) => (error ? reject(new GateInputError('output-unwritable', `${sink} cannot be written`)) : resolve()));
  });
}

/**
 * Builds the public report and the private evidence. The report is built field by field from enum values, object ids,
 * SHA-256 digests and positive integers, each checked against its schema, so its bytes never depend on the private list.
 * Each location is `<commit>:<position>` (the object reader's position); the evidence maps each to its exact path, or
 * `hex:<bytes>` for a name that is not UTF-8. `unscannable` is [{ entry, cause }], `findings` [{ rule, kind, entry, line? }].
 * Returns { report, evidence } as text; throws Error when a value is outside the schema.
 */
export function buildOutputs({ scope, target, scanner, rules, unscannable, findings }) {
  const commit = checked(target.commit, FULL_OBJECT_ID);
  const exactPaths = new Map();
  const locate = (entry) => {
    const location = `${commit}:${counted(entry.position)}`;
    exactPaths.set(entry.position, [location, entry.path ?? `hex:${entry.pathBytes.toString('hex')}`]);
    return location;
  };
  const { gateRevision, configSha256, expectedRoot, scannerVersion, scannerPolicySha256, secretExceptionsSha256 } = scanner;
  const report = {
    scope: checked(scope, SCOPES),
    target: { commit, tree: checked(target.tree, FULL_OBJECT_ID) },
    scanner: {
      gateRevision: checked(gateRevision, SHA256_HEX), configSha256: checked(configSha256, SHA256_HEX), scannerVersion: checked(scannerVersion, SEMVER),
      scannerPolicySha256: checked(scannerPolicySha256, SHA256_HEX), secretExceptionsSha256: checked(secretExceptionsSha256, SHA256_HEX),
      ...(expectedRoot === undefined ? {} : { expectedRoot: checked(expectedRoot, FULL_OBJECT_ID) }),
    },
    rules: rules.map(({ id, status }) => ({ id: checked(id, RULE_IDS), status: checked(status, STATUSES) })),
    unscannable: unscannable.map(({ entry, cause }) => ({ location: locate(entry), cause: checked(cause, UNSCANNABLE_CAUSES) })),
    findings: findings.map(({ rule, kind, entry, line }) => ({
      rule: checked(rule, RULE_IDS), kind: checked(kind, KINDS), location: locate(entry), ...(line === undefined ? {} : { line: counted(line) }),
    })),
  };
  const mapping = [...exactPaths].sort(([first], [second]) => first - second).map(([, pair]) => pair);
  return { report: `${JSON.stringify(report, null, 2)}\n`, evidence: `${JSON.stringify(Object.fromEntries(mapping), null, 2)}\n` };
}

/**
 * Writes `report` to stdout or to the new file `out`; only once that succeeded, writes `evidence` to the new owner-only
 * (0600) file `evidenceFile` when one is given. The two writes are not atomic together: a crash between them leaves a
 * report without evidence. Throws GateInputError(output-exists, output-unwritable, evidence-exists or evidence-unwritable).
 */
export async function publish({ report, evidence }, { out, evidenceFile }) {
  await deliver(out ? 'gate.report-file' : 'gate.stdout', report, out);
  if (evidenceFile) writeNew(evidenceFile, evidence, 'evidence', 0o600);
}

/** Writes `<cause>: <fixed text>` to stderr, on `route` (a stderr route); a cause without a fixed text is written as internal-error. */
export function writeDiagnostic(cause, route = 'gate.stderr') {
  const known = Object.hasOwn(DIAGNOSTICS, cause) || /^limit:[A-Za-z]+$/.test(cause) ? cause : 'internal-error';
  return deliver(route, `${known}: ${DIAGNOSTICS[known.startsWith('limit:') ? 'limit' : known]}\n`);
}
