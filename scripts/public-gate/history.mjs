import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { compareText, createScanDeadline, EXIT, gateRevision, loadConfig, REGISTERED_RULE_IDS, requireValue, TREE_RULES, unscannableEntries } from './gate.mjs';
import { createSecretInput } from './history-secrets.mjs';
import { FULL_OBJECT_ID, GateInputError, readCommitObjects, readHistory, requireExpectedRoot } from './objects.mjs';
import { checked, counted, publish, SHA256_HEX, STATUSES, UNSCANNABLE_CAUSES, writeDiagnostic } from './redact.mjs';
import { ACCOUNT_RULE_ID, HOST_RULE_ID, IP_RULE_ID, refusedMetadataEmails, refusedMetadataHosts, refusedMetadataIps } from './rules-address.mjs';
import { createPrivateMatcher, PRIVATE_RULE_ID, readPrivateList, scanPrivate } from './rules-private.mjs';
import { requireNoStaleLockfileDisposition } from './rules-text.mjs';
import { SEMVER, scanSecrets, secretScanIdentity } from './secret-scan.mjs';

/** Id of the identity rule in reports: every author, committer, tagger and trailer identity is an exact `publicIdentities` entry or the allowed identity, in UTC. */
export const IDENTITY_RULE_ID = 'R-IDENTITY';

const FLAGS = ['--repo', '--refs', '--private-list', '--expected-root', '--allowed-identity', '--pr-text', '--out', '--gitleaks', '--gitleaks-sha256'];
/**
 * A trailer that names a person: `Co-authored-by: Name <email>` or `Signed-off-by: Name <email>`, with blanks before the token and
 * before the colon as git and the code host read it; group 1 is the identity as written. It is matched against one piece of a line.
 */
const IDENTITY_TRAILER = /^[ \t]*(?:co-authored-by|signed-off-by)[ \t]*:[ \t]*(.*)$/i;
/** What ends a line for a reader other than git's `\n`: CR (so CRLF leaves no CR in a trailer), VT, FF, NEL, U+2028 and U+2029. */
const OTHER_LINE_BREAKS = /[\r\v\f\u0085\u2028\u2029]/;
const PERSON_LINE = /^(author|committer|tagger) (.*) <([^>]*)> \d+ ([+-]\d{4})$/;
/** The header kinds that name a person in a commit object and in a tag object. */
const COMMIT_PEOPLE = ['author', 'committer'];
const TAG_PEOPLE = ['tagger'];
const RULE_IDS = [IDENTITY_RULE_ID, ...REGISTERED_RULE_IDS];
/** What reads each commit's tree: every rule of complete scope, the private-list scan included. */
const TREE_SCANS = [...TREE_RULES.map((rule) => rule.run), scanPrivate];
const KINDS = ['path', 'content', 'author', 'committer', 'tagger', 'header', 'message', 'timezone', 'pr-text'];
/** The part of a commit or tag object a finding is in; its location is `<object>:<field>`. */
const COMMIT_FIELDS = ['author', 'committer', 'tagger', 'header', 'message'];

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

/** The 1-based numbers of the first `maxLines` lines of `message` for which `isRefused(line)` is true. */
function linesWhere(message, isRefused, maxLines) {
  const lines = [];
  message.split('\n').forEach((text, index) => {
    if (lines.length < maxLines && isRefused(text)) lines.push(index + 1);
  });
  return lines;
}

/** True when `line`, or any piece of it between other line breaks, is a trailer naming a person whose identity, as written, is not in `identities`. */
function isUnapprovedTrailer(line, identities) {
  return line.split(OTHER_LINE_BREAKS).some((piece) => {
    const trailer = IDENTITY_TRAILER.exec(piece);
    return trailer !== null && !identities.has(trailer[1]);
  });
}

/**
 * Findings in one raw commit or tag object: list entries and what the address rules (email, host, IP) refuse in its message and headers, and
 * (with `identities`, the set of exact `Name <email>` strings that pass) other identities, trailer identities or time zones. `people` are
 * the header kinds that name a person: with identities each must be there, and a line of any other kind is an ordinary header.
 */
function metadataFindings({ sha, raw }, { matcher, identities, config, limits }, people) {
  const split = raw.indexOf('\n\n');
  const headers = (split < 0 ? raw : raw.subarray(0, split)).toString('utf8').split('\n');
  const findings = [];
  const add = (rule, kind, field, line) => findings.push({ rule, kind, commit: sha, field, ...(line ? { line } : {}) });
  const seen = new Set();
  for (const header of headers) {
    const matched = PERSON_LINE.exec(header);
    const person = matched && people.includes(matched[1]) ? matched : null;
    const kind = person ? person[1] : 'header';
    if (matcher.hasEntry(header)) add(PRIVATE_RULE_ID, kind, kind);
    for (const { rule, refusedIn } of METADATA_ADDRESS_RULES) if (refusedIn(header, config).length > 0) add(rule, kind, kind);
    if (!person || !identities) continue;
    seen.add(kind);
    if (!identities.has(`${person[2]} <${person[3]}>`)) add(IDENTITY_RULE_ID, kind, kind);
    if (person[4] !== '+0000') add(IDENTITY_RULE_ID, 'timezone', kind);
  }
  if (identities) for (const kind of people) if (!seen.has(kind)) add(IDENTITY_RULE_ID, kind, kind);
  const message = split < 0 ? '' : raw.subarray(split + 2).toString('utf8');
  for (const line of matcher.entryLines(message, limits.maxReportEntries + 1)) add(PRIVATE_RULE_ID, 'message', 'message', line);
  for (const { rule, refusedIn } of METADATA_ADDRESS_RULES) {
    for (const line of linesWhere(message, (text) => refusedIn(text, config).length > 0, limits.maxReportEntries + 1)) add(rule, 'message', 'message', line);
  }
  if (identities) {
    for (const line of linesWhere(message, (text) => isUnapprovedTrailer(text, identities), limits.maxReportEntries + 1)) add(IDENTITY_RULE_ID, 'message', 'message', line);
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
      gateRevision: checked(scanner.gateRevision, SHA256_HEX), configSha256: checked(scanner.configSha256, SHA256_HEX), scannerVersion: checked(scanner.scannerVersion, SEMVER),
      scannerPolicySha256: checked(scanner.scannerPolicySha256, SHA256_HEX), secretExceptionsSha256: checked(scanner.secretExceptionsSha256, SHA256_HEX),
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
    scanner: { binary: requireValue(flags, '--gitleaks'), sha256: requireValue(flags, '--gitleaks-sha256', SHA256_HEX) },
    out: '--out' in flags ? requireValue(flags, '--out') : null,
  };
}

async function runHistory(argv, signal) {
  const options = readOptions(argv);
  const config = loadConfig();
  const { limits } = config;
  const listEntries = readPrivateList(options.privateList, { repo: options.repo, limits });
  const prText = options.prText && readPrText(options.prText, limits);
  const { heads, commits, tags } = await readHistory({ repo: options.repo, refs: options.refs, limits, signal });
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
  const identities = options.identity && new Set([...config.publicIdentities, options.identity]);
  const metadataContext = { matcher, identities, config, limits };
  const lockfilePaths = new Set(config.lockfileDispositions.map((row) => row.path));
  const heldLockfiles = new Map();
  const secrets = createSecretInput(limits);
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
    secrets.addTree(commit.sha, entries);
    for (const { path, oid } of entries) if (lockfilePaths.has(path)) heldLockfiles.set(`${oid}\0${path}`, { path, oid });
    secrets.addObject(commit, COMMIT_PEOPLE);
    findings.push(...bounded(() => [
      ...TREE_SCANS.flatMap((scan) => scan({ entries, matcher, config, limits }).map((finding) => ({ ...finding, commit: commit.sha }))),
      ...metadataFindings(commit, metadataContext, COMMIT_PEOPLE),
    ]));
    requireWithinLimit();
  }
  for (const tag of tags) {
    secrets.addObject(tag, TAG_PEOPLE);
    findings.push(...bounded(() => metadataFindings(tag, metadataContext, TAG_PEOPLE)));
    requireWithinLimit();
  }
  for (const { item, string, value } of prText?.strings ?? []) {
    for (const line of bounded(() => matcher.entryLines(value, limits.maxReportEntries + 1))) findings.push({ rule: PRIVATE_RULE_ID, kind: 'pr-text', item, string, line });
    requireWithinLimit();
  }
  requireNoStaleLockfileDisposition([...heldLockfiles.values()], config.lockfileDispositions);
  findings.push(...(await scanSecrets({ entries: secrets.scanEntries(), config, scanner: options.scanner, signal })).map(secrets.locate));
  requireWithinLimit();
  findings.sort(compareFindings);
  const found = (rule) => findings.some((finding) => finding.rule === rule);
  const scannedStatus = (id) => (found(id) ? 'findings' : unscannable.length > 0 ? 'unscannable' : 'passed');
  const rules = [
    { id: IDENTITY_RULE_ID, status: !options.identity ? 'not-run' : found(IDENTITY_RULE_ID) ? 'findings' : 'passed' },
    ...REGISTERED_RULE_IDS.map((id) => ({ id, status: scannedStatus(id) })),
  ].sort((first, second) => compareText(first.id, second.id));
  const scanner = { gateRevision: gateRevision(), configSha256: config.sha256, ...secretScanIdentity(config), expectedRoot: options.expectedRoot, ...(prText ? { prTextSha256: prText.sha256 } : {}) };
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
