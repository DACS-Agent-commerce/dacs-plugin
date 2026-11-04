import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FULL_OBJECT_ID, GateInputError } from './objects.mjs';
import { textOf, viewsOf } from './rules-address.mjs';

/** Id of the rule that refuses internal reports in reports. */
export const REPORT_RULE_ID = 'R-REPORT';
/** Id of the rule that refuses issue and pull-request references in reports. */
export const ISSUE_RULE_ID = 'R-ISSUE';

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
