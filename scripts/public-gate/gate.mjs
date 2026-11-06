import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChoiceError, parseChoice, parseFlags } from '../lib/choice.mjs';
import { classifyBlob } from './classify.mjs';
import { FULL_OBJECT_ID, GateInputError, readCommitObjects, readHistory, requireExpectedRoot } from './objects.mjs';
import { buildOutputs, publish, SHA256_HEX, writeDiagnostic } from './redact.mjs';
import { ACCOUNT_RULE_ID, HOST_RULE_ID, hasValidAddressConfig, hasValidIpDispositions, IP_RULE_ID, scanAccounts, scanHosts, scanIps } from './rules-address.mjs';
import { createEvalScanner, EVAL_RULE_ID, hasValidEvalConfig } from './rules-eval.mjs';
import { ARCHIVE_RULE_ID, ENV_RULE_ID, HOSTING_RULE_ID, scanArchives, scanEnvTemplates, scanHostingFiles } from './rules-files.mjs';
import { createPrivateMatcher, PRIVATE_RULE_ID, readPrivateList, readWordingList, scanPrivate } from './rules-private.mjs';
import { createWordingMatcher, hasValidTextConfig, ISSUE_RULE_ID, REPORT_RULE_ID, requireNoStaleLockfileDisposition, scanIssues, scanReports, scanWording, WORDING_RULE_ID } from './rules-text.mjs';
import { hasValidSecretConfig, SECRET_RULE_ID, scanSecrets, secretScanIdentity } from './secret-scan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_SOURCES = ['scripts/lib/choice.mjs', 'scripts/lib/run-bounded.mjs', ...['check-report', 'classify', 'gate', 'history', 'history-secrets', 'objects', 'redact', 'rules-address', 'rules-eval', 'rules-eval-child', 'rules-files', 'rules-private', 'rules-text', 'secret-scan'].map((name) => `scripts/public-gate/${name}.mjs`)];
const LIMIT_NAMES = ['maxTreeObjects', 'maxBlobBytes', 'maxTotalBlobBytes', 'maxListingBytes', 'maxPrivateListBytes', 'maxPrivateEntries', 'maxWordingListBytes', 'maxWordingEntries', 'maxReportEntries', 'maxHistoryCommits', 'maxHistoryOccurrences', 'gitDeadlineMs', 'scanDeadlineMs', 'secretScanDeadlineMs', 'secretScanOutputBytes', 'maxScanReportBytes', 'maxEvalUnitBytes', 'maxEvalBatchBytes', 'evalDeadlineMs', 'maxEvalOutputBytes'];
const SCOPES = ['generic', 'complete'];
const FLAGS = ['--repo', '--commit', '--scope', '--private-list', '--wording-list', '--private-evidence', '--expected-root', '--out', '--gitleaks', '--gitleaks-sha256'];
const COMPLETE_ONLY_FLAGS = ['--private-list', '--wording-list', '--private-evidence', '--expected-root'];
export const EXIT = { pass: 0, findings: 1, unusable: 2 };

/** The rules this gate runs; a `completeOnly` rule needs the private list (R-WORDING also the wording list) and reports `not-run` in generic scope. */
const RULES = [
  { id: ACCOUNT_RULE_ID, run: scanAccounts },
  { id: HOST_RULE_ID, run: scanHosts },
  { id: IP_RULE_ID, run: scanIps },
  { id: ENV_RULE_ID, run: scanEnvTemplates },
  { id: HOSTING_RULE_ID, run: scanHostingFiles },
  { id: ARCHIVE_RULE_ID, run: scanArchives },
  { id: REPORT_RULE_ID, run: scanReports },
  { id: ISSUE_RULE_ID, run: scanIssues },
  { id: PRIVATE_RULE_ID, completeOnly: true, run: scanPrivate },
  { id: WORDING_RULE_ID, completeOnly: true, run: scanWording },
];

/** The rules that read a tree alone, without the private or wording list; history mode runs them on every commit's tree. Each `run({ entries, config, limits })` returns findings. */
export const TREE_RULES = Object.freeze(RULES.filter((rule) => !rule.completeOnly));

/** The eval rule parses in a child process and the secret scan runs the scanner as a subprocess, so both are awaited apart from the synchronous tree rules. */
const EVAL_RULE = { id: EVAL_RULE_ID };
const SECRET_RULE = { id: SECRET_RULE_ID };
const ALL_RULES = [...RULES, EVAL_RULE, SECRET_RULE];

/** The ids of the registered rules; a report only counts as complete when it lists exactly these. */
export const REGISTERED_RULE_IDS = Object.freeze(ALL_RULES.map(({ id }) => id));

/** SHA-256 over the gate's own source files, named by path: the identity of this gate's code. */
export function gateRevision() {
  const hash = createHash('sha256');
  for (const file of [...GATE_SOURCES].sort()) hash.update(`${file}\0`).update(readFileSync(path.join(REPO_ROOT, file))).update('\0');
  return hash.digest('hex');
}

export function loadConfig() {
  const bytes = readFileSync(path.join(REPO_ROOT, 'public-gate.config.json'));
  const config = JSON.parse(bytes);
  const valid = LIMIT_NAMES.every((name) => Number.isSafeInteger(config.limits?.[name]) && config.limits[name] > 0)
    && Array.isArray(config.textExtensions) && Array.isArray(config.binaryDispositions)
    && config.binaryDispositions.every((entry) => entry.path && /^[0-9a-f]{64}$/.test(entry.sha256) && entry.reason)
    && hasValidAddressConfig(config) && hasValidIpDispositions(config) && hasValidSecretConfig(config) && hasValidTextConfig(config) && hasValidEvalConfig(config);
  if (!valid) throw new GateInputError('invalid-config', 'public-gate.config.json is malformed');
  return { ...config, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function requireValue(flags, name, pattern = /./) {
  if (flags[name] === undefined || !pattern.test(flags[name])) throw new ChoiceError('bad-arguments', `${name} is required${pattern === FULL_OBJECT_ID ? ' as a full object id' : ''}`);
  return flags[name];
}

/** The file `file` names, with symlinks resolved as far as it exists; two spellings of one file give the same string. */
function canonicalDestination(file) {
  const resolved = path.resolve(file);
  for (const [existing, rest] of [[resolved, ''], [path.dirname(resolved), path.basename(resolved)]]) {
    try {
      return path.join(realpathSync(existing), rest);
    } catch { /* not there yet: try the folder */ }
  }
  return resolved;
}

function readOptions(argv) {
  const flags = parseFlags(argv, FLAGS);
  const scope = parseChoice('--scope', flags['--scope'], SCOPES);
  const complete = scope === 'complete';
  if (!complete && COMPLETE_ONLY_FLAGS.some((name) => flags[name] !== undefined)) throw new ChoiceError('bad-arguments', 'private-list, wording-list, private-evidence and expected-root need --scope complete');
  const options = {
    scope, repo: requireValue(flags, '--repo'), commit: requireValue(flags, '--commit', FULL_OBJECT_ID),
    out: '--out' in flags ? requireValue(flags, '--out') : null,
    privateList: complete ? requireValue(flags, '--private-list') : null,
    wordingList: complete ? requireValue(flags, '--wording-list') : null,
    privateEvidence: '--private-evidence' in flags ? requireValue(flags, '--private-evidence') : null,
    expectedRoot: complete ? requireValue(flags, '--expected-root', FULL_OBJECT_ID) : null,
    scanner: { binary: requireValue(flags, '--gitleaks'), sha256: requireValue(flags, '--gitleaks-sha256', SHA256_HEX) },
  };
  if (options.out && options.privateEvidence && canonicalDestination(options.out) === canonicalDestination(options.privateEvidence)) {
    throw new ChoiceError('bad-arguments', '--out and --private-evidence must be different files');
  }
  return options;
}

export function unscannableEntries(entries, config) {
  return entries.flatMap((entry) => {
    const problem = entry.problem ?? (entry.bytes ? classifyBlob(entry.path, entry.bytes, config).problem : undefined);
    return problem ? [{ entry, cause: problem }] : [];
  });
}

function ruleStatus(rule, { scope, findings, unscannable }) {
  if (rule.completeOnly && scope === 'generic') return 'not-run';
  if (findings.length > 0) return 'findings';
  return unscannable.length > 0 ? 'unscannable' : 'passed';
}

/**
 * Returns a function that throws GateInputError(limit:scanDeadlineMs) once `deadlineMs` have passed on `clock` since this
 * call. The scan never returns to the event loop, so this clock is the only thing that can stop it; an interrupt cannot.
 */
export function createScanDeadline({ deadlineMs, clock = () => performance.now() }) {
  const deadline = clock() + deadlineMs;
  return () => {
    if (clock() > deadline) throw new GateInputError('limit:scanDeadlineMs', `the scan took longer than ${deadlineMs} ms`);
  };
}

/** Orders two strings by code unit; equal strings compare 0. */
export const compareText = (first, second) => (first === second ? 0 : first < second ? -1 : 1);

/** Orders findings by rule, kind, position and line, the numbers compared as numbers; equal findings compare 0. */
const compareFindings = (first, second) => compareText(first.rule, second.rule) || compareText(first.kind, second.kind)
  || first.entry.position - second.entry.position || (first.line ?? 0) - (second.line ?? 0);

async function runGate(argv, signal) {
  const options = readOptions(argv);
  const config = loadConfig();
  const listEntries = options.privateList && readPrivateList(options.privateList, { repo: options.repo, limits: config.limits });
  const wordingList = options.wordingList && readWordingList(options.wordingList, { repo: options.repo, limits: config.limits });
  const { entries, ...target } = await readCommitObjects({ repo: options.repo, commit: options.commit, limits: config.limits, signal });
  const { commits } = await readHistory({ repo: options.repo, refs: [options.commit], limits: config.limits, signal });
  requireExpectedRoot(commits, options.expectedRoot);
  const matcher = listEntries && createPrivateMatcher(listEntries, createScanDeadline({ deadlineMs: config.limits.scanDeadlineMs }));
  const wordingMatcher = wordingList && createWordingMatcher(wordingList.entries, createScanDeadline({ deadlineMs: config.limits.scanDeadlineMs }));
  const evalScanner = createEvalScanner({ config, limits: config.limits, signal });
  const evalScan = await evalScanner.scan(entries);
  evalScanner.requireNoStaleException();
  const unscannable = [...unscannableEntries(entries, config), ...evalScan.unscannable];
  if (unscannable.length > config.limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${config.limits.maxReportEntries} unscannable entries`);
  const treeFindings = RULES.filter((rule) => matcher || !rule.completeOnly).flatMap((rule) => rule.run({ entries, matcher, wordingMatcher, config, limits: config.limits }));
  requireNoStaleLockfileDisposition(entries, config.lockfileDispositions);
  const findings = [...treeFindings, ...evalScan.findings, ...await scanSecrets({ entries, config, scanner: options.scanner, signal })].sort(compareFindings);
  const scanner = { gateRevision: gateRevision(), configSha256: config.sha256, ...secretScanIdentity(config, options.scanner), ...(options.expectedRoot ? { expectedRoot: options.expectedRoot } : {}), ...(wordingList ? { wordingListSha256: wordingList.sha256 } : {}) };
  const rules = ALL_RULES.map((rule) => ({ id: rule.id, status: ruleStatus(rule, { scope: options.scope, findings, unscannable }) }))
    .sort((first, second) => compareText(first.id, second.id));
  const outputs = buildOutputs({ scope: options.scope, target, scanner, rules, unscannable, findings });
  await publish(outputs, { out: options.out, evidenceFile: options.privateEvidence });
  if (unscannable.length > 0) return EXIT.unusable;
  return findings.length > 0 ? EXIT.findings : EXIT.pass;
}

/** Runs the gate for `argv` and returns the exit code: 0 pass, 1 findings, 2 missing input, interrupt, limit or unscannable target. */
async function main(argv, signal) {
  try {
    return await runGate(argv, signal);
  } catch (error) {
    await writeDiagnostic(error instanceof ChoiceError || error instanceof GateInputError ? error.cause : 'internal-error');
    return EXIT.unusable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const interrupt = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => interrupt.abort(new GateInputError('interrupted', `interrupted by ${name}`)));
  process.exitCode = await main(process.argv.slice(2), interrupt.signal);
}
