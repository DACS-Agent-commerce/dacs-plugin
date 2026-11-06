import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';
import { CODE_EXTENSIONS, textOf, viewsOf } from './rules-address.mjs';
import { createPrivateMatcher } from './rules-private.mjs';

/** Id of the rule that refuses internal reports in reports. */
export const REPORT_RULE_ID = 'R-REPORT';
/** Id of the rule that refuses issue and pull-request references in reports. */
export const ISSUE_RULE_ID = 'R-ISSUE';
/** Id of the rule that refuses wording-list entries and unapproved status sentences in prose. */
export const WORDING_RULE_ID = 'R-WORDING';

const LINE_BREAK = /\r\n|\r|\n/;
const sha256Of = (text) => createHash('sha256').update(text).digest('hex');
const isText = (value) => typeof value === 'string' && value !== '';

/** Findings of one rule: `add` appends and throws GateInputError(limit:maxReportEntries) past that many. */
function collectFindings(rule, limits) {
  const findings = [];
  const add = (finding) => {
    findings.push({ rule, ...finding });
    if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
  };
  return { findings, add };
}

// ---- R-REPORT -------------------------------------------------------------------------------------------------------

const REPORT_FILE_NAMES = new Set([['fix', 'report.md'], ['pr', 'report.md'], ['progress.md']].map((parts) => parts.join('-')));
const NOTES_DIRECTORIES = new Set(['fix-tmp', 'stack'].map((name) => `.${name}`));
const HEADER_MARKERS = [['frozen', 'input'], ['canonical', 'snapshot'], ['review', 'round']].map((words) => words.join(' '));
/** How many non-blank lines from the top of a Markdown file may hold a header. */
const HEADER_WINDOW = 20;
const MARKER_REST = /^(?:\s*[:(]|\s+(?:\d|[0-9a-f]{7,40}\b))/;

/** A header label as compared: lower case, emphasis and a leading number removed, space, hyphen and underscore equal, no trailing colon. */
const labelOf = (text) => text.replace(/[*`]/g, '').replace(/^\s*\d+[.)]\s*/, '').toLowerCase().replace(/[\s_-]+/g, ' ').trim().replace(/:$/, '');
const isReportLabel = (label) => HEADER_MARKERS.some((marker) => label.startsWith(marker) && (label === marker || MARKER_REST.test(label.slice(marker.length))));

/** The 1-based line of the first header label in the first lines of Markdown `lines`: an ATX or setext heading, a front-matter key or a bold label; undefined when none is a report marker. */
function reportHeaderLine(lines) {
  const frontMatterEnd = lines[0]?.trim() === '---' ? lines.findIndex((text, index) => index > 0 && text.trim() === '---') : -1;
  const candidates = lines.flatMap((text, index) => (text.trim() === '' ? [] : [{ text, index }])).slice(0, HEADER_WINDOW);
  const found = candidates.find(({ text, index }) => {
    const label = /^ {0,3}#{1,6}\s+(.*)$/.exec(text)?.[1] ?? /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(text)?.[1]
      ?? (/^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? '') || (index > 0 && index < frontMatterEnd) ? text : undefined);
    return label !== undefined && isReportLabel(labelOf(label));
  });
  return found && found.index + 1;
}

/**
 * R-REPORT: refuses a working-report file name or a working-notes directory in any path (case-insensitive file names, any depth), and a Markdown
 * blob with a frozen-input, canonical-snapshot or review-round header. Returns findings { rule, kind: 'path' | 'content', entry, line? }.
 */
export function scanReports({ entries, limits }) {
  const { findings, add } = collectFindings(REPORT_RULE_ID, limits);
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    const segments = entry.path.split('/');
    if (REPORT_FILE_NAMES.has(segments.at(-1).toLowerCase()) || segments.some((segment) => NOTES_DIRECTORIES.has(segment))) add({ kind: 'path', entry });
    const text = path.posix.extname(entry.path).toLowerCase() === '.md' ? textOf(entry) : null;
    const line = text === null ? undefined : reportHeaderLine(text.split(LINE_BREAK));
    if (line !== undefined) add({ kind: 'content', entry, line });
  }
  return findings;
}

// ---- R-ISSUE --------------------------------------------------------------------------------------------------------

const NUMBER_SIGN_REFERENCE = /#\d+(?![\w-]|\.\w)/g;
/** Any GitHub address form of a repository (page, clone, raw or API); `kind` is set for an issue, pull request or discussion address. */
const GITHUB_LINK = new RegExp(String.raw`(?<![\w.-])(?:(?:https?://|ssh://git@|git@)?(?:www\.|api\.)?github\.com[/:](?:repos/)?|(?:https?://)?raw\.githubusercontent\.com/)(?!orgs/)`
  + String.raw`(?<owner>[\w.-]+)/(?<repo>[\w.-]+?)(?:\.git)?(?![\w-]|\.\w)(?<kind>/(?:issues|pulls?|discussions)(?![\w-]))?`, 'gi');
const OWNER_AND_REPOSITORY = /^([A-Za-z0-9-]+)\/([\w.-]+)$/;
const FILE_EXTENSION = /\.[A-Za-z]+$/;
/** Characters before a number sign that are read as its context. */
const CONTEXT_CHARS = 120;
/** A declaration of a colour property whose value so far is only numbers with units and border styles. Property names are lower case; each token ends in whitespace. */
const COLOUR_DECLARATION = /(?:^|[\s;{(,"'`])(?:--[\w-]+|color|background[\w-]*|border[\w-]*|outline[\w-]*|fill|stroke|box-shadow|text-shadow):\s*(?:(?:[\d.]+(?:px|em|rem|%)?|solid|dashed|dotted|double|inset)\s+)*$/;
const COLOUR_VALUE_END = /^\s*(?:[;}!"'`]|$)/;
const COLOUR_ATTRIBUTE_BEFORE = /(?:\b(?:fill|stroke|bgcolor|color)=["']|style=["']\s*[\w-]+\s*:\s*|<meta[^>]*theme-color[^>]*content=["'])$/i;
const COLOUR_ATTRIBUTE_AFTER = /^\s*;?\s*["']/;

const isColour = (before, after) => (COLOUR_DECLARATION.test(before) && COLOUR_VALUE_END.test(after)) || (COLOUR_ATTRIBUTE_BEFORE.test(before) && COLOUR_ATTRIBUTE_AFTER.test(after));

/** True when the number sign at `index` of `line` is no reference: an entity, a PKCS name, a placeholder, a link fragment or a colour. */
function isHarmlessNumberSign(line, index, end) {
  const before = line.slice(Math.max(0, index - CONTEXT_CHARS), index);
  const run = /[^\s([<>"'`]*$/.exec(before)[0];
  const isPlaceholder = /^\w+$/.test(run) && before.at(-run.length - 1) === '<' && line[end] === '>';
  const isFragment = /\]\($|(?:href|src)=["']?$/.test(before) || (run !== '' && !run.includes('#') && (run.includes('/') || FILE_EXTENSION.test(run)));
  return /&$|PKCS ?$/.test(before) || isPlaceholder || isFragment || isColour(before, line.slice(end));
}

/** The owner and repository when the run before a number sign is `owner/repo`, else null. Another owner's `name.ext` is a file path, not a repository; the organisation's repository names may hold dots. */
function repositoryBeforeNumberSign(line, index, isListed) {
  const run = /[^\s([<>"'`]*$/.exec(line.slice(Math.max(0, index - CONTEXT_CHARS), index))[0];
  const match = OWNER_AND_REPOSITORY.exec(run);
  return match && (isListed.isOrganisation(match[1]) || !FILE_EXTENSION.test(match[2])) ? { owner: match[1], repo: match[2] } : null;
}

/** True when `view` of a line holds a reference that does not pass: a number sign reference, or a repository address, other than a listed repository's. */
function hasUnlistedReference(view, isListed) {
  const links = [...view.matchAll(GITHUB_LINK)].map(({ groups }) => groups);
  const unlistedLink = links.some(({ owner, repo, kind }) => (kind !== undefined || isListed.isOrganisation(owner)) && !isListed(owner, repo));
  const unlistedNumber = [...view.matchAll(NUMBER_SIGN_REFERENCE)].some((match) => {
    const named = repositoryBeforeNumberSign(view, match.index, isListed);
    return named ? !isListed(named.owner, named.repo) : !isHarmlessNumberSign(view, match.index, match.index + match[0].length);
  });
  return unlistedLink || unlistedNumber;
}

/** The test of `publicRepositories`: `(owner, repo)` is true for a listed repository, compared as whole segments without case; `.isOrganisation(owner)` for the organisation. */
function listedRepositoryCheck({ owner, repositories }) {
  const listed = new Set(repositories.map((name) => `${owner}/${name}`.toLowerCase()));
  return Object.assign((candidateOwner, repo) => listed.has(`${candidateOwner}/${repo}`.toLowerCase()), { isOrganisation: (candidate) => candidate.toLowerCase() === owner.toLowerCase() });
}

const DISPOSITION_KEYS = ['blob', 'field', 'line', 'path', 'reason', 'valueSha256'];
const isLockfilePath = (file) => file.split('/').at(-1) === 'package-lock.json';
const isDisposition = (row) => row !== null && typeof row === 'object' && isDeepStrictEqual(Object.keys(row).sort(), DISPOSITION_KEYS) && isText(row.path) && isLockfilePath(row.path)
  && FULL_OBJECT_ID.test(row.blob) && isText(row.field) && Number.isSafeInteger(row.line) && row.line > 0 && /^[0-9a-f]{64}$/.test(row.valueSha256) && isText(row.reason);

/**
 * Whether `config.publicRepositories` ({ owner, repositories }: names of letters, digits, `.`, `_` and `-`, no duplicate) and
 * `config.lockfileDispositions` (a list of { path (a package-lock.json), blob (a full object id), field, line (a positive integer),
 * valueSha256, reason }, no duplicate) are well formed.
 */
export function hasValidTextConfig({ publicRepositories, lockfileDispositions }) {
  const names = publicRepositories?.repositories;
  return typeof publicRepositories?.owner === 'string' && /^[A-Za-z0-9-]+$/.test(publicRepositories.owner)
    && Array.isArray(names) && names.every((name) => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name)) && new Set(names).size === names.length
    && Array.isArray(lockfileDispositions) && lockfileDispositions.every(isDisposition) && new Set(lockfileDispositions.map((row) => JSON.stringify(row))).size === lockfileDispositions.length;
}

/** The `"deprecated"` lines of a lockfile as Map<1-based line, { field, valueSha256 }>, found by parsing it; empty when it is not JSON with a `packages` object. */
function deprecatedLines(text) {
  let packages;
  try {
    packages = JSON.parse(text).packages;
  } catch { /* not JSON: no line is a deprecation notice */ }
  const linesByText = new Map();
  text.split(LINE_BREAK).forEach((line, index) => { if (line.trimStart().startsWith('"deprecated":')) linesByText.set(line.trim().replace(/,$/, ''), [...(linesByText.get(line.trim().replace(/,$/, '')) ?? []), index + 1]); });
  const found = new Map();
  const seen = new Map();
  for (const [key, entry] of Object.entries(packages ?? {})) {
    if (typeof entry?.deprecated !== 'string') continue;
    const lineText = `"deprecated": ${JSON.stringify(entry.deprecated)}`;
    seen.set(lineText, (seen.get(lineText) ?? 0) + 1);
    const line = linesByText.get(lineText)?.[seen.get(lineText) - 1];
    if (line !== undefined) found.set(line, { field: `packages[${JSON.stringify(key)}].deprecated`, valueSha256: sha256Of(entry.deprecated) });
  }
  return found;
}

/** `(entry, text)` returns the lines of a lockfile that an exact `lockfileDispositions` entry passes, as a Set of 1-based line numbers: its path, blob, field, line and value hash all match. */
function reviewedLockfileLines(dispositions) {
  const reviewed = new Set(dispositions.map((row) => [row.path, row.blob, row.field, row.line, row.valueSha256].join('\0')));
  return (entry, text) => {
    if (!dispositions.some((row) => row.path === entry.path && row.blob === entry.oid)) return new Set();
    return new Set([...deprecatedLines(text)].filter(([line, { field, valueSha256 }]) => reviewed.has([entry.path, entry.oid, field, line, valueSha256].join('\0'))).map(([line]) => line));
  };
}

/**
 * R-ISSUE: refuses, in every text blob, a bare number-sign reference (also `PR`/`issue` forms, in fences, comments and strings), an `owner/repo`
 * reference and a GitHub issue, pull-request or discussion address unless its repository is in `config.publicRepositories`, and any address of
 * the organisation's repositories not in that list. A colour value and a link fragment are no reference. A lockfile line passes only through an exact
 * `config.lockfileDispositions` entry. Returns findings { rule, kind: 'content', entry, line }.
 */
export function scanIssues({ entries, config, limits }) {
  const isListed = listedRepositoryCheck(config.publicRepositories);
  const reviewedLines = reviewedLockfileLines(config.lockfileDispositions);
  const { findings, add } = collectFindings(ISSUE_RULE_ID, limits);
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    const text = textOf(entry);
    if (text === null) continue;
    const reviewed = isLockfilePath(entry.path) ? reviewedLines(entry, text) : new Set();
    text.split(LINE_BREAK).forEach((line, index) => {
      if (!reviewed.has(index + 1) && viewsOf(line).some((view) => hasUnlistedReference(view, isListed))) add({ kind: 'content', entry, line: index + 1 });
    });
  }
  return findings;
}

/**
 * Stops the run when a `lockfileDispositions` entry is stale: the scanned `entries` ({ path, oid }; in history the union over every commit)
 * hold its path, but never at its blob. A tree that does not hold the path is not stale. Throws GateInputError(stale-lockfile-disposition).
 */
export function requireNoStaleLockfileDisposition(entries, dispositions) {
  const stale = dispositions.find((row) => entries.some((entry) => entry.path === row.path) && !entries.some((entry) => entry.path === row.path && entry.oid === row.blob));
  if (stale) throw new GateInputError('stale-lockfile-disposition', 'a lockfileDispositions entry names a path the target holds only at another blob');
}

// ---- R-WORDING ------------------------------------------------------------------------------------------------------

const APPROVED_CLAUSE = 'the external security review is on hold';
/** The gap between the words of a status phrase: white space or any dash, one or more (an empty gap would flag a camelCase field name). */
const GAP = String.raw`[\s\p{Pd}]+`;
/** A negative disclaimer; white space and any dash are equal. */
const DISCLAIMER = new RegExp(String.raw`\bnot (?:(?:a|an${GAP}independent|independent)${GAP}security${GAP}review|security${GAP}reviewed)\b`, 'giu');
const APPROVED_SPAN = new RegExp(APPROVED_CLAUSE, 'gi');
const STATUS_TRIGGER = new RegExp(`(?:security|external)${GAP}review`, 'iu');
/** Sentence ends, semicolons and parentheses split a paragraph into clauses; the delimiter is kept. */
const CLAUSE_DELIMITER = /([.!?](?=\s|$)|[;()])/;
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'shell', 'console', 'zsh', 'powershell', 'cmd']);
/** Characters that never reach the matcher: invisible format characters and Markdown emphasis. */
const IGNORED_CHARACTERS = /[\p{Cf}*_`]/gu;
/** A numeric or named character reference, with or without its `;`. Only the six KNOWN_REFERENCES are read; a text holding any other is refused. */
const CHARACTER_REFERENCE = /&(?:#[\da-zA-Z]*|[A-Za-z][\da-zA-Z]*);?/g;
const KNOWN_REFERENCES = new Map([['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' ']]);
/** Markup not shown as written, read left to right: an HTML comment, a tag with its attributes, a Markdown reference definition, link destination,
 * reference label or link bracket, block-quote marks, an escaping backslash and a character reference. One never closed runs to the end of the text. */
const MARKUP_TOKEN = new RegExp([String.raw`<!--[\s\S]*?(?:-->|$)`, String.raw`<(?:\/?[A-Za-z]|[!?])(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^"'>])*(?:>|$)`,
  String.raw`(?<![^\r\n]) {0,3}\[[^\]\r\n]*\]:[^\r\n]*`, String.raw`\]\([^)]*(?:\)|$)`, String.raw`\]\[[^\]]*(?:\]|$)`, String.raw`!?\[|\]`,
  String.raw`(?<![^\r\n])[ \t]*(?:>[ \t]?)+`, String.raw`\\(?=[!-/:-@[-\`{-~]|\r|\n)`, CHARACTER_REFERENCE.source].join('|'), 'g');
/** A fence line: its marker (backticks with no backtick after them, or tildes) and the text after it. */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
/** Source files, which R-WORDING does not read: the files the address rule reads as code, and the two source extensions it leaves out that R-EVAL parses. */
const SOURCE_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.jsx', '.cts']);
const markupAs = (filler) => (text) => text.replace(MARKUP_TOKEN, (token) => (token === '\\' ? '' : filler));
/** How metadata is read (as written) and, with markup, pull-request text and blobs; a blob as written has the six known references decoded. */
const [METADATA_READINGS, MARKUP_READINGS] = [[(text) => text], [(text) => text, markupAs(''), markupAs(' ')]];
const BLOB_READINGS = [(text) => text.replace(CHARACTER_REFERENCE, (reference) => KNOWN_REFERENCES.get(reference) ?? reference), markupAs(''), markupAs(' ')];

/** Text as the wording rule reads it: invisible characters and emphasis replaced by `filler` (nothing for the list, a space for the status words), each run of Unicode white space one space. */
const normalizeProse = (text, filler = '') => text.replace(IGNORED_CHARACTERS, filler).replace(/\p{White_Space}+/gu, ' ').trim();
/** The views of `source` through `readings`, normalised, in their order; only the one as written when it holds no markup character. */
const viewsThrough = (source, readings) => (/[&<>[\]\\]/.test(source) ? readings.map((read) => normalizeProse(read(source))) : [normalizeProse(source)]);

/** Builds the wording matcher over the list `entries`, each normalised as the text is. Returns the private matcher; throws GateInputError(wording-list-malformed) for an entry that holds a tab or is empty once normalised. */
export function createWordingMatcher(entries, checkpoint) {
  const normalized = entries.map((entry) => normalizeProse(entry));
  if (normalized.includes('') || entries.some((entry) => entry.includes('\t'))) throw new GateInputError('wording-list-malformed', 'a wording list entry is empty after normalisation or holds a tab');
  return createPrivateMatcher(normalized, checkpoint);
}

/**
 * The paragraphs of `text` as { line (1-based, of the first line), source, isCommand }: runs of lines in one fence state, ended by a blank line that does not start
 * inside a markup token. A closed fence's opener is a paragraph of its own (the text after its marker is read), its closer is in none, and its body is a command
 * when its language is a shell. An opener starts neither inside markup nor in an HTML block (non-blank lines from one that starts with `<`); its closer is the
 * first later line of its marker, at least as long, with nothing after it. One pass each; an unclosed fence is text.
 */
function paragraphsOf(text) {
  const lines = text.split(LINE_BREAK);
  const [starts, inMarkup, states, paragraphs] = [[0], new Uint8Array(lines.length), lines.map(() => 'text'), []];
  for (let index = 1; index < lines.length; index += 1) starts.push(starts[index - 1] + lines[index - 1].length + (text.startsWith('\r\n', starts[index - 1] + lines[index - 1].length) ? 2 : 1));
  let [line, open, htmlBlock] = [0, null, false];
  for (const { index, 0: token } of text.matchAll(MARKUP_TOKEN)) {
    while (starts[line] <= index) line += 1;
    for (; starts[line] < index + token.length; line += 1) inMarkup[line] = 1;
  }
  lines.forEach((content, index) => {
    const fence = FENCE.exec(content);
    if (open && fence?.[1][0] === open.marker[0] && fence[1].length >= open.marker.length && fence[2].trim() === '') {
      states.fill(SHELL_LANGUAGES.has(open.language) ? 'command' : 'text', open.index + 1, index);
      states[open.index] = 'opener';
      states[index] = 'closer';
      open = null;
    } else if (!open && fence && !inMarkup[index] && !htmlBlock) open = { index, marker: fence[1], language: fence[2].trim().split(/\s/)[0].toLowerCase() };
    htmlBlock = content.trim() !== '' && (htmlBlock || ((index === 0 || lines[index - 1].trim() === '') && /^ {0,3}</.test(content)));
  });
  lines.forEach((content, index) => {
    if (states[index] === 'closer' || (content.trim() === '' && !inMarkup[index])) return;
    const last = paragraphs.at(-1);
    if (last?.end === index - 1 && last.state === states[index] && states[index] !== 'opener') last.end = index;
    else paragraphs.push({ first: index, end: index, state: states[index] });
  });
  return paragraphs.map(({ first, end, state }) => ({ line: first + 1, source: text.slice(starts[first], starts[end] + lines[end].length), isCommand: state === 'command' }));
}

/** The approved-clause and disclaimer spans of `view` as [start, end], in order (they never overlap); none when it does not mention the review. */
const exemptSpansOf = (view) => (STATUS_TRIGGER.test(view) ? [...view.matchAll(DISCLAIMER), ...view.matchAll(APPROVED_SPAN)].map((match) => [match.index, match.index + match[0].length])
  .sort((first, second) => first[0] - second[0]) : []);

/** Whether a list entry occurs in `view` other than wholly inside one of `spans`: an entry that crosses a span's edge counts. */
function hasEntryOutside(view, wordingMatcher, spans) {
  let [next, found] = [0, false];
  wordingMatcher.eachEntry(view, (start, end) => {
    while (spans[next]?.[1] < end) next += 1;
    found = !(spans[next]?.[0] <= start);
    return found;
  });
  return found;
}

/** True when a clause is the approved status clause: equal without case, a leading list marker or heading mark taken off. */
const isApprovedClause = (clause) => clause.replace(/^(?:[-+>#]+\s+)+/, '').toLowerCase() === APPROVED_CLAUSE;

/** True when a paragraph states the status of the external review other than as the approved clause. Clauses end at sentence ends, semicolons and parentheses; a
 * clause (disclaimers masked) that mentions the review must be the approved clause, and the clause after an approved one must not open at `;` or `(` (a reason). */
function hasUnapprovedStatus(paragraph) {
  const parts = paragraph.split(CLAUSE_DELIMITER);
  const clauses = parts.flatMap((part, index) => (index % 2 === 0 && part.trim() !== '' ? [{ text: part.trim(), opener: parts[index - 1] ?? '' }] : []));
  return clauses.some((clause, index) => (isApprovedClause(clause.text)
    ? [';', '('].includes(clauses[index + 1]?.opener)
    : STATUS_TRIGGER.test(clause.text.replace(DISCLAIMER, ' '))));
}

/** The lines of prose `text` holding a character reference other than the six known ones, or starting a paragraph one of whose views states a status other than the
 * approved clause or, outside a fenced shell command, holds a list entry not wholly inside an approved clause or a disclaimer of that view. */
function proseFindingLines(text, wordingMatcher) {
  const lines = text.includes('&') ? text.split(LINE_BREAK).flatMap((line, index) => ([...line.matchAll(CHARACTER_REFERENCE)].some(([reference]) => !KNOWN_REFERENCES.has(reference)) ? [index + 1] : [])) : [];
  for (const { line, source, isCommand } of paragraphsOf(text)) {
    const [asWritten, ...rendered] = viewsThrough(source, BLOB_READINGS);
    const statusViews = rendered.length === 0 ? [asWritten] : [...rendered];
    // The same readings with invisible characters and emphasis as a space, so `external_review` and `external**review` still read as two words.
    statusViews.push(...(rendered.length === 0 ? [source] : BLOB_READINGS.slice(1).map((read) => read(source))).map((view) => normalizeProse(view, ' ')));
    if (statusViews.some((view) => STATUS_TRIGGER.test(view) && hasUnapprovedStatus(view))
      || (!isCommand && [...new Set([asWritten, ...rendered])].some((view) => hasEntryOutside(view, wordingMatcher, exemptSpansOf(view))))) lines.push(line);
  }
  return new Set(lines);
}

/** A string literal of JSON text: in valid JSON nothing else holds a quote, so these are every key and string value, repeated keys included. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/gs;

/** The lines of a manifest where R-WORDING finds something: each string literal (key or value, a repeated key's earlier value too) read as prose, at the line of
 * the file that holds the literal; the raw text when it is not JSON. `JSON.parse` only checks validity: it drops repeated keys' earlier values and never shows keys. */
function manifestFindingLines(text, wordingMatcher) {
  try {
    JSON.parse(text);
  } catch {
    return proseFindingLines(text, wordingMatcher);
  }
  const lines = new Set();
  let [line, from] = [1, 0];
  for (const { 0: literal, index } of text.matchAll(JSON_STRING)) {
    line += text.slice(from, index).match(/\r\n|\r|\n/g)?.length ?? 0;
    from = index;
    if (proseFindingLines(JSON.parse(literal), wordingMatcher).size > 0) lines.add(line);
  }
  return lines;
}

/**
 * R-WORDING: in every text blob that is not source code, read as prose (a `.json` manifest by string literal, keys included), refuses a wording-list entry, a sentence about the
 * review's status other than the approved clause, and a character reference other than `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` and `&nbsp;`. Paragraphs are read
 * with wrapped lines joined, in three views: as written (the six decoded), with markup erased and with each markup token one space. Returns findings { rule, kind: 'content', entry, line }.
 */
export function scanWording({ entries, wordingMatcher, limits }) {
  const { findings, add } = collectFindings(WORDING_RULE_ID, limits);
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    const [text, extension] = [textOf(entry), path.posix.extname(entry.path).toLowerCase()];
    if (text === null || SOURCE_EXTENSIONS.has(extension)) continue;
    const lines = extension === '.json' ? manifestFindingLines(text, wordingMatcher) : proseFindingLines(text, wordingMatcher);
    for (const line of [...lines].sort((first, second) => first - second)) add({ kind: 'content', entry, line });
  }
  return findings;
}

/** The 1-based lines of the first `maxLines` paragraphs of commit or tag text, a header or (with `readMarkup`) pull-request text that hold a list entry, read as
 * written with wrapped lines joined and, with `readMarkup`, also with markup erased and spaced. No span is exempt and no status is checked. */
export const wordingEntryLines = (text, wordingMatcher, maxLines, { readMarkup = false } = {}) => paragraphsOf(text)
  .filter(({ source }) => viewsThrough(source, readMarkup ? MARKUP_READINGS : METADATA_READINGS).some((view) => wordingMatcher.hasEntry(view))).map(({ line }) => line).slice(0, maxLines);
