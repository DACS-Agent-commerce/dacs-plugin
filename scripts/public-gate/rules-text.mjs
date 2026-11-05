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
/** A negative disclaimer; hyphen and space are equal. */
const DISCLAIMER = /\bnot (?:(?:a|an[ -]independent|independent)[ -]security[ -]review|security[ -]reviewed)\b/gi;
const APPROVED_SPAN = new RegExp(APPROVED_CLAUSE, 'gi');
const STATUS_TRIGGER = /security[ -]review|external review/i;
/** Sentence ends, semicolons and parentheses split a paragraph into clauses; the delimiter is kept. */
const CLAUSE_DELIMITER = /([.!?](?=\s|$)|[;()])/;
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'shell', 'console', 'zsh', 'powershell', 'cmd']);
/** Characters that never reach the matcher: invisible format characters and Markdown emphasis. */
const IGNORED_CHARACTERS = /[\p{Cf}*_`]/gu;
/** The start of a tag: its name, and whether it closes. */
const HTML_TAG = /<(\/?)([a-zA-Z][^\s/>]*)/y;
/** One attribute after a tag name: the separators before it, its name and its quoted or bare value; a quote never closed runs to the end of the page. */
const HTML_ATTRIBUTE = /[\s/]*(?:([^\s/>][^\s/>=]*)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]*)))?)?/y;
/** The end of a script or style block; one never closed runs to the end of the page, as a browser reads it. */
const HTML_RAW_END = { script: /<\/script(?=[\s/>]|$)/gi, style: /<\/style(?=[\s/>]|$)/gi };
const HTML_TEXT_ATTRIBUTES = new Set(['title', 'alt', 'placeholder', 'content']);
/** A character reference: a number (the `;` is optional) or a name of letters and digits with its `;` when it has one. */
const HTML_REFERENCE = /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*)(;?))/g;
/** The names of U+00A0 to U+00FF in order; a browser decodes them with or without the `;`, as it does the four markup names and the upper-case forms below. */
const HTML_LATIN1_NAMES = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
  + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
  + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
const HTML_LEGACY_NAMES = new Map([...HTML_LATIN1_NAMES.map((name, index) => [name, String.fromCharCode(0xa0 + index)]),
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['AMP', '&'], ['LT', '<'], ['GT', '>'], ['QUOT', '"'], ['COPY', '©'], ['REG', '®']]);
/** The names a browser decodes only with the `;`, and the characters they stand for. */
const HTML_SEMICOLON_NAMES = new Map([['apos', "'"], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwj', '‍'], ['zwnj', '‌']]);
const HTML_LEGACY_NAME_LENGTH = Math.max(...[...HTML_LEGACY_NAMES.keys()].map((name) => name.length));
/** Stands in the text for a reference the scanner cannot decode exactly; a page that holds it is refused. */
const UNDECODED_REFERENCE = '￾';
/** Source files, which R-WORDING does not read: the files the address rule reads as code, and the two source extensions it leaves out that R-EVAL parses. */
const SOURCE_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.jsx', '.cts']);

/** Text as the wording rule reads it: invisible characters and emphasis removed, each run of Unicode white space one space. */
const normalizeProse = (text) => text.replace(IGNORED_CHARACTERS, '').replace(/\p{White_Space}+/gu, ' ').trim();
/** A paragraph with the approved clause and the disclaimers replaced by a line break, which no entry holds. */
const maskStatusSpans = (paragraph) => paragraph.replace(DISCLAIMER, '\n').replace(APPROVED_SPAN, '\n');

/**
 * Builds the wording matcher over the list `entries`, each normalised as the text is. Returns the private matcher's `{ hasEntry, entryLines }`.
 * Throws GateInputError(wording-list-malformed) for an entry that holds a tab or is empty once normalised.
 */
export function createWordingMatcher(entries, checkpoint) {
  const normalized = entries.map(normalizeProse);
  if (normalized.includes('') || entries.some((entry) => entry.includes('\t'))) throw new GateInputError('wording-list-malformed', 'a wording list entry is empty after normalisation or holds a tab');
  return createPrivateMatcher(normalized, checkpoint);
}

const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Whether `line` closes a fence opened with `marker`: only that character, at least as many times. */
function isClosingFence(line, marker) {
  const run = CLOSING_FENCE.exec(line)?.[1];
  return run !== undefined && run[0] === marker[0] && run.length >= marker.length;
}

/** Marks each line of `lines` as 'text', a fence 'delimiter' or a fenced shell command 'command'; an unclosed fence marks nothing as a command. */
function markFences(lines) {
  const states = lines.map(() => 'text');
  for (let open = 0; open < lines.length; open += 1) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(lines[open]);
    if (!fence) continue;
    const [, marker, language] = fence;
    let close = open + 1;
    while (close < lines.length && !isClosingFence(lines[close], marker)) close += 1;
    if (close === lines.length) close = -1;
    states[open] = 'delimiter';
    if (close < 0) break;
    const body = lines.slice(open + 1, close).filter((line) => line.trim() !== '');
    const isCommand = SHELL_LANGUAGES.has(language.toLowerCase()) || (body.length > 0 && body.every((line) => /^(?:\$|>) /.test(line)));
    states[close] = 'delimiter';
    if (isCommand) for (let index = open + 1; index < close; index += 1) states[index] = 'command';
    open = close;
  }
  return states;
}

/** The paragraphs of `text` (runs of non-blank lines in one fence state) as { line (of the first line), text (wrapped lines joined, normalised), isCommand }. */
function paragraphsOf(text) {
  const lines = text.split(LINE_BREAK);
  const states = markFences(lines);
  const paragraphs = [];
  lines.forEach((line, index) => {
    if (line.trim() === '' || states[index] === 'delimiter') return;
    const last = paragraphs.at(-1);
    if (last && last.end === index - 1 && last.state === states[index]) Object.assign(last, { end: index, joined: `${last.joined} ${line}` });
    else paragraphs.push({ line: index + 1, end: index, state: states[index], joined: line });
  });
  return paragraphs.map(({ line, state, joined }) => ({ line, text: normalizeProse(joined), isCommand: state === 'command' }));
}

/** The character a numeric reference stands for, or UNDECODED_REFERENCE when a browser reads it as another one (zero, a surrogate, past U+10FFFF, U+0080 to U+009F). */
const numericReference = (code) => (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0x80 && code <= 0x9f) ? UNDECODED_REFERENCE : String.fromCodePoint(code));

/** What a name stands for: the exact character, the name itself when a browser leaves it as text, or UNDECODED_REFERENCE when the scanner cannot tell (a name it does not hold, or a legacy name that starts a longer one). */
function namedReference(reference, name, semicolon) {
  if (semicolon) return HTML_LEGACY_NAMES.get(name) ?? HTML_SEMICOLON_NAMES.get(name) ?? UNDECODED_REFERENCE;
  if (HTML_LEGACY_NAMES.has(name)) return HTML_LEGACY_NAMES.get(name);
  for (let length = Math.min(name.length, HTML_LEGACY_NAME_LENGTH); length >= 2; length -= 1) {
    if (HTML_LEGACY_NAMES.has(name.slice(0, length))) return UNDECODED_REFERENCE;
  }
  return reference;
}

/** `text` with each character reference replaced by its character (a line break by a space, so no line number moves; one not decoded exactly by UNDECODED_REFERENCE). */
const decodeEntities = (text) => text.replace(HTML_REFERENCE, (reference, decimal, hex, name, semicolon) => {
  const character = name !== undefined ? namedReference(reference, name, semicolon === ';') : numericReference(decimal !== undefined ? Number(decimal) : parseInt(hex, 16));
  return /[\r\n]/.test(character) ? ' ' : character;
});

/**
 * The text of an HTML page in one pass, with every line break kept: text nodes, comments, and the `title`, `alt`, `placeholder` and `content`
 * values, character references decoded. Only a real start tag opens a script or style block, which is skipped; a `<script` inside a comment or
 * an attribute does not. A tag or comment never closed, and a `<` that starts no tag, is read as text.
 */
function htmlText(html) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let text = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    text += decodeEntities(html.slice(index, open < 0 ? html.length : open));
    if (open < 0) break;
    HTML_TAG.lastIndex = open;
    const start = HTML_TAG.exec(html);
    if (html.startsWith('<!--', open) || (!start && '!?/'.includes(html[open + 1] ?? ' '))) {
      const comment = html.startsWith('<!--', open);
      const close = html.indexOf(comment ? '-->' : '>', open + 2);
      text += ` ${html.slice(open + (comment ? 4 : 2), close < 0 ? html.length : close)} `;
      index = close < 0 ? html.length : close + (comment ? 3 : 1);
    } else if (!start) {
      text += '<';
      index = open + 1;
    } else {
      const values = [];
      let end = HTML_TAG.lastIndex;
      while (end < html.length && html[end] !== '>') {
        HTML_ATTRIBUTE.lastIndex = end;
        const attribute = HTML_ATTRIBUTE.exec(html);
        end = HTML_ATTRIBUTE.lastIndex;
        if (attribute[1] !== undefined && HTML_TEXT_ATTRIBUTES.has(attribute[1].toLowerCase())) values.push(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      }
      if (end >= html.length) {
        text += decodeEntities(html.slice(open));
        break;
      }
      index = end + 1;
      text += `${blank(html.slice(open, index))} ${decodeEntities(values.join(' ')).replace(/\s+/g, ' ')}`;
      const rawEnd = start[1] === '' ? HTML_RAW_END[start[2].toLowerCase()] : undefined;
      if (rawEnd) {
        rawEnd.lastIndex = index;
        const stop = rawEnd.exec(html)?.index ?? html.length;
        text += blank(html.slice(index, stop));
        index = stop;
      }
    }
  }
  return text;
}

/** Every string value of parsed JSON with the key it sits under (null at the top). */
function jsonStrings(value, key = null) {
  if (typeof value === 'string') return [{ key, value }];
  if (Array.isArray(value)) return value.flatMap((item) => jsonStrings(item, key));
  return value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => jsonStrings(item, name)) : [];
}

/** The paragraphs of a manifest: each string value, at the first line of the file that holds its key (line 1 when none does); the raw text when it is not JSON. */
function manifestParagraphs(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return paragraphsOf(text);
  }
  const keyLines = new Map();
  text.split(LINE_BREAK).forEach((line, index) => {
    const key = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(line)?.[1];
    if (key !== undefined && !keyLines.has(key)) keyLines.set(key, index + 1);
  });
  return jsonStrings(parsed).flatMap(({ key, value }) => paragraphsOf(value).map((paragraph) => ({ ...paragraph, line: keyLines.get(JSON.stringify(key)) ?? 1 })));
}

/** The paragraphs of a prose, manifest or HTML blob, by its extension; those of a page that hold a reference not decoded exactly are marked `refused`. */
function proseParagraphs(file, text) {
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.json') return manifestParagraphs(text);
  if (extension !== '.html') return paragraphsOf(text);
  return paragraphsOf(htmlText(text)).map((paragraph) => ({ ...paragraph, refused: paragraph.text.includes(UNDECODED_REFERENCE) }));
}

/** True when a clause is the approved status clause: equal without case, a leading list marker or heading mark taken off. */
const isApprovedClause = (clause) => clause.replace(/^(?:[-+>#]+\s+)+/, '').toLowerCase() === APPROVED_CLAUSE;

/**
 * True when a paragraph states the status of the external review other than as the approved clause. Clauses end at sentence ends, semicolons
 * and parentheses; a clause (disclaimers masked) that mentions the review must be the approved clause, and the clause after an approved one
 * must not open at a semicolon or a parenthesis (a reason).
 */
function hasUnapprovedStatus(paragraph) {
  const parts = paragraph.split(CLAUSE_DELIMITER);
  const clauses = parts.flatMap((part, index) => (index % 2 === 0 && part.trim() !== '' ? [{ text: part.trim(), opener: parts[index - 1] ?? '' }] : []));
  return clauses.some((clause, index) => (isApprovedClause(clause.text)
    ? [';', '('].includes(clauses[index + 1]?.opener)
    : STATUS_TRIGGER.test(clause.text.replace(DISCLAIMER, ' '))));
}

/**
 * R-WORDING: in the prose of every text blob that is not source code (Markdown and text as prose, HTML text nodes and attributes, manifests by
 * string value, other files as text), refuses a wording-list entry, read in paragraphs with wrapped lines joined, and a sentence about the review's
 * status other than the approved clause. A fenced shell command may hold list entries. An HTML paragraph with a character reference the scanner
 * cannot decode exactly is refused as well. Returns findings { rule, kind: 'content', entry, line }.
 */
export function scanWording({ entries, wordingMatcher, limits }) {
  const { findings, add } = collectFindings(WORDING_RULE_ID, limits);
  for (const entry of entries.filter((candidate) => candidate.path !== null)) {
    const text = textOf(entry);
    if (text === null || SOURCE_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase())) continue;
    const lines = proseParagraphs(entry.path, text)
      .filter((paragraph) => paragraph.refused || hasUnapprovedStatus(paragraph.text) || (!paragraph.isCommand && wordingMatcher.hasEntry(maskStatusSpans(paragraph.text))))
      .map((paragraph) => paragraph.line);
    for (const line of new Set(lines)) add({ kind: 'content', entry, line });
  }
  return findings;
}

/** The 1-based lines of the first `maxLines` paragraphs of `text` that hold a list entry, read as files are (wrapped lines joined), with no status check; for commit and tag text. */
export const wordingEntryLines = (text, wordingMatcher, maxLines) => paragraphsOf(text)
  .filter((paragraph) => wordingMatcher.hasEntry(maskStatusSpans(paragraph.text))).map((paragraph) => paragraph.line).slice(0, maxLines);
