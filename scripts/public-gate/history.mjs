import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { compareText, createScanDeadline, EXIT, gateRevision, loadConfig, REGISTERED_RULE_IDS, requireValue, TREE_RULES, unscannableEntries } from './gate.mjs';
import { FULL_OBJECT_ID, GateInputError, readCommitObjects, readHistory, requireExpectedRoot } from './objects.mjs';
import { checked, counted, publish, SHA256_HEX, STATUSES, UNSCANNABLE_CAUSES, writeDiagnostic } from './redact.mjs';
import { ACCOUNT_RULE_ID, HOST_RULE_ID, IP_RULE_ID, refusedMetadataEmails, refusedMetadataHosts, refusedMetadataIps } from './rules-address.mjs';
import { createPrivateMatcher, PRIVATE_RULE_ID, readPrivateList, scanPrivate } from './rules-private.mjs';

/** Id of the identity rule in reports: every author and committer is the allowed identity, in UTC. */
export const IDENTITY_RULE_ID = 'R-IDENTITY';

const FLAGS = ['--repo', '--refs', '--private-list', '--expected-root', '--allowed-identity', '--pr-text', '--out'];
const PERSON_LINE = /^(author|committer) (.*) <([^>]*)> \d+ ([+-]\d{4})$/;
const RULE_IDS = [IDENTITY_RULE_ID, ...REGISTERED_RULE_IDS];
/** What reads each commit's tree: every rule of complete scope, the private-list scan included. */
const TREE_SCANS = [...TREE_RULES.map((rule) => rule.run), scanPrivate];
const KINDS = ['path', 'content', 'author', 'committer', 'header', 'message', 'timezone', 'pr-text'];
/** The part of a commit object a commit finding is in; its location is `<commit>:<field>`. */
const COMMIT_FIELDS = ['author', 'committer', 'header', 'message'];

/** A string token or a bracket of JSON text: in valid JSON nothing else holds a quote or a bracket. */
const JSON_TOKEN = /"[^"\\]*(?:\\.[^"\\]*)*"|[[\]{}]/gs;

/**
 * Reads the pull-request file: a JSON array of objects. Returns the sha256 of the file and every string in it, keys
 * and values, in file order, as { item, string, value }: the 1-based number of its object in the array and of the string in that object.
 */
function readPrText(file, limits) {
  let bytes;
  try {
    if (statSync(file).size > limits.maxBlobBytes) throw new GateInputError('limit:maxBlobBytes', `--pr-text is over ${limits.maxBlobBytes} bytes`);
    bytes = readFileSync(file);
  } catch (error) {
    throw error instanceof GateInputError ? error : new GateInputError('pr-text-unreadable', `--pr-text cannot be read (${error.code ?? error.name})`);
  }
  const text = bytes.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GateInputError('pr-text-malformed', '--pr-text is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new GateInputError('pr-text-malformed', '--pr-text must be a JSON array of objects');
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), strings: stringsInFileOrder(text) };
}

/**
 * Lists every string token of a valid JSON array of objects, keys and values, repeated keys included, in file order, as
 * { item, string, value }. `JSON.parse` cannot be walked for this: it drops the earlier value of a repeated key and skips keys.
 */
function stringsInFileOrder(text) {
  const strings = [];
  let depth = 0;
  let item = 0;
  let string = 0;
  for (const [token] of text.matchAll(JSON_TOKEN)) {
    if (token === '[' || token === '{') {
      depth += 1;
      if (depth === 2) {
        item += 1;
        string = 0;
      }
    } else if (token === ']' || token === '}') depth -= 1;
    else strings.push({ item, string: (string += 1), value: JSON.parse(token) });
  }
  return strings;
}

/** The address rules that also read commit metadata, each with what it refuses in a piece of text: an email, an unlisted host, a public IP literal. */
const METADATA_ADDRESS_RULES = [
  { rule: ACCOUNT_RULE_ID, refusedIn: refusedMetadataEmails },
  { rule: HOST_RULE_ID, refusedIn: refusedMetadataHosts },
  { rule: IP_RULE_ID, refusedIn: refusedMetadataIps },
];

/** The 1-based numbers of the first `maxLines` lines of `message` that hold something `refusedIn(line, config)` returns. */
function refusedLines(message, refusedIn, config, maxLines) {
  const lines = [];
  message.split('\n').forEach((text, index) => {
    if (lines.length < maxLines && refusedIn(text, config).length > 0) lines.push(index + 1);
  });
  return lines;
}

/**
 * Findings in one raw commit object: list entries and what the address rules (email, host, IP) refuse in its message and headers, and
 * (with an allowed identity) other identities or time zones.
 */
function commitFindings({ sha, raw }, { matcher, identity, config, limits }) {
  const split = raw.indexOf('\n\n');
  const headers = (split < 0 ? raw : raw.subarray(0, split)).toString('utf8').split('\n');
  const findings = [];
  const add = (rule, kind, field, line) => findings.push({ rule, kind, commit: sha, field, ...(line ? { line } : {}) });
  const seen = new Set();
  for (const header of headers) {
    const person = PERSON_LINE.exec(header);
    const kind = person ? person[1] : 'header';
    if (matcher.hasEntry(header)) add(PRIVATE_RULE_ID, kind, kind);
    for (const { rule, refusedIn } of METADATA_ADDRESS_RULES) if (refusedIn(header, config).length > 0) add(rule, kind, kind);
    if (!person || !identity) continue;
    seen.add(kind);
    if (`${person[2]} <${person[3]}>` !== identity) add(IDENTITY_RULE_ID, kind, kind);
    if (person[4] !== '+0000') add(IDENTITY_RULE_ID, 'timezone', kind);
  }
  if (identity) for (const kind of ['author', 'committer']) if (!seen.has(kind)) add(IDENTITY_RULE_ID, kind, kind);
  const message = split < 0 ? '' : raw.subarray(split + 2).toString('utf8');
  for (const line of matcher.entryLines(message, limits.maxReportEntries + 1)) add(PRIVATE_RULE_ID, 'message', 'message', line);
  for (const { rule, refusedIn } of METADATA_ADDRESS_RULES) {
    for (const line of refusedLines(message, refusedIn, config, limits.maxReportEntries + 1)) add(rule, 'message', 'message', line);
  }
  return findings;
}

/** Orders findings by rule, kind and commit, then by position (or pull-request object), string and line as numbers. */
const compareFindings = (first, second) => compareText(first.rule, second.rule) || compareText(first.kind, second.kind)
  || compareText(first.commit ?? '', second.commit ?? '') || (first.entry?.position ?? first.item ?? 0) - (second.entry?.position ?? second.item ?? 0)
  || (first.string ?? 0) - (second.string ?? 0) || (first.line ?? 0) - (second.line ?? 0);

/** A finding's location: `<commit>:<position>` in a tree, `<commit>:<field>` in a commit object, `pr-<item>:<string>` in pull-request text. */
function locate({ commit, entry, field, item, string }) {
  if (entry) return `${commit}:${counted(entry.position)}`;
  if (field) return `${commit}:${checked(field, COMMIT_FIELDS)}`;
  return `pr-${counted(item)}:${counted(string)}`;
}

/**
 * Builds the history report field by field from enum values, object ids, SHA-256 digests and positive integers, each
 * checked against its schema, so its bytes never depend on the private list or on a path, key or text that was read.
 * Returns the report as text; throws Error when a value is outside the schema.
 */
function buildHistoryReport({ heads, commits, scanner, rules, unscannable, findings }) {
  const report = {
    scope: 'history',
    target: { heads: heads.map((head) => checked(head, FULL_OBJECT_ID)), commits: counted(commits) },
    scanner: {
      gateRevision: checked(scanner.gateRevision, SHA256_HEX), configSha256: checked(scanner.configSha256, SHA256_HEX),
      expectedRoot: checked(scanner.expectedRoot, FULL_OBJECT_ID),
      ...(scanner.prTextSha256 === undefined ? {} : { prTextSha256: checked(scanner.prTextSha256, SHA256_HEX) }),
    },
    rules: rules.map(({ id, status }) => ({ id: checked(id, RULE_IDS), status: checked(status, STATUSES) })),
    unscannable: unscannable.map(({ commit, entry, cause }) => ({
      commit: checked(commit, FULL_OBJECT_ID), location: locate({ commit, entry }), cause: checked(cause, UNSCANNABLE_CAUSES),
    })),
    findings: findings.map((finding) => ({
      rule: checked(finding.rule, RULE_IDS), kind: checked(finding.kind, KINDS),
      ...(finding.commit === undefined ? {} : { commit: checked(finding.commit, FULL_OBJECT_ID) }),
      location: locate(finding), ...(finding.line === undefined ? {} : { line: counted(finding.line) }),
    })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
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

async function runHistory(argv, signal) {
  const options = readOptions(argv);
  const config = loadConfig();
  const { limits } = config;
  const listEntries = readPrivateList(options.privateList, { repo: options.repo, limits });
  const prText = options.prText && readPrText(options.prText, limits);
  const { heads, commits } = await readHistory({ repo: options.repo, refs: options.refs, limits, signal });
  requireExpectedRoot(commits, options.expectedRoot);
  let checkpoint = () => {};
  const bounded = (scan) => {
    checkpoint = createScanDeadline({ deadlineMs: limits.scanDeadlineMs });
    try {
      return scan();
    } finally {
      checkpoint = () => {};
    }
  };
  const matcher = bounded(() => createPrivateMatcher(listEntries, () => checkpoint()));
  const findings = [];
  const unscannable = [];
  const requireWithinLimit = () => {
    if (findings.length > limits.maxReportEntries || unscannable.length > limits.maxReportEntries) {
      throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings or unscannable entries`);
    }
  };
  for (const commit of commits) {
    const { entries } = await readCommitObjects({ repo: options.repo, commit: commit.sha, limits, signal });
    unscannable.push(...unscannableEntries(entries, config).map((problem) => ({ commit: commit.sha, ...problem })));
    findings.push(...bounded(() => [
      ...TREE_SCANS.flatMap((scan) => scan({ entries, matcher, config, limits }).map((finding) => ({ ...finding, commit: commit.sha }))),
      ...commitFindings(commit, { matcher, identity: options.identity, config, limits }),
    ]));
    requireWithinLimit();
  }
  for (const { item, string, value } of prText?.strings ?? []) {
    for (const line of bounded(() => matcher.entryLines(value, limits.maxReportEntries + 1))) findings.push({ rule: PRIVATE_RULE_ID, kind: 'pr-text', item, string, line });
    requireWithinLimit();
  }
  findings.sort(compareFindings);
  const found = (rule) => findings.some((finding) => finding.rule === rule);
  const scannedStatus = (id) => (found(id) ? 'findings' : unscannable.length > 0 ? 'unscannable' : 'passed');
  const rules = [
    { id: IDENTITY_RULE_ID, status: !options.identity ? 'not-run' : found(IDENTITY_RULE_ID) ? 'findings' : 'passed' },
    ...REGISTERED_RULE_IDS.map((id) => ({ id, status: scannedStatus(id) })),
  ].sort((first, second) => compareText(first.id, second.id));
  const scanner = { gateRevision: gateRevision(), configSha256: config.sha256, expectedRoot: options.expectedRoot, ...(prText ? { prTextSha256: prText.sha256 } : {}) };
  const report = buildHistoryReport({ heads, commits: commits.length, scanner, rules, unscannable, findings });
  await publish({ report }, { out: options.out });
  if (unscannable.length > 0) return EXIT.unusable;
  return findings.length > 0 ? EXIT.findings : EXIT.pass;
}

/** Runs the history mode for `argv` and returns the exit code: 0 pass, 1 findings, 2 missing input, interrupt, limit or unscannable target. */
async function main(argv, signal) {
  try {
    return await runHistory(argv, signal);
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
