import { GateInputError } from './objects.mjs';
import { textOf } from './rules-address.mjs';

/** Id of the env-template rule in reports. */
export const ENV_RULE_ID = 'R-ENV';
/** Id of the hosting-file rule in reports. */
export const HOSTING_RULE_ID = 'R-HOSTING';
/** Id of the archive rule in reports. */
export const ARCHIVE_RULE_ID = 'R-ARCHIVE';

const LINE_BREAK = /\r\n|\r|\n/;
const TEMPLATE_SUFFIX = /\.(?:example|sample|template)$/;
/** An env template name: `env`, any stage segments, then a template suffix (`.env.example`, `.env.production.sample`, `prod.env.template`). */
const ENV_TEMPLATE_NAME = /(?:^|\.)env(?:\.[^.]*)*\.(?:example|sample|template)$/;
const REAL_ENV_NAME = /(?:^\.env|\.env)(?:\.|$)/;
const SYSTEMD_UNIT_NAME = /\.service$/;
const CADDYFILE_NAME = 'caddyfile';
const HOSTING_DIRECTORY = 'deploy';
const VENDOR_DIRECTORY = 'vendor';

const ENV_ASSIGNMENT = /^(?:export +)?(?<key>[A-Za-z_][\w.-]*)=(?<value>.*)$/;
const COMMENTED_ENV_ASSIGNMENT = /^#\s*(?:export +)?(?<key>[A-Za-z_][\w.-]*)=(?<value>.*)$/;
const QUOTED_VALUE = /^(?<quote>["'])(?<inner>.*)\k<quote>$/;
const WHOLE_NUMBER = /^\d+$/;
/** A value that stands for a secret without being one: an angle-bracket or `${}` slot, `REPLACE_ME`, `CHANGE_ME`, `your-...-here`, or a run of x. */
const PLACEHOLDER = /^(?:<[^<>]*>|\$\{[^{}]*\}|(?:replace|change)[-_]?me|your[-_][a-z]+(?:[-_][a-z]+)*[-_]here|x{3,})$/i;

/** Settings the server parses as a whole number in a range; `src/config.mjs` reads the token lifetime with `parseInteger(..., { min: 60, max: 3600 })`. */
const INTEGER_SETTINGS = { DACS_ACCESS_TOKEN_TTL_SECONDS: { min: 60, max: 3600 } };
/** Settings that hold a credential: only empty or a placeholder passes. */
const CREDENTIAL_SETTINGS = new Set(['DACS_OAUTH_COOKIE_KEYS']);
/** A key naming one of these words, or `key` after one of the qualifiers, is read as holding a secret. */
const SECRET_WORDS = new Set(['secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'passwd', 'passphrase', 'mnemonic', 'seed',
  'credential', 'credentials', 'privatekey', 'apikey', 'signingkey', 'secretkey', 'accesskey']);
const KEY_WORDS = new Set(['key', 'keys']);
const KEY_QUALIFIERS = new Set(['signing', 'private', 'secret', 'api', 'access', 'auth', 'encryption', 'master', 'cookie']);
const SECRET_WORD_ENDINGS = [...SECRET_WORDS, ...[...KEY_QUALIFIERS].flatMap((qualifier) => [...KEY_WORDS].map((keyWord) => `${qualifier}${keyWord}`))];
const CAMEL_CASE_BOUNDARY =/([a-z\d])([A-Z])/g;
const NAME_SEPARATORS = /[^A-Za-z\d]+/;

const TAR_MAGIC = Buffer.from('ustar');
const TAR_MAGIC_OFFSET = 257;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
/** The zip signatures of a local file header, an empty archive and a spanned archive. */
const ZIP_MAGICS = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]].map((bytes) => Buffer.from(bytes));
const ZIP_END_MAGIC = ZIP_MAGICS[1];
const ZIP_END_RECORD_BYTES = 22;
const ZIP_COMMENT_LENGTH_OFFSET = 20;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

/** The lower-case directory segments of `file` and its lower-case file name. */
function lowerCaseParts(file) {
  const segments = file.toLowerCase().split('/');
  return { directories: segments.slice(0, -1), name: segments.at(-1) };
}

/**
 * Builds a rule that calls `scanEntry(entry, add)` for every entry with a path; `add({ kind, entry, line? })` records a
 * finding for `ruleId`. Throws GateInputError(limit:maxReportEntries) past that many findings.
 */
function createFileRule(ruleId, scanEntry) {
  return function scan({ entries, limits }) {
    const findings = [];
    const add = (finding) => {
      findings.push({ rule: ruleId, ...finding });
      if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
    };
    for (const entry of entries.filter((candidate) => candidate.path !== null)) scanEntry(entry, add);
    return findings;
  };
}

const wordsOf = (key) => key.replace(CAMEL_CASE_BOUNDARY, '$1 $2').split(NAME_SEPARATORS).filter(Boolean).map((word) => word.toLowerCase());

/**
 * Whether `key` names a secret: split on `_`, `-`, `.` and camelCase boundaries and compared case-insensitively. A word also
 * counts when it ends with a secret word or a qualifier and `key`, so `GITHUBTOKEN` and `AUTHKEY` read as secrets.
 */
function isSecretName(key) {
  const words = wordsOf(key);
  return words.some((word, index) => SECRET_WORD_ENDINGS.some((ending) => word.endsWith(ending)) || (KEY_WORDS.has(word) && KEY_QUALIFIERS.has(words[index - 1])));
}

const unquoted = (value) => QUOTED_VALUE.exec(value)?.groups.inner ?? value;

/** The `{ key, value }` of an env line (a commented-out assignment counts), null for a blank or comment line, or `{ key: null }` for any other line. */
function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const match = ENV_ASSIGNMENT.exec(trimmed) ?? COMMENTED_ENV_ASSIGNMENT.exec(trimmed);
  if (match) return { key: match.groups.key, value: unquoted(match.groups.value.trim()) };
  return trimmed.startsWith('#') ? null : { key: null };
}

const isEmptyOrPlaceholder = (value) => value === '' || PLACEHOLDER.test(value);

function isRefusedEnvAssignment({ key, value }) {
  if (key === null) return true;
  const range = INTEGER_SETTINGS[key];
  if (range) return value !== '' && !(WHOLE_NUMBER.test(value) && Number(value) >= range.min && Number(value) <= range.max);
  return (CREDENTIAL_SETTINGS.has(key) || isSecretName(key)) && !isEmptyOrPlaceholder(value);
}

/**
 * R-ENV: in `.env[.<stage>].example`, `.sample` and `.template` files (also `<name>.env...`), refuses a line that is not an assignment, a typed
 * setting outside its range, and a credential or secret-named key (commented out or not) whose value is neither empty nor a
 * placeholder. Returns findings { rule, kind: 'content', entry, line }.
 */
export const scanEnvTemplates = createFileRule(ENV_RULE_ID, (entry, add) => {
  const text = ENV_TEMPLATE_NAME.test(lowerCaseParts(entry.path).name) ? textOf(entry) : null;
  if (text === null) return;
  text.split(LINE_BREAK).forEach((line, index) => {
    const assignment = parseEnvLine(line);
    if (assignment !== null && isRefusedEnvAssignment(assignment)) add({ kind: 'content', entry, line: index + 1 });
  });
});

const isHostingFileName = (name) => !TEMPLATE_SUFFIX.test(name) && (name === CADDYFILE_NAME || SYSTEMD_UNIT_NAME.test(name) || REAL_ENV_NAME.test(name));

/**
 * R-HOSTING: refuses any path under a `deploy` directory, a `*.service` unit, a `Caddyfile` and a real `.env` file
 * (`.env`, `.env.*`, `*.env`), in any letter case; a name ending in `.example`, `.sample` or `.template` is not refused
 * for its name and is read by the content rules. Returns findings { rule, kind: 'path', entry }.
 */
export const scanHostingFiles = createFileRule(HOSTING_RULE_ID, (entry, add) => {
  const { directories, name } = lowerCaseParts(entry.path);
  if (directories.includes(HOSTING_DIRECTORY) || isHostingFileName(name)) add({ kind: 'path', entry });
});

const startsWith = (bytes, magic, offset = 0) => bytes.subarray(offset, offset + magic.length).equals(magic);

/**
 * Whether `bytes` hold a zip end-of-central-directory record in their last 64 KiB plus the record: the 4-byte signature, 18
 * more bytes, and a comment length that fits in what follows. Zip readers find the archive from this record, so a stub
 * before the first header does not hide it.
 */
function hasZipEndRecord(bytes) {
  const last = bytes.length - ZIP_END_RECORD_BYTES;
  for (let offset = last; offset >= 0 && offset >= last - ZIP_MAX_COMMENT_BYTES; offset -= 1) {
    if (startsWith(bytes, ZIP_END_MAGIC, offset) && bytes.readUInt16LE(offset + ZIP_COMMENT_LENGTH_OFFSET) <= last - offset) return true;
  }
  return false;
}

/** Whether `bytes` begin as a gzip stream or a zip archive, hold the `ustar` mark of a tar header, or end as a zip archive. */
const hasArchiveSignature = (bytes) => startsWith(bytes, GZIP_MAGIC) || ZIP_MAGICS.some((magic) => startsWith(bytes, magic)) || startsWith(bytes, TAR_MAGIC, TAR_MAGIC_OFFSET) || hasZipEndRecord(bytes);

/**
 * R-ARCHIVE: refuses every blob that holds a tar, gzip or zip signature, whatever its name or its binary classification,
 * and any path under a `vendor` directory. Returns findings { rule, kind: 'path' | 'content', entry }.
 */
export const scanArchives = createFileRule(ARCHIVE_RULE_ID, (entry, add) => {
  if (lowerCaseParts(entry.path).directories.includes(VENDOR_DIRECTORY)) add({ kind: 'path', entry });
  if (entry.bytes && hasArchiveSignature(entry.bytes)) add({ kind: 'content', entry });
});
