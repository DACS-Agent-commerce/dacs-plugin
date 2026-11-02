import { GateInputError } from './objects.mjs';
import { textOf } from './rules-address.mjs';

/** Id of the env-template rule in reports. */
export const ENV_RULE_ID = 'R-ENV';
/** Id of the hosting-file rule in reports. */
export const HOSTING_RULE_ID = 'R-HOSTING';
/** Id of the archive rule in reports. */
export const ARCHIVE_RULE_ID = 'R-ARCHIVE';

const LINE_BREAK = /\r\n|\r|\n/;
const TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template']);
/** Last name segments that make `<name>.service.<segment>` a source file rather than a systemd unit. */
const SOURCE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const HOSTING_DIRECTORY = 'deploy';
const VENDOR_DIRECTORY = 'vendor';

const ASSIGNMENT = /^(?:export\s+)?(?<key>[A-Za-z_][\w.-]*)=(?<value>.*)$/;
/** A commented assignment in any form a reader would take for one: `#KEY=v`, `## KEY = v`, `# export KEY=v`, `#KEY: v`. */
const COMMENTED_ASSIGNMENT = /^#+\s*(?:export\s+)?(?<key>[A-Za-z_][\w.-]*)\s*[=:]\s*(?<value>.*)$/;
/** Carried prose comments of `http-mcp/.env.example` that would otherwise read as `KEY: value`; matched as whole lines. */
const CARRIED_PROSE = new Set([
  '# Authorization: builtin (wallet-login OAuth 2.1 server at /oauth) or external.',
  '# builtin: comma-separated random secrets, >= 32 chars each, for OAuth cookies.',
  "# external: your identity provider's exact issuer identifier.",
]);
const QUOTED_VALUE = /^(?<quote>["'])(?<inner>.*)\k<quote>$/;
/** A placeholder label: lower-case letters and dashes, no digits, so a real value cannot pass as one. */
const LABEL = '[a-z][a-z-]*';
/** The closed set of placeholders: `REPLACE_ME`, `CHANGE_ME`, a run of x, `${NAME}`, `<label>` and `your-<label>-here`. */
const PLACEHOLDER = new RegExp(`^(?:REPLACE_ME|CHANGE_ME|[xX]{3,}|\\$\\{[A-Za-z_]\\w*\\}|<${LABEL}>|your-${LABEL}-here)$`);
const PORT_PLACEHOLDER = new RegExp(`:<${LABEL}>$`);
const PLACEHOLDER_PORT = ':1';
const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/;
const HOST_NAME = /^[a-z\d-]+(?:\.[a-z\d-]+)+$/;
const ABSOLUTE_PATH = /^(?:\/[\w.-]+)+$/;
const SETTING_LABEL = new RegExp(`^${LABEL}$`);
const WEB_PROTOCOLS = ['http:', 'https:'];

const isFlag = (value) => value === '0' || value === '1';
const oneOf = (...choices) => (value) => choices.includes(value);
const integerIn = (min, max) => (value) => WHOLE_NUMBER.test(value) && Number(value) >= min && Number(value) <= max;
const listOf = (isItem) => (value) => value.split(',').every(isItem);
const isHost = (value) => HOST_NAME.test(value);
const isAbsolutePath = (value) => ABSOLUTE_PATH.test(value);
const isLabel = (value) => SETTING_LABEL.test(value);

/** Whether `value` is an http(s) origin, optionally with one trailing `/`, and nothing else: no credentials, path, query or fragment. A `<label>` port counts as a port. */
function isOrigin(value) {
  const candidate = value.replace(PORT_PLACEHOLDER, PLACEHOLDER_PORT);
  if (!URL.canParse(candidate)) return false;
  const { protocol, origin } = new URL(candidate);
  return WEB_PROTOCOLS.includes(protocol) && (candidate === origin || candidate === `${origin}/`);
}

/** The public settings of `http-mcp/.env.example`, each with the only values it may hold; ranges and choices are those `http-mcp/src/config.mjs` accepts. */
const PUBLIC_SETTINGS = new Map([
  ['DACS_PUBLIC_ORIGIN', isOrigin], ['HOST', isHost], ['PORT', integerIn(0, 65535)], ['DACS_TRUST_PROXY', isFlag],
  ['DACS_ALLOW_INSECURE_LOCALHOST', isFlag], ['DACS_DATA_DIR', isAbsolutePath],
  ['DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT', integerIn(1, 1000)], ['DACS_MAX_UNPAID_PURCHASES_PER_WALLET', integerIn(1, 1000)],
  ['DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR', integerIn(1, 100000)], ['DACS_AUTH_MODE', oneOf('builtin', 'external')],
  ['DACS_ACCESS_TOKEN_TTL_SECONDS', integerIn(60, 3600)], ['DACS_ALLOWED_REDIRECT_ORIGINS', listOf(isOrigin)],
  ['DACS_CIMD_ALLOWED_HOSTS', listOf(isHost)], ['DACS_OAUTH_ISSUER', isOrigin], ['DACS_OAUTH_JWKS_URI', isOrigin],
  ['DACS_OAUTH_SCOPE_CLAIM', isLabel], ['DACS_OAUTH_REQUIRE_AT_JWT', isFlag], ['DACS_DIRECTORY_ORIGIN', isOrigin],
  ['DACS_CHAIN_RPC_URL', isOrigin], ['DACS_CHAIN_NETWORK', isLabel], ['DACS_DEM_AMOUNT_ENCODING', oneOf('os-string', 'dem-number')],
  ['DACS_IDENTITY_WRITES', oneOf('held', 'simulated-fixture-only')], ['DACS_EMBEDDED_WALLET_WRITES', oneOf('off', 'simulated-loopback', 'testnet-held')],
  ['DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN', isOrigin], ['DACS_RATE_LIMIT_PER_MINUTE', integerIn(10, 100000)],
  ['DACS_LOG_LEVEL', oneOf('debug', 'info', 'warn', 'error', 'silent')],
]);

const TAR_BLOCK_BYTES = 512;
const TAR_CHECKSUM_START = 148;
const TAR_CHECKSUM_END = 156;
const TAR_CHECKSUM_FIELD = /^ *(?<octal>[0-7]+)[ \0]*$/;
const SPACE = 0x20;
const SIGNED_BYTE_LIMIT = 0x80;
const BYTE_VALUES = 0x100;
/** The zip signatures of a central directory header, a local file header, an end record and a data descriptor. */
const ZIP_SIGNATURES = [[0x01, 0x02], [0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].map((tail) => Buffer.from([0x50, 0x4b, ...tail]));

/**
 * The lower-case directory segments of `file`, and its lower-case name split on `.` with one trailing `example`, `sample` or
 * `template` segment taken off (`template` says whether it was). Linear in the length of the path.
 */
function pathParts(file) {
  const segments = file.toLowerCase().split('/');
  const words = segments.at(-1).split('.');
  const template = words.length > 1 && TEMPLATE_SUFFIXES.has(words.at(-1));
  return { directories: segments.slice(0, -1), words: template ? words.slice(0, -1) : words, template };
}

/** Whether a name segment after the first is `segment`: `.env` and `prod.env` have one, `env.mjs` does not. */
const hasLaterSegment = (words, segment) => words.indexOf(segment, 1) !== -1;

const isEnvTemplate = ({ words, template }) => template && words.includes('env');

/** A deploy path, a Caddyfile, a systemd unit (`*.service`, `*.service.<backup>`) or a real env file, template names included except env templates. */
function isHostingFile({ directories, words, template }) {
  return directories.includes(HOSTING_DIRECTORY) || words.includes('caddyfile')
    || (hasLaterSegment(words, 'service') && !SOURCE_EXTENSIONS.has(words.at(-1)))
    || (!template && hasLaterSegment(words, 'env'));
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

const unquoted = (value) => QUOTED_VALUE.exec(value)?.groups.inner ?? value;

/** The `{ key, value }` of an env line (a commented assignment counts), null for a blank or prose comment line, or `{ key: null }` for any other line. */
function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || CARRIED_PROSE.has(trimmed)) return null;
  const comment = trimmed.startsWith('#');
  const match = (comment ? COMMENTED_ASSIGNMENT : ASSIGNMENT).exec(trimmed);
  if (match) return { key: match.groups.key, value: unquoted(match.groups.value.trim()) };
  return comment ? null : { key: null };
}

/** Whether an assignment is refused: a listed public setting must be empty or pass its check; any other key must be empty or a placeholder. */
function isRefusedEnvAssignment({ key, value }) {
  if (key === null) return true;
  if (value === '') return false;
  const isAllowed = PUBLIC_SETTINGS.get(key) ?? ((candidate) => PLACEHOLDER.test(candidate));
  return !isAllowed(value);
}

/**
 * R-ENV: in every env template (a name with an `env` segment ending in `.example`, `.sample` or `.template`), refuses a line
 * that is neither blank, a prose comment nor an assignment, and an assignment (commented or not) whose value its key does
 * not allow. A template that is not readable text is refused whole. Returns findings { rule, kind: 'content', entry, line? }.
 */
export const scanEnvTemplates = createFileRule(ENV_RULE_ID, (entry, add) => {
  if (!isEnvTemplate(pathParts(entry.path))) return;
  const text = textOf(entry);
  if (text === null) {
    add({ kind: 'content', entry });
    return;
  }
  text.split(LINE_BREAK).forEach((line, index) => {
    const assignment = parseEnvLine(line);
    if (assignment !== null && isRefusedEnvAssignment(assignment)) add({ kind: 'content', entry, line: index + 1 });
  });
});

/**
 * R-HOSTING: refuses by path, in any letter case, anything under a `deploy` directory, a Caddyfile (`caddyfile` as any name
 * segment), a systemd unit (a `service` segment unless the name ends in a source extension) and a real env file (an `env`
 * segment after the first, `config.env.json` included). Template names get the same tests, except env templates, which
 * R-ENV reads. Returns findings { rule, kind: 'path', entry }.
 */
export const scanHostingFiles = createFileRule(HOSTING_RULE_ID, (entry, add) => {
  if (isHostingFile(pathParts(entry.path))) add({ kind: 'path', entry });
});

/** Whether `block` is a tar header: its checksum field holds the octal sum of the block, the field counted as spaces (unsigned or signed). */
function isTarHeader(block) {
  const field = TAR_CHECKSUM_FIELD.exec(block.toString('latin1', TAR_CHECKSUM_START, TAR_CHECKSUM_END));
  if (!field) return false;
  let unsigned = 0;
  let signed = 0;
  block.forEach((byte, index) => {
    const counted = index >= TAR_CHECKSUM_START && index < TAR_CHECKSUM_END ? SPACE : byte;
    unsigned += counted;
    signed += counted < SIGNED_BYTE_LIMIT ? counted : counted - BYTE_VALUES;
  });
  const checksum = parseInt(field.groups.octal, 8);
  return checksum === unsigned || checksum === signed;
}

/** Whether readable text still holds an archive: a zip signature anywhere, or a tar header in any 512-byte block (tar skips to the next valid header). */
function holdsArchive(bytes) {
  if (ZIP_SIGNATURES.some((signature) => bytes.includes(signature))) return true;
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= bytes.length; offset += TAR_BLOCK_BYTES) {
    if (isTarHeader(bytes.subarray(offset, offset + TAR_BLOCK_BYTES))) return true;
  }
  return false;
}

/**
 * R-ARCHIVE: the gate must be able to read every blob. Refuses a blob that is not readable text (a NUL byte or invalid UTF-8),
 * even with a `binaryDispositions` entry, and text holding a zip signature or a tar header, whatever its name; and any path
 * under a `vendor` directory, in any letter case. It does not find encoded or script-generated payloads. Returns findings
 * { rule, kind: 'path' | 'content', entry }.
 */
export const scanArchives = createFileRule(ARCHIVE_RULE_ID, (entry, add) => {
  if (pathParts(entry.path).directories.includes(VENDOR_DIRECTORY)) add({ kind: 'path', entry });
  if (entry.bytes && (textOf(entry) === null || holdsArchive(entry.bytes))) add({ kind: 'content', entry });
});
