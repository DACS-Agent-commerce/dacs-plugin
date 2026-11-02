import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { decodeUtf8Strict, GateInputError } from './objects.mjs';

/** Id of the private-list rule in reports. */
export const PRIVATE_RULE_ID = 'R-PRIVATE';

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** Characters of text matched between two checkpoints; bounds how far the scan runs past its deadline. */
const SCAN_WINDOW_CHARS = 1024;

const patternFor = (entries, flags) => new RegExp([...entries].sort((a, b) => b.length - a.length)
  .map((entry) => entry.replace(REGEX_SYNTAX, '\\$&')).join('|'), flags);

/**
 * Reads the private list: one exact entry per line (CRLF, LF or CR ends a line), a leading byte-order mark, blank lines and
 * `#` comments ignored. Returns { entries, sha256 } (the hash is of the exact file bytes). Throws GateInputError when the
 * file is unreadable, over a limit, not UTF-8, empty, or has an entry with leading or trailing whitespace.
 */
export function readPrivateList(file, limits) {
  let bytes;
  try {
    if (statSync(file).size > limits.maxPrivateListBytes) throw new GateInputError('limit:maxPrivateListBytes', `the private list is over ${limits.maxPrivateListBytes} bytes`);
    bytes = readFileSync(file);
  } catch (error) {
    throw error instanceof GateInputError ? error : new GateInputError('private-list-unreadable', `--private-list cannot be read (${error.code ?? error.name})`);
  }
  const text = decodeUtf8Strict(bytes);
  if (text === null) throw new GateInputError('private-list-malformed', 'the private list is not valid UTF-8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const padded = lines.findIndex((line) => line !== line.trim() && !line.startsWith('#'));
  if (padded >= 0) throw new GateInputError('private-list-malformed', `line ${padded + 1} of the private list has leading or trailing whitespace`);
  const entries = lines.filter((line) => line !== '' && !line.startsWith('#'));
  if (entries.length === 0) throw new GateInputError('private-list-empty', 'the private list holds no entry');
  if (entries.length > limits.maxPrivateEntries) throw new GateInputError('limit:maxPrivateEntries', `the private list holds more than ${limits.maxPrivateEntries} entries`);
  return { entries, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Builds the case-insensitive matcher for exact list entries: `firstEntryIn(text)` is the 1-based number of the first
 * entry found in `text` or 0; `scrub(text)` replaces every entry; `linesIn(bytes, maxLines)` gives the 1-based lines of a
 * blob that hold an entry (at most `maxLines + 1`); bytes that are not valid UTF-8 read as U+FFFD, and line breaks are kept.
 * With `{ unescaped: true }` it also matches a view of the text with every backslash removed, so an entry written with
 * regex or string escapes is found; the removal keeps every line break, so the lines are the blob's own.
 * `checkpoint()` is called before every window of `SCAN_WINDOW_CHARS` characters is matched, and before each
 * single-entry search; whatever it throws (the scan deadline) stops the search and propagates.
 */
export function createPrivateMatcher(entries, checkpoint = () => {}) {
  const everywhere = patternFor(entries, 'giu');
  const singles = entries.map((entry) => patternFor([entry], 'iu'));
  const longest = Math.max(...entries.map((entry) => entry.length));
  const step = Math.max(SCAN_WINDOW_CHARS, longest);
  function* matchStarts(text) {
    for (let start = 0; start < text.length; start += step) {
      checkpoint();
      for (const { index } of text.slice(start, start + step + longest).matchAll(everywhere)) {
        if (index >= step) break;
        yield start + index;
      }
    }
  }
  return {
    firstEntryIn(text) {
      if (matchStarts(text).next().done) return 0;
      return singles.findIndex((single) => (checkpoint(), single.test(text))) + 1;
    },
    scrub: (text) => text.replace(everywhere, '[private]'),
    linesIn(bytes, maxLines, { unescaped = false } = {}) {
      const text = bytes.toString('utf8');
      const lines = new Set();
      for (const view of unescaped ? [text, text.replaceAll('\\', '')] : [text]) {
        let line = 1;
        let cursor = 0;
        for (const index of matchStarts(view)) {
          for (let newline = view.indexOf('\n', cursor); newline !== -1 && newline < index; newline = view.indexOf('\n', cursor)) {
            line += 1;
            cursor = newline + 1;
          }
          if (lines.add(line).size > maxLines) break;
        }
        if (lines.size > maxLines) break;
      }
      return [...lines].sort((first, second) => first - second);
    },
  };
}

/**
 * R-PRIVATE: finds list entries in every path and in every blob that was read, binary blobs included; a text blob (valid
 * UTF-8, no NUL byte) is also read with its backslashes removed. Returns findings
 * { rule, kind: 'path' | 'content', location, line? }. Throws GateInputError past `limits.maxReportEntries` findings.
 */
export function scanPrivate({ entries, matcher, emitter, limits }) {
  const findings = [];
  const add = (finding) => {
    findings.push({ rule: PRIVATE_RULE_ID, ...finding });
    if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
  };
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    if (matcher.firstEntryIn(entry.path) > 0) add({ kind: 'path', location: emitter.locate(entry) });
    const unescaped = Boolean(entry.bytes) && !entry.bytes.includes(0) && decodeUtf8Strict(entry.bytes) !== null;
    for (const line of entry.bytes ? matcher.linesIn(entry.bytes, limits.maxReportEntries, { unescaped }) : []) add({ kind: 'content', location: emitter.locate(entry), line });
  }
  return findings;
}
