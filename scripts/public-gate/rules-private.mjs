import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { decodeUtf8Strict, GateInputError, gitEnvironment } from './objects.mjs';

/** Id of the private-list rule in reports. */
export const PRIVATE_RULE_ID = 'R-PRIVATE';

/** Matcher steps (code points read or added, failure links followed) between two calls of the deadline checkpoint. */
const CHECKPOINT_STEPS = 65_536;
/** Every code point with a case mapping lies below this one, so higher code points fold to themselves. */
const CASED_CODE_POINTS_END = 0x20000;
const CR = 0x0d;
const LF = 0x0a;

const ROOT_QUERIES = [
  { args: ['rev-parse', '--git-common-dir'], paths: (out) => [out.replace(/\n$/, '')] },
  { args: ['rev-parse', '--show-toplevel'], paths: (out) => [out.replace(/\n$/, '')] },
  { args: ['worktree', 'list', '--porcelain', '-z'], paths: (out) => out.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice('worktree '.length)) },
];
const ROOT_QUERY_MAX_BYTES = 1 << 20;

/**
 * Every folder that belongs to the repository git finds from `repo`: `repo` itself, the git dir, the common git dir, the
 * worktree and every linked worktree. Git is run as the object read runs it (no GIT_ variable), so both name one repository.
 * A query git refuses (not a repository, no work tree) adds nothing: git then refuses the run with its own cause.
 */
function repositoryRoots(repo, limits) {
  const roots = new Set([repo]);
  for (const { args, paths } of ROOT_QUERIES) {
    const run = spawnSync('git', ['-C', repo, ...args], { env: gitEnvironment(), encoding: 'utf8', timeout: limits.gitDeadlineMs, maxBuffer: ROOT_QUERY_MAX_BYTES });
    if (run.error?.code === 'ETIMEDOUT') throw new GateInputError('timeout', 'git did not finish before its deadline');
    if (run.error?.code === 'ENOBUFS') throw new GateInputError('output-limit', `git ${args[0]} produced more than ${ROOT_QUERY_MAX_BYTES} bytes`);
    if (!run.error && run.status === 0) for (const found of paths(run.stdout)) roots.add(path.resolve(repo, found));
  }
  return [...roots].filter((root) => existsSync(root)).map((root) => realpathSync.native(root));
}

/**
 * Reads at most `maxBytes` of a regular file outside the repository `repo` names; a FIFO or device is refused without
 * waiting on it. A `repo` that does not exist is not compared: git then refuses the run with its own cause.
 */
function readListBytes(file, repo, limits) {
  const maxBytes = limits.maxPrivateListBytes;
  let descriptor;
  try {
    const listPath = realpathSync.native(file);
    const inside = (root) => { const relative = path.relative(root, listPath); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    if (repositoryRoots(repo, limits).some(inside)) throw new GateInputError('private-list-in-repo', 'the private list is inside the repository');
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) throw new GateInputError('private-list-unreadable', '--private-list is not a regular file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(descriptor, bytes, length, bytes.length - length, null);
    if (length > maxBytes) throw new GateInputError('limit:maxPrivateListBytes', `the private list is over ${maxBytes} bytes`);
    return bytes.subarray(0, length);
  } catch (error) {
    throw error instanceof GateInputError ? error : new GateInputError('private-list-unreadable', `--private-list cannot be read (${error.code ?? error.name})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Reads the private list: one exact entry per line (CRLF, LF or CR ends a line), a leading byte-order mark, blank lines and
 * `#` comments ignored. Returns the entries. Throws GateInputError when the file is inside the repository `repo` names (its
 * worktrees and git dirs included, not only the `repo` folder), not a regular file,
 * unreadable, over a limit, not UTF-8, empty, or has an entry with leading or trailing whitespace.
 */
export function readPrivateList(file, { repo, limits }) {
  const text = decodeUtf8Strict(readListBytes(file, repo, limits));
  if (text === null) throw new GateInputError('private-list-malformed', 'the private list is not valid UTF-8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const padded = lines.findIndex((line) => line !== line.trim() && !line.startsWith('#'));
  if (padded >= 0) throw new GateInputError('private-list-malformed', `line ${padded + 1} of the private list has leading or trailing whitespace`);
  const entries = lines.filter((line) => line !== '' && !line.startsWith('#'));
  if (entries.length === 0) throw new GateInputError('private-list-empty', 'the private list holds no entry');
  if (entries.length > limits.maxPrivateEntries) throw new GateInputError('limit:maxPrivateEntries', `the private list holds more than ${limits.maxPrivateEntries} entries`);
  return entries;
}

const isOneCodePoint = (text) => text.length === (text.codePointAt(0) > 0xffff ? 2 : 1);
const equalIgnoringCase = (first, second) => new RegExp(`^\\u{${first.toString(16)}}$`, 'iu').test(String.fromCodePoint(second));

/**
 * Maps each code point that `/iu` treats as equal to a lower one to the lowest of its group. Candidates are a code
 * point's one-code-point lower and upper case, and code points sharing a longer upper case (U+1FD3 and U+0390); a
 * candidate joins only after a one-code-point `/iu` comparison accepts it.
 */
function buildFoldTable() {
  const lowerInGroup = new Map();
  const lowest = (code) => (lowerInGroup.has(code) ? lowest(lowerInGroup.get(code)) : code);
  const join = (first, second) => {
    const [low, high] = [lowest(first), lowest(second)].sort((a, b) => a - b);
    if (low !== high && equalIgnoringCase(low, high)) lowerInGroup.set(high, low);
  };
  const byLongUpper = new Map();
  for (let code = 0; code < CASED_CODE_POINTS_END; code += 1) {
    const [char, upper] = [String.fromCodePoint(code), String.fromCodePoint(code).toUpperCase()];
    for (const mapped of [char.toLowerCase(), upper]) if (isOneCodePoint(mapped)) join(code, mapped.codePointAt(0));
    if (!isOneCodePoint(upper)) byLongUpper.set(upper, [...(byLongUpper.get(upper) ?? []), code]);
  }
  for (const [first, ...others] of byLongUpper.values()) for (const code of others) join(first, code);
  return new Map([...lowerInGroup.keys()].map((code) => [code, lowest(code)]));
}

let foldTable = null;

/**
 * Builds the matcher for the list entries: one Aho-Corasick automaton over case-folded code points, so each text is read
 * once whatever the number of entries. A code point matches another exactly when `/iu` says so (simple case folding; no
 * normalization, no one-to-many folding such as `ß` to `ss`). The automaton has at most one state per code point of the list.
 * - `hasEntry(text)`: whether an entry occurs in `text`.
 * - `entryLines(text, maxLines)`: the first `maxLines` distinct 1-based lines where an entry occurs; CRLF, a lone CR and
 *   a lone LF each end a line, and an entry never holds one, so it starts on the line where it ends.
 * `checkpoint()` runs every CHECKPOINT_STEPS steps while building and matching; what it throws (the deadline) propagates.
 */
export function createPrivateMatcher(entries, checkpoint) {
  foldTable ??= buildFoldTable();
  const fold = (code) => foldTable.get(code) ?? code;
  let steps = 0;
  const step = () => {
    steps += 1;
    if (steps % CHECKPOINT_STEPS === 0) checkpoint();
  };
  const next = [new Map()];
  const terminals = entries.map((entry) => [...entry].reduce((state, char) => {
    step();
    const code = fold(char.codePointAt(0));
    if (!next[state].has(code)) next[state].set(code, next.push(new Map()) - 1);
    return next[state].get(code);
  }, 0));
  const failure = new Int32Array(next.length);
  const ends = new Uint8Array(next.length);
  for (const state of terminals) ends[state] = 1;
  const queue = [...next[0].values()];
  for (const state of queue) {
    for (const [code, child] of next[state]) {
      let link = failure[state];
      for (; link !== 0 && !next[link].has(code); link = failure[link]) step();
      failure[child] = next[link].get(code) ?? 0;
      ends[child] |= ends[failure[child]];
      queue.push(child);
    }
  }
  /** Reads `text` once, calling `onEntry(line)` where an entry ends, and stops when it returns true. */
  function walk(text, onEntry) {
    let [state, line] = [0, 1];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.codePointAt(index);
      if (code > 0xffff) index += 1;
      if (code === CR || (code === LF && text.charCodeAt(index - 1) !== CR)) line += 1;
      const folded = fold(code);
      let target = next[state].get(folded);
      for (; target === undefined && state !== 0; target = next[state].get(folded)) {
        step();
        state = failure[state];
      }
      state = target ?? 0;
      step();
      if (ends[state] && onEntry(line)) return;
    }
  }
  const entryLines = (text, maxLines) => {
    const lines = [];
    walk(text, (line) => (lines.at(-1) === line ? false : lines.push(line) >= maxLines));
    return lines;
  };
  return { hasEntry: (text) => entryLines(text, 1).length > 0, entryLines };
}

/**
 * R-PRIVATE: finds list entries in every path and in every blob that was read, binary blobs included (decoded as UTF-8,
 * U+FFFD for invalid bytes). A text blob (valid UTF-8, no NUL byte) is also read with every backslash removed, so an entry
 * written with regex or string escapes is found; the removal keeps every line break, so the lines are the blob's own.
 * Returns findings { rule, kind: 'path' | 'content', entry, line? }, `entry` being the object reader's entry. Throws
 * GateInputError(limit:maxReportEntries) past that many findings.
 */
export function scanPrivate({ entries, matcher, limits }) {
  const findings = [];
  const add = (finding) => {
    findings.push({ rule: PRIVATE_RULE_ID, ...finding });
    if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
  };
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    if (matcher.hasEntry(entry.path)) add({ kind: 'path', entry });
    if (!entry.bytes) continue;
    const budget = limits.maxReportEntries + 1 - findings.length;
    const text = entry.bytes.toString('utf8');
    const views = !entry.bytes.includes(0) && decodeUtf8Strict(entry.bytes) !== null ? [text, text.replaceAll('\\', '')] : [text];
    const lines = new Set(views.flatMap((view) => matcher.entryLines(view, budget)));
    for (const line of [...lines].sort((first, second) => first - second).slice(0, budget)) add({ kind: 'content', entry, line });
  }
  return findings;
}
