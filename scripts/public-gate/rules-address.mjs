import { createHash } from 'node:crypto';
import path from 'node:path';
import { decodeUtf8Strict, FULL_OBJECT_ID, GateInputError } from './objects.mjs';

/** Id of the host rule in reports. */
export const HOST_RULE_ID = 'R-HOST';
/** Id of the account rule in reports. */
export const ACCOUNT_RULE_ID = 'R-ACCOUNT';
/** Id of the IP-literal rule in reports. */
export const IP_RULE_ID = 'R-IP';

/** How an address occurs: in a URL, as host:port, as a quoted name in code, as a bare name in prose or data, or as an email. */
const CONTEXTS = ['url', 'host-port', 'quoted', 'bare', 'email'];
/** Names that never reach a real machine: RFC 2606 and 6761 reserved top-level names and the example domains with every subdomain. */
const RESERVED_TOP_LEVEL_NAMES = ['invalid', 'test', 'example', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];
const SSH_USER = 'git';
/** The file that holds the allow-list: it names every reviewed value, so a value of a scoped entry may appear in it. */
const CONFIG_PATH = 'public-gate.config.json';
const CODE_EXTENSIONS = ['.cjs', '.css', '.js', '.mjs', '.mts', '.sh', '.ts', '.tsx'];
/**
 * A quoted, bare or host:port name is read as a host only under one of these top-level names, so a file name
 * (`state.sqlite`) or a property chain (`json.stringify`) is not; a URL host is read under any top-level name. `app`
 * and `network` are left out: in this code base they end property chains (`chrome.app`, `receipt.price.network`).
 */
const HOST_TOP_LEVEL_NAMES = new Set(['com', 'org', 'net', 'io', 'dev', 'ai', 'xyz', 'co', 'me', 'cloud', 'tech', 'online', 'site',
  'info', 'biz', 'us', 'uk', 'de', 'eu', 'fr', 'nl', 'ch', 'se', 'cn', 'jp', 'kr', 'ru', 'in', 'br', 'ca', 'au']);
const LINE_BREAK = /\r\n|\r|\n/;
/** A dotted name within DNS limits (labels of at most 63 characters, at most 127 of them): bounded so a long dotted line cannot exhaust the regex stack. */
const NAME_LABELS = String.raw`(?:[a-z0-9_-]{1,63}\.){1,127}[a-z]{2,63}`;
const URL_HOST = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/(?:[^\s/\\?#@]*@)?(?<host>\[[^\]\s]*\]|[^\s/?#:@"'<>)\]\\,;`]+)/gi;
const HOST_PORT = new RegExp(String.raw`(?<![\w.@/:-])(?<host>${NAME_LABELS}):\d{1,5}(?!\w)`, 'gi');
const BARE_NAME = new RegExp(String.raw`(?<![\w.@/:-])(?<host>${NAME_LABELS})(?![\w-]|\.[a-z0-9_-]|@)`, 'gi');
const QUOTED_NAME = new RegExp(String.raw`(?<quote>['"\`])(?<host>${NAME_LABELS})\k<quote>`, 'gi');
const EMAIL = new RegExp(String.raw`(?<![\w.%+-])(?<user>[a-z0-9_.%+-]+)@(?<domain>${NAME_LABELS}|localhost)(?![\w-])`, 'gi');
/**
 * An email whose domain is one label (a machine or mail-system name): read only when no single `/` precedes the user
 * (`actions/checkout@v4`, `@scope/pkg@1`; the `//` before URL userinfo does not count) and the label
 * starts with a letter (`name@1.2.3`).
 */
const DOTLESS_EMAIL = /(?<![\w.%+-])(?<!(?<!\/)\/)(?<user>[a-z0-9_.%+-]+)@(?<domain>[a-z][a-z0-9_-]{0,62})(?![\w-]|\.[a-z0-9_-]|@)/gi;
/** A host this rule leaves to others: a template placeholder, a relative path (`..`) or an IP literal in digits and dots (the IP rule). */
const NOT_A_NAME = /[${}%<>*]|^\[|^\.|^[\d.]+$/;
const IDENTITY = /^[^<>]+ <[^<>\s]+>$/;

const isText = (value) => typeof value === 'string' && value !== '';
const isLowerText = (value) => isText(value) && value === value.toLowerCase();

/**
 * Whether the allow-list sections of `config` are well formed: `allowedHosts` ([{ value, reason }], values lower case),
 * `scopedAllowances` ([{ path, rule, value, context, reason }] for one path, rule, lower-case value and context) and
 * `publicIdentities` (strings of the form `Name <email>`).
 */
export function hasValidAddressConfig(config) {
  const list = (entries, valid) => Array.isArray(entries) && entries.every((entry) => entry !== null && typeof entry === 'object' && valid(entry));
  return list(config.allowedHosts, (entry) => isLowerText(entry.value) && isText(entry.reason))
    && list(config.scopedAllowances, (entry) => isText(entry.path) && [HOST_RULE_ID, ACCOUNT_RULE_ID].includes(entry.rule)
      && isLowerText(entry.value) && CONTEXTS.includes(entry.context) && isText(entry.reason))
    && Array.isArray(config.publicIdentities) && config.publicIdentities.every((identity) => typeof identity === 'string' && IDENTITY.test(identity));
}

const topLevelName = (name) => name.slice(name.lastIndexOf('.') + 1);

function isReservedName(name) {
  return RESERVED_TOP_LEVEL_NAMES.includes(topLevelName(name)) || RESERVED_DOMAINS.some((reserved) => name === reserved || name.endsWith(`.${reserved}`));
}

/** The matches of `pattern` in `text` as { value, context, user, next }: the lower-case name `valueOf` reads from the groups, the lower-case email user if any, and the character after the match. */
function matchesOf(pattern, context, text, valueOf) {
  return [...text.matchAll(pattern)].map((match) => ({
    value: valueOf(match.groups).toLowerCase(), context, user: match.groups.user?.toLowerCase(), next: text[match.index + match[0].length],
  }));
}

/**
 * Every dotted name in one line that reads as a host and is neither reserved nor listed, as { value, context }: the forms
 * read depend on whether the file is code. A name with no dot is no public host; the private list covers machine labels.
 */
function unlistedHostsIn(line, { code, listedHosts }) {
  const forms = [['url', URL_HOST], ['host-port', HOST_PORT], code ? ['quoted', QUOTED_NAME] : ['bare', BARE_NAME]];
  return forms.flatMap(([context, pattern]) => matchesOf(pattern, context, line, ({ host }) => host.replace(/\.$/, '')))
    .filter(({ value, context }) => value.includes('.') && !NOT_A_NAME.test(value) && (context === 'url' || HOST_TOP_LEVEL_NAMES.has(topLevelName(value)))
      && !isReservedName(value) && !listedHosts.has(value));
}

const emailsIn = (text) => [EMAIL, DOTLESS_EMAIL].flatMap((pattern) => matchesOf(pattern, 'email', text, ({ user, domain }) => `${user}@${domain}`));

/** Whether an email needs no entry: a reserved domain, or the SSH form (`git@` then the host, then `:` or `/`) of a listed host. */
function isPermittedEmail({ value, user, next }, listedHosts) {
  const domain = value.slice(value.lastIndexOf('@') + 1);
  return isReservedName(domain) || (user === SSH_USER && (next === ':' || next === '/') && listedHosts.has(domain));
}

const accountsIn = (line, { listedHosts }) => emailsIn(line).filter((email) => !isPermittedEmail(email, listedHosts));

/** The emails in commit-metadata `text` that the account rule refuses: those not part of an exact `publicIdentities` entry and not permitted as in content. */
export function refusedMetadataEmails(text, config) {
  const identityEmails = new Set(config.publicIdentities.map((identity) => identity.slice(identity.lastIndexOf('<') + 1, -1).toLowerCase()));
  const listedHosts = new Set(config.allowedHosts.map(({ value }) => value));
  const refused = viewsOf(text).flatMap(emailsIn).filter((email) => !identityEmails.has(email.value) && !isPermittedEmail(email, listedHosts));
  return [...new Set(refused.map(({ value }) => value))];
}

/**
 * The hosts in commit-metadata `text` that the host rule refuses: those it refuses in non-code text (URL, host:port and bare
 * forms), as in content. Commit metadata has no path, so no `scopedAllowances` entry applies; only `allowedHosts` and reserved names pass.
 */
export function refusedMetadataHosts(text, config) {
  const listedHosts = new Set(config.allowedHosts.map(({ value }) => value));
  return [...new Set(viewsOf(text).flatMap((view) => unlistedHostsIn(view, { code: false, listedHosts })).map(({ value }) => value))];
}

/** A file's text, or null for a blob that is not valid UTF-8 text (a reviewed binary is not read as text). */
export const textOf = (entry) => (entry.bytes && !entry.bytes.includes(0) ? decodeUtf8Strict(entry.bytes) : null);

/** A backslash escaping a URL or email delimiter (`\/`, `\@`, `\:`), as JSON and JavaScript strings write them. `\n`, `\t` and `\.` stay: they are control characters and regex syntax. */
const ESCAPED_DELIMITER = /\\([/@:])/g;

/** A line as written, and with its escaped delimiters unescaped when it has any, so `https:\/\/host\/x` reads as the URL it decodes to. */
export function viewsOf(line) {
  const unescaped = line.replace(ESCAPED_DELIMITER, '$1');
  return unescaped === line ? [line] : [line, unescaped];
}

/**
 * The test of `scopedAllowances` for a rule: an occurrence passes when an entry holds this exact path, rule, value and
 * context; in the configuration file itself, also when the value is one that an entry names.
 */
function scopedAllowanceCheck(config, ruleId) {
  const allowances = new Set(config.scopedAllowances.map((entry) => [entry.path, entry.rule, entry.value, entry.context].join('\0')));
  const reviewedValues = new Set(config.scopedAllowances.map((entry) => entry.value));
  return (entry, { value, context }) => allowances.has([entry.path, ruleId, value, context].join('\0')) || (entry.path === CONFIG_PATH && reviewedValues.has(value));
}

/**
 * Builds a rule that reads the address occurrences `occurrencesIn(view, { code, listedHosts })` of every path and text blob, each line as written
 * and with its escaped delimiters unescaped, and returns findings { rule, kind: 'path' | 'content', entry, line? }, one per line. An occurrence passes when
 * `allowanceCheck(config, ruleId)(entry, occurrence, line)` says so (`line` is null in a path name); by default that is `scopedAllowanceCheck`.
 * Throws GateInputError(limit:maxReportEntries) past that many findings.
 */
function createAddressRule(ruleId, occurrencesIn, allowanceCheck = scopedAllowanceCheck) {
  return function scan({ entries, config, limits }) {
    const listedHosts = new Set(config.allowedHosts.map(({ value }) => value));
    const isAllowed = allowanceCheck(config, ruleId);
    const findings = [];
    const refusedLines = (lines, entry, code, lineOf = (index) => index + 1) => lines.flatMap((text, index) => (viewsOf(text)
      .some((view) => occurrencesIn(view, { code, listedHosts }).some((occurrence) => !isAllowed(entry, occurrence, lineOf(index)))) ? [index + 1] : []));
    const add = (finding) => {
      findings.push({ rule: ruleId, ...finding });
      if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
    };
    for (const entry of entries.filter((candidate) => candidate.path !== null)) {
      const extension = path.posix.extname(entry.path).toLowerCase();
      const code = CODE_EXTENSIONS.includes(extension);
      const pathName = config.textExtensions.includes(extension) ? entry.path.slice(0, -extension.length) : entry.path;
      if (pathName.split('/').some((segment) => refusedLines([segment], entry, false, () => null).length > 0)) add({ kind: 'path', entry });
      const text = textOf(entry);
      if (text !== null) for (const line of refusedLines(text.split(LINE_BREAK), entry, code)) add({ kind: 'content', entry, line });
    }
    return findings;
  };
}

/**
 * R-HOST: refuses a host with no exact entry in `config.allowedHosts` (reserved names pass): in URL and host:port form
 * everywhere, as a quoted name in code, and as a bare name in other text, in every path and text blob. A subdomain of a
 * listed host is a different host.
 */
export const scanHosts = createAddressRule(HOST_RULE_ID, unlistedHostsIn);

/** R-ACCOUNT: refuses an email outside reserved domains in every path and text blob; the SSH form of a listed host passes. */
export const scanAccounts = createAddressRule(ACCOUNT_RULE_ID, accountsIn);

/** How many characters on each side of an address belong to the context of a disposition (fewer at the edge of a line). */
const DISPOSITION_CONTEXT_WIDTH = 3;
/** Stands for the address in a disposition's context: `O("<ip>","` is an address between `O("` and `","`. */
const ADDRESS_MARKER = '<ip>';
const IPV6_GROUP_COUNT = 8;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
const IPV4_DOCUMENTATION_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];
/** Four dotted numbers, not inside a longer dotted number and not after a letter or digit (`v1.2.3.4`); an underscore, or a dot after a name, bounds one on the left, and an underscore or a letter on the right. */
const IPV4_LITERAL = /(?<![A-Za-z\d])(?<!\d\.)\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)/g;
/**
 * Up to eight groups of hex digits between colons, the last perhaps a dotted IPv4 tail (the colon units are counted to eight so `::` may
 * stand for one group at either end, after seven written groups); a colon before a letter, digit or colon does not end an address. An underscore bounds it on the left.
 */
const IPV6_LITERAL = /(?<![A-Za-z\d:.])(?:[0-9a-f]{0,4}:){2,8}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?!\w|:[\w:]|\.\d)/gi;
/**
 * A `label:` (a name that starts with a letter or `_`) directly before a hex group and colon, or before `::` and a hex group, as in
 * `ip:<IPv6 literal>` (the literal may start with `::`), and the `\n`, `\r` and `\t` escapes of a string. A bare `::` after a label is a scope (`std::vector`), not blanked.
 */
const LABEL_COLON_OR_ESCAPE = /(?<![\w.:-])([A-Za-z_][\w.-]*):(?=[0-9a-f]{1,4}:|::[0-9a-f]{1,4}\b)|\\[nrt]/gi;

/** The four octets of a dotted IPv4 literal, or null when one is above 255. */
function parseIpv4(literal) {
  const octets = literal.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 literal (`::` expanded, a dotted tail read as two groups), or null when it is not one. */
function parseIpv6(literal) {
  const halves = literal.split('::');
  if (halves.length > 2) return null;
  const [head, tail = []] = halves.map((half) => (half === '' ? [] : half.split(':')));
  const trailing = halves.length === 2 ? tail : head;
  if (trailing.at(-1)?.includes('.')) {
    const octets = parseIpv4(trailing.pop());
    if (octets === null) return null;
    trailing.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
  }
  const gap = IPV6_GROUP_COUNT - head.length - tail.length;
  if (![...head, ...tail].every((group) => HEX_GROUP.test(group)) || (halves.length === 2 ? gap < 1 : gap !== 0)) return null;
  return [...head, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...tail].map((group) => parseInt(group, 16));
}

/** Loopback (`127.` as written), the unspecified address and the documentation ranges of RFC 5737. */
const isPermittedIpv4 = (literal) => literal.startsWith('127.') || literal === '0.0.0.0' || IPV4_DOCUMENTATION_PREFIXES.some((prefix) => literal.startsWith(prefix));

/** Loopback and unspecified as written (`::1`, `::`: the expanded and mapped forms are not these classes) and the documentation range `2001:db8::/32`. */
const isPermittedIpv6 = (literal, groups) => literal === '::1' || literal === '::' || (groups[0] === 0x2001 && groups[1] === 0xdb8);

/** A literal that ends in a single colon (`::1:` in prose) without that colon. */
const withoutTrailingColon = (literal) => (literal.endsWith(':') && !literal.endsWith('::') ? literal.slice(0, -1) : literal);

/** The literal at `index` of length `length` as the text around it: `DISPOSITION_CONTEXT_WIDTH` characters, the marker, and as many after. */
const contextAround = (line, index, length) => line.slice(Math.max(0, index - DISPOSITION_CONTEXT_WIDTH), index) + ADDRESS_MARKER
  + line.slice(index + length, index + length + DISPOSITION_CONTEXT_WIDTH);

/** The line with each label colon and each `\n`, `\r` or `\t` escape in it blanked out, same length, so an address after them is bounded by a space. */
const withBoundariesBlanked = (line) => line.replace(LABEL_COLON_OR_ESCAPE, (match, label) => (label === undefined ? '  ' : `${label} `));

/** Every IP literal in one view of a line, as { index, value, permitted }; the IPv4 tail of an IPv6 literal belongs to it and is not read again. */
function addressesInView(line) {
  const sixes = [];
  for (const match of line.matchAll(IPV6_LITERAL)) {
    const value = withoutTrailingColon(match[0]).toLowerCase();
    const groups = parseIpv6(value);
    if (groups !== null) sixes.push({ index: match.index, value, permitted: isPermittedIpv6(value, groups) });
  }
  let outsideSixes = '';
  let end = 0;
  for (const { index, value } of sixes) {
    outsideSixes += line.slice(end, index) + ' '.repeat(value.length);
    end = index + value.length;
  }
  outsideSixes += line.slice(end);
  const fours = [...outsideSixes.matchAll(IPV4_LITERAL)].filter((match) => parseIpv4(match[0]) !== null)
    .map((match) => ({ index: match.index, value: match[0], permitted: isPermittedIpv4(match[0]) }));
  return [...sixes, ...fours];
}

/** Every IP literal in one line outside the permitted classes, as { value, context }, found in the line and in the line with its label colons and escapes blanked out. */
function unpermittedAddressesIn(line) {
  const blanked = withBoundariesBlanked(line);
  const found = new Map([...addressesInView(line), ...(blanked === line ? [] : addressesInView(blanked))].filter(({ permitted }) => !permitted)
    .map(({ index, value }) => [`${index}:${value}`, { value, context: contextAround(line, index, value.length) }]));
  return [...found.values()];
}

/** The test of `ipDispositions`: an occurrence in file content passes only when its path, blob id, line, context and the value's SHA-256 all match one entry. */
function dispositionCheck(config) {
  const reviewed = new Set(config.ipDispositions.map((entry) => [entry.path, entry.blob, entry.line, entry.context, entry.sha256].join('\0')));
  return (entry, { value, context }, line) => line !== null && reviewed.has([entry.path, entry.oid, line, context, createHash('sha256').update(value).digest('hex')].join('\0'));
}

/**
 * Whether `config.ipDispositions` is well formed: a list of { path, blob (a full object id), line (a positive integer), context
 * (text around the address holding `<ip>`), sha256 (of the address as written, lower case), reason }.
 */
export function hasValidIpDispositions(config) {
  return Array.isArray(config.ipDispositions) && config.ipDispositions.every((entry) => entry !== null && typeof entry === 'object'
    && isText(entry.path) && FULL_OBJECT_ID.test(entry.blob) && Number.isSafeInteger(entry.line) && entry.line > 0
    && isText(entry.context) && entry.context.includes(ADDRESS_MARKER) && /^[0-9a-f]{64}$/.test(entry.sha256) && isText(entry.reason));
}

/**
 * R-IP: refuses every IPv4 and IPv6 literal in every path and text blob except loopback (`127.0.0.0/8`, `::1`), unspecified
 * (`0.0.0.0`, `::`) and documentation addresses; any other literal, a mapped or expanded form included, passes only through
 * an exact `ipDispositions` entry for its own path, blob, line, context and value. Needs `config.ipDispositions`.
 */
export const scanIps = createAddressRule(IP_RULE_ID, unpermittedAddressesIn, dispositionCheck);

/** The IP literals in commit-metadata `text` outside the permitted classes. Commit metadata has no path or blob, so no `ipDispositions` entry can pass one. */
export function refusedMetadataIps(text) {
  return [...new Set(viewsOf(text).flatMap(unpermittedAddressesIn).map(({ value }) => value))];
}
