import path from 'node:path';
import { decodeUtf8Strict, GateInputError } from './objects.mjs';

/** Id of the host rule in reports. */
export const HOST_RULE_ID = 'R-HOST';
/** Id of the account rule in reports. */
export const ACCOUNT_RULE_ID = 'R-ACCOUNT';

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

/** A file's text, or null for a blob that is not valid UTF-8 text (a reviewed binary is not read as text). */
const textOf = (entry) => (entry.bytes && !entry.bytes.includes(0) ? decodeUtf8Strict(entry.bytes) : null);

/** A backslash escaping a URL or email delimiter (`\/`, `\@`, `\:`), as JSON and JavaScript strings write them. `\n`, `\t` and `\.` stay: they are control characters and regex syntax. */
const ESCAPED_DELIMITER = /\\([/@:])/g;

/** A line as written, and with its escaped delimiters unescaped when it has any, so `https:\/\/host\/x` reads as the URL it decodes to. */
function viewsOf(line) {
  const unescaped = line.replace(ESCAPED_DELIMITER, '$1');
  return unescaped === line ? [line] : [line, unescaped];
}

/**
 * Builds a rule that reads the address occurrences `occurrencesIn(view, { code, listedHosts })` of every path and text blob, each line as written
 * and with its escaped delimiters unescaped, and returns findings { rule, kind: 'path' | 'content', entry, line? }, one per line. An occurrence passes when `config.scopedAllowances`
 * holds an entry for this exact path, rule, value and context; in the configuration file itself, also when the value is one
 * that an entry names. Throws GateInputError(limit:maxReportEntries) past that many findings.
 */
function createAddressRule(ruleId, occurrencesIn) {
  return function scan({ entries, config, limits }) {
    const listedHosts = new Set(config.allowedHosts.map(({ value }) => value));
    const allowances = new Set(config.scopedAllowances.map((entry) => [entry.path, entry.rule, entry.value, entry.context].join('\0')));
    const reviewedValues = new Set(config.scopedAllowances.map((entry) => entry.value));
    const isAllowed = (entry, { value, context }) => allowances.has([entry.path, ruleId, value, context].join('\0'))
      || (entry.path === CONFIG_PATH && reviewedValues.has(value));
    const findings = [];
    const refusedLines = (lines, entry, code) => lines.flatMap((text, index) => (viewsOf(text)
      .some((view) => occurrencesIn(view, { code, listedHosts }).some((occurrence) => !isAllowed(entry, occurrence))) ? [index + 1] : []));
    const add = (finding) => {
      findings.push({ rule: ruleId, ...finding });
      if (findings.length > limits.maxReportEntries) throw new GateInputError('limit:maxReportEntries', `more than ${limits.maxReportEntries} findings`);
    };
    for (const entry of entries.filter((candidate) => candidate.path !== null)) {
      const extension = path.posix.extname(entry.path).toLowerCase();
      const code = CODE_EXTENSIONS.includes(extension);
      const pathName = config.textExtensions.includes(extension) ? entry.path.slice(0, -extension.length) : entry.path;
      if (pathName.split('/').some((segment) => refusedLines([segment], entry, false).length > 0)) add({ kind: 'path', entry });
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
