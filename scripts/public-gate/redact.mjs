import { writeFileSync } from 'node:fs';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';
import { PRIVATE_RULE_ID } from './rules-private.mjs';

/** Every output route. All output leaves through this module on one of these; later checkers register theirs. */
export const DIAGNOSTIC_ROUTES = Object.freeze({ 'gate.stdout': 'stdout', 'gate.report-file': 'file', 'gate.stderr': 'stderr' });

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SCOPES = ['generic', 'complete'];
const RULE_IDS = [PRIVATE_RULE_ID];
const STATUSES = ['passed', 'findings', 'not-run', 'unscannable'];
const KINDS = ['path', 'content'];
const CAUSES = ['invalid-utf8-path', 'submodule', 'limit:maxBlobBytes', 'nul-or-invalid-utf8-text', 'binary-without-disposition'];

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
  'output-exists': 'the --out file already exists', 'output-unwritable': 'the --out file cannot be written',
  'evidence-exists': 'the --private-evidence file already exists', 'evidence-unwritable': 'the --private-evidence file cannot be written',
  'internal-error': 'the gate failed unexpectedly', limit: 'a configured limit was reached',
};

function checked(value, allowed) {
  if (Array.isArray(allowed) ? allowed.includes(value) : typeof value === 'string' && allowed.test(value)) return value;
  throw new Error('a report value is outside the report schema');
}

function counted(value) {
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
 * SHA-256 digests and positive integers, each checked against its schema.
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
  const { gateRevision, configSha256, privateListSha256, expectedRoot } = scanner;
  const report = {
    scope: checked(scope, SCOPES),
    target: { commit, tree: checked(target.tree, FULL_OBJECT_ID) },
    scanner: {
      gateRevision: checked(gateRevision, SHA256_HEX), configSha256: checked(configSha256, SHA256_HEX),
      ...(privateListSha256 === undefined ? {} : { privateListSha256: checked(privateListSha256, SHA256_HEX) }),
      ...(expectedRoot === undefined ? {} : { expectedRoot: checked(expectedRoot, FULL_OBJECT_ID) }),
    },
    rules: rules.map(({ id, status }) => ({ id: checked(id, RULE_IDS), status: checked(status, STATUSES) })),
    unscannable: unscannable.map(({ entry, cause }) => ({ location: locate(entry), cause: checked(cause, CAUSES) })),
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

/** Writes `<cause>: <fixed text>` to stderr; a cause without a fixed text is written as internal-error. */
export function writeDiagnostic(cause) {
  const known = Object.hasOwn(DIAGNOSTICS, cause) || /^limit:[A-Za-z]+$/.test(cause) ? cause : 'internal-error';
  return deliver('gate.stderr', `${known}: ${DIAGNOSTICS[known.startsWith('limit:') ? 'limit' : known]}\n`);
}
