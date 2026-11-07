import { spawn } from 'node:child_process';

/** A full object id (SHA-1 or SHA-256 repository); abbreviations and ref names are never accepted. */
export const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const LISTING_HEADER = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64}) +(\d+|-)$/;
const KIND_BY_MODE = { 120000: 'symlink', 160000: 'submodule' };
const BATCH_RECORD_SLACK_BYTES = 130;
const SMALL_REPLY_BYTES = 256;
const MAX_TAG_CHAIN = 16;
const TAG_OBJECT_LINE = /^object ([0-9a-f]{40,64})\n/;
const STDERR_CAPTURE_CHARS = 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A refusal to continue; `cause` names why: timeout, interrupted, output-limit, git-refused, unknown-commit, limit:<name>, ... */
export class GateInputError extends Error {
  constructor(cause, message) {
    super(message);
    this.name = 'GateInputError';
    this.cause = cause;
  }
}

/** Decodes `bytes` as UTF-8 keeping a leading byte-order mark; returns null when they are not valid UTF-8. */
export function decodeUtf8Strict(bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function abortCause(error, { reason }) {
  if (reason instanceof GateInputError) return reason;
  if (reason?.name === 'TimeoutError') return new GateInputError('timeout', 'git did not finish before its deadline');
  return new GateInputError('git-unavailable', `git could not run (${error.code ?? error.name})`);
}

/** The environment of every git run: the caller's, without any GIT_ variable, so git finds the repository from `--repo` alone. */
export function gitEnvironment() {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
  return { ...Object.fromEntries(inherited), GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

/** Runs git with a byte cap and a deadline; resolves { status, stdout, stderr } whatever the exit status. */
function runGit({ repo, args, input, maxBytes, limits, signal }) {
  return new Promise((resolve, reject) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(limits.gitDeadlineMs)]);
    const child = spawn('git', ['-C', repo, ...args], { env: gitEnvironment(), signal: bounded });
    const chunks = [];
    let received = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received <= maxBytes) return chunks.push(chunk);
      child.kill('SIGKILL');
      return reject(new GateInputError('output-limit', `git ${args[0]} produced more than ${maxBytes} bytes`));
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(0, STDERR_CAPTURE_CHARS); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => reject(abortCause(error, bounded)));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(chunks), stderr }));
    child.stdin.end(input);
  });
}

const refused = ({ args }, { status, stderr }) => new GateInputError('git-refused', `git ${args[0]} exited ${status}: ${stderr.trim()}`);

async function git(options) {
  const result = await runGit(options);
  if (result.status !== 0) throw refused(options, result);
  return result.stdout;
}

async function resolveTree(base, commit) {
  const small = { ...base, maxBytes: SMALL_REPLY_BYTES };
  const commitOptions = { ...small, args: ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`] };
  const found = await runGit(commitOptions);
  if (found.status === 1) throw new GateInputError('unknown-commit', 'the repository has no such commit');
  if (found.status !== 0) throw refused(commitOptions, found);
  if (found.stdout.toString().trim() !== commit) throw new GateInputError('not-a-commit', '--commit names an object that is not itself a commit');
  return (await git({ ...small, args: ['rev-parse', `${commit}^{tree}`] })).toString().trim();
}

function parseListing(listing, limits) {
  const entries = [];
  for (let start = 0; start < listing.length; start = listing.indexOf(0, start) + 1) {
    const end = listing.indexOf(0, start);
    const tab = listing.indexOf(9, start);
    const header = tab < 0 || tab > end ? null : LISTING_HEADER.exec(listing.toString('latin1', start, tab));
    if (!header) throw new GateInputError('malformed-listing', 'git ls-tree returned a record this gate cannot parse');
    if (entries.length >= limits.maxTreeObjects) throw new GateInputError('limit:maxTreeObjects', `the tree holds more than ${limits.maxTreeObjects} objects`);
    const [, mode, , oid, size] = header;
    const pathBytes = Buffer.from(listing.subarray(tab + 1, end));
    const path = decodeUtf8Strict(pathBytes);
    const kind = KIND_BY_MODE[mode] ?? 'blob';
    const problem = (path === null && 'invalid-utf8-path') || (kind === 'submodule' && 'submodule') || (Number(size) > limits.maxBlobBytes && 'limit:maxBlobBytes') || null;
    entries.push({ position: entries.length + 1, pathBytes, path, mode, kind, oid, size: Number(size), problem, bytes: null });
  }
  if (entries.length === 0) throw new GateInputError('empty-tree', 'the commit has no files');
  return entries;
}

function parseBatch(output, wanted) {
  const blobs = new Map();
  let offset = 0;
  for (const [oid, size] of wanted) {
    const lineEnd = output.indexOf(10, offset);
    const header = lineEnd < 0 ? '' : output.toString('latin1', offset, lineEnd);
    if (header.endsWith(' missing')) throw new GateInputError('missing-object', 'the repository is missing a blob its tree names');
    const end = lineEnd + 1 + size;
    if (header !== `${oid} blob ${size}` || output[end] !== 10) throw new GateInputError('malformed-batch', 'git cat-file returned an unexpected record');
    blobs.set(oid, output.subarray(lineEnd + 1, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new GateInputError('malformed-batch', 'git cat-file returned trailing bytes');
  return blobs;
}

async function readBlobs(base, entries) {
  const readable = entries.filter((entry) => !entry.problem);
  const pathBytesTotal = readable.reduce((sum, entry) => sum + entry.size, 0);
  if (pathBytesTotal > base.limits.maxTotalBlobBytes) throw new GateInputError('limit:maxTotalBlobBytes', `the blobs hold more than ${base.limits.maxTotalBlobBytes} bytes`);
  const wanted = new Map(readable.map((entry) => [entry.oid, entry.size]));
  if (wanted.size === 0) return new Map();
  const input = `${[...wanted.keys()].join('\n')}\n`;
  const distinctBytes = [...wanted.values()].reduce((sum, size) => sum + size, 0);
  return parseBatch(await git({ ...base, args: ['cat-file', '--batch'], input, maxBytes: distinctBytes + wanted.size * BATCH_RECORD_SLACK_BYTES }), wanted);
}

function parseCommits(output, rows, limits) {
  let offset = 0;
  return rows.map(([sha, ...parents]) => {
    const lineEnd = output.indexOf(10, offset);
    const header = /^([0-9a-f]{40,64}) commit (\d+)$/.exec(lineEnd < 0 ? '' : output.toString('latin1', offset, lineEnd));
    if (!header || header[1] !== sha) throw new GateInputError('malformed-batch', 'git cat-file returned an unexpected record');
    if (Number(header[2]) > limits.maxBlobBytes) throw new GateInputError('limit:maxBlobBytes', `a commit object is over ${limits.maxBlobBytes} bytes`);
    const end = lineEnd + 1 + Number(header[2]);
    if (output[end] !== 10) throw new GateInputError('malformed-batch', 'git cat-file returned an unexpected record');
    offset = end + 1;
    return { sha, parents, raw: output.subarray(lineEnd + 1, end) };
  });
}

/**
 * Reads the annotated tags that `object` (a ref name or object id) names, outermost first, through tags of tags down to the
 * first object that is not a tag. Returns [{ sha, raw }] with `raw` the tag object (headers, blank line, message); empty when
 * `object` is not a tag. Throws GateInputError for a chain over MAX_TAG_CHAIN tags, a tag without an object line, a limit, a
 * timeout, an interrupt or a git failure.
 */
async function readTagChain(base, object) {
  const tags = [];
  let named = object;
  for (;;) {
    const type = (await git({ ...base, maxBytes: SMALL_REPLY_BYTES, args: ['cat-file', '-t', named] })).toString().trim();
    if (type !== 'tag') return tags;
    if (tags.length === MAX_TAG_CHAIN) throw new GateInputError('limit:maxTagChain', `a tag names more than ${MAX_TAG_CHAIN} tags in a chain`);
    const sha = (await git({ ...base, maxBytes: SMALL_REPLY_BYTES, args: ['rev-parse', '--verify', named] })).toString().trim();
    const raw = await git({ ...base, maxBytes: base.limits.maxBlobBytes, args: ['cat-file', 'tag', sha] });
    const next = TAG_OBJECT_LINE.exec(raw.toString('latin1'));
    if (!next) throw new GateInputError('malformed-batch', 'git cat-file returned a tag without an object line');
    tags.push({ sha, raw });
    named = next[1];
  }
}

/**
 * Reads every commit reachable from `refs` (ref names or full object ids), parents before children, and every annotated tag
 * among the refs, through tags of tags. Returns { heads, commits, tags }: `heads` are the object ids of the commits the refs
 * name, `commits` are { sha, parents, raw } with `raw` the commit object (headers, blank line, message), `tags` are { sha, raw }
 * with `raw` the tag object in the same form. Throws GateInputError for an unusable ref, a limit, a timeout, an interrupt or a
 * malformed git reply.
 */
export async function readHistory({ repo, refs, limits, signal = new AbortController().signal }) {
  const base = { repo, limits, signal, maxBytes: SMALL_REPLY_BYTES };
  const heads = [];
  const tags = new Map();
  for (const ref of refs) {
    if (ref === '' || ref.startsWith('-')) throw new GateInputError('bad-ref', 'a ref must not be empty or start with a dash');
    const options = { ...base, args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] };
    const found = await runGit(options);
    if (found.status === 1) throw new GateInputError('unknown-ref', 'the repository has no commit for one of the refs');
    if (found.status !== 0) throw refused(options, found);
    heads.push(found.stdout.toString().trim());
    for (const tag of await readTagChain(base, ref)) tags.set(tag.sha, tag);
  }
  const listing = await git({ ...base, maxBytes: limits.maxListingBytes, args: ['rev-list', '--topo-order', '--reverse', '--parents', ...new Set(heads), '--'] });
  const rows = listing.toString('latin1').split('\n').filter(Boolean).map((line) => line.split(' '));
  if (rows.length > limits.maxHistoryCommits) throw new GateInputError('limit:maxHistoryCommits', `the history holds more than ${limits.maxHistoryCommits} commits`);
  const input = `${rows.map(([sha]) => sha).join('\n')}\n`;
  const output = await git({ ...base, maxBytes: limits.maxTotalBlobBytes, args: ['cat-file', '--batch'], input });
  return { heads: [...new Set(heads)].sort(), commits: parseCommits(output, rows, limits), tags: [...tags.values()] };
}

/** Throws GateInputError('unexpected-root') unless `commits` have exactly one root commit and it is `expectedRoot`. */
export function requireExpectedRoot(commits, expectedRoot) {
  const roots = commits.filter((commit) => commit.parents.length === 0).map((commit) => commit.sha);
  if (roots.length !== 1 || roots[0] !== expectedRoot) throw new GateInputError('unexpected-root', 'the history does not have the expected single root commit');
}

/**
 * Reads one commit from Git objects only. Returns { commit, tree, entries }; an entry is { position, pathBytes, path, mode,
 * kind, oid, size, problem, bytes } where `path` is null for a name that is not valid UTF-8, `problem` names why the blob
 * was not read, and a symlink's bytes are its link text. Throws GateInputError for an unknown commit, an empty tree, a
 * limit, a timeout, an interrupt or a malformed git reply.
 */
export async function readCommitObjects({ repo, commit, limits, signal = new AbortController().signal }) {
  const base = { repo, limits, signal, maxBytes: limits.maxListingBytes };
  const tree = await resolveTree(base, commit);
  const entries = parseListing(await git({ ...base, args: ['ls-tree', '-r', '-z', '--full-tree', '-l', tree] }), limits);
  const blobs = await readBlobs(base, entries);
  for (const entry of entries) if (!entry.problem) entry.bytes = blobs.get(entry.oid);
  return { commit, tree, entries };
}
