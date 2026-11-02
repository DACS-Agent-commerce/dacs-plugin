import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { byKey, createScanDeadline, EXIT, gateRevision, loadConfig, requireValue, unscannableEntries } from './gate.mjs';
import { FULL_OBJECT_ID, GateInputError, readCommitObjects, readHistory, requireExpectedRoot } from './objects.mjs';
import { createEmitter } from './redact.mjs';
import { createPrivateMatcher, PRIVATE_RULE_ID, readPrivateList, scanPrivate } from './rules-private.mjs';

/** Id of the identity rule in reports: every author and committer is the allowed identity, in UTC. */
export const IDENTITY_RULE_ID = 'R-IDENTITY';

const FLAGS = ['--repo', '--refs', '--private-list', '--expected-root', '--allowed-identity', '--pr-text', '--out'];
const PERSON_LINE = /^(author|committer) (.*) <([^>]*)> \d+ ([+-]\d{4})$/;

/** Reads the pull-request file: a JSON array of objects. Returns the sha256 of the file and every string in it with its key path. */
function readPrText(file, limits) {
  let bytes;
  try {
    if (statSync(file).size > limits.maxBlobBytes) throw new GateInputError('limit:maxBlobBytes', `--pr-text is over ${limits.maxBlobBytes} bytes`);
    bytes = readFileSync(file);
  } catch (error) {
    throw error instanceof GateInputError ? error : new GateInputError('pr-text-unreadable', `--pr-text cannot be read (${error.code ?? error.name})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new GateInputError('pr-text-malformed', '--pr-text is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new GateInputError('pr-text-malformed', '--pr-text must be a JSON array of objects');
  }
  const strings = [];
  const walk = (value, where) => {
    if (typeof value === 'string') strings.push({ where, value });
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  parsed.forEach((item, index) => walk(item, `pr-${index}`));
  return { sha256: createHash('sha256').update(bytes).digest('hex'), strings };
}

/** Findings in one raw commit object: list entries in its message and headers, and (with an allowed identity) other identities or time zones. */
function commitFindings({ sha, raw }, { matcher, identity, limits }) {
  const split = raw.indexOf('\n\n');
  const headers = (split < 0 ? raw : raw.subarray(0, split)).toString('utf8').split('\n');
  const findings = [];
  const add = (rule, kind, location, line) => findings.push({ rule, kind, commit: sha, location, ...(line ? { line } : {}) });
  const seen = new Set();
  for (const header of headers) {
    const person = PERSON_LINE.exec(header);
    const kind = person ? person[1] : 'header';
    if (matcher.firstEntryIn(header) > 0) add(PRIVATE_RULE_ID, kind, `${sha}:${kind}`);
    if (!person || !identity) continue;
    seen.add(kind);
    if (`${person[2]} <${person[3]}>` !== identity) add(IDENTITY_RULE_ID, kind, `${sha}:${kind}`);
    if (person[4] !== '+0000') add(IDENTITY_RULE_ID, 'timezone', `${sha}:${kind}`);
  }
  if (identity) for (const kind of ['author', 'committer']) if (!seen.has(kind)) add(IDENTITY_RULE_ID, kind, `${sha}:${kind}`);
  const message = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 2);
  for (const line of matcher.linesIn(message, limits.maxReportEntries)) add(PRIVATE_RULE_ID, 'message', `${sha}:message`, line);
  return findings;
}

function readOptions(argv) {
  const flags = parseFlags(argv, FLAGS);
  const refs = requireValue(flags, '--refs').split(',');
  return {
    repo: requireValue(flags, '--repo'), refs, privateList: requireValue(flags, '--private-list'),
    expectedRoot: requireValue(flags, '--expected-root', FULL_OBJECT_ID),
    identity: '--allowed-identity' in flags ? requireValue(flags, '--allowed-identity', /^[^<>]+ <[^<>]+>$/) : null,
    prText: '--pr-text' in flags ? requireValue(flags, '--pr-text') : null,
    out: '--out' in flags ? requireValue(flags, '--out') : null,
  };
}

async function runHistory(argv, signal, session) {
  const options = readOptions(argv);
  const config = loadConfig();
  const list = readPrivateList(options.privateList, config.limits);
  let checkpoint = () => {};
  const matcher = createPrivateMatcher(list.entries, () => checkpoint());
  session.matcher = matcher;
  const prText = options.prText && readPrText(options.prText, config.limits);
  const { heads, commits } = await readHistory({ repo: options.repo, refs: options.refs, limits: config.limits, signal });
  requireExpectedRoot(commits, options.expectedRoot);
  const bounded = (scan) => {
    checkpoint = createScanDeadline({ deadlineMs: config.limits.scanDeadlineMs });
    try {
      return scan();
    } finally {
      checkpoint = () => {};
    }
  };
  const findings = [];
  const unscannable = [];
  for (const commit of commits) {
    const emitter = createEmitter({ commit: commit.sha, matcher });
    const { entries } = await readCommitObjects({ repo: options.repo, commit: commit.sha, limits: config.limits, signal });
    unscannable.push(...unscannableEntries(entries, config, emitter).map((entry) => ({ commit: commit.sha, ...entry })));
    findings.push(...bounded(() => [
      ...scanPrivate({ entries, matcher, emitter, limits: config.limits }).map((finding) => ({ ...finding, commit: commit.sha })),
      ...commitFindings(commit, { matcher, identity: options.identity, limits: config.limits }),
    ]));
    if (findings.length > config.limits.maxReportEntries || unscannable.length > config.limits.maxReportEntries) {
      throw new GateInputError('limit:maxReportEntries', `more than ${config.limits.maxReportEntries} findings or unscannable entries`);
    }
  }
  for (const { where, value } of prText?.strings ?? []) {
    for (const line of bounded(() => matcher.linesIn(Buffer.from(value), config.limits.maxReportEntries))) findings.push({ rule: PRIVATE_RULE_ID, kind: 'pr-text', location: where, line });
  }
  findings.sort(byKey((finding) => [finding.rule, finding.kind, finding.commit ?? '', finding.location, String(finding.line ?? '').padStart(12, '0')].join('\0')));
  const found = (rule) => findings.some((finding) => finding.rule === rule);
  const rules = [
    { id: IDENTITY_RULE_ID, status: !options.identity ? 'not-run' : found(IDENTITY_RULE_ID) ? 'findings' : 'passed' },
    { id: PRIVATE_RULE_ID, status: found(PRIVATE_RULE_ID) ? 'findings' : unscannable.length > 0 ? 'unscannable' : 'passed' },
  ];
  const scanner = { gateRevision: gateRevision(), configSha256: config.sha256, privateListSha256: list.sha256, expectedRoot: options.expectedRoot, ...(prText ? { prTextSha256: prText.sha256 } : {}) };
  const reporter = createEmitter({ commit: null, matcher });
  reporter.report(options.out ? 'gate.report-file' : 'gate.stdout', { scope: 'history', target: { heads, commits: commits.length }, scanner, rules, unscannable, findings }, options.out);
  if (unscannable.length > 0) return EXIT.unusable;
  return findings.length > 0 ? EXIT.findings : EXIT.pass;
}

/** Runs the history mode for `argv` and returns the exit code: 0 pass, 1 findings, 2 missing input, interrupt, limit or unscannable target. */
async function main(argv, signal) {
  const session = { matcher: null };
  try {
    return await runHistory(argv, signal, session);
  } catch (error) {
    const known = error instanceof ChoiceError || error instanceof GateInputError;
    createEmitter({ commit: null, matcher: session.matcher }).text('gate.stderr', `${known ? error.cause : 'internal-error'}: ${known ? error.message : error.name}`);
    return EXIT.unusable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const interrupt = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => interrupt.abort(new GateInputError('interrupted', `interrupted by ${name}`)));
  process.exitCode = await main(process.argv.slice(2), interrupt.signal);
}
