import { spawn } from 'node:child_process';

/** A full object id (SHA-1 or SHA-256 repository); abbreviations and ref names are never accepted. */
export const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const LISTING_HEADER = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64}) +(\d+|-)$/;
const KIND_BY_MODE = { 120000: 'symlink', 160000: 'submodule' };
const BATCH_RECORD_SLACK_BYTES = 130;
const SMALL_REPLY_BYTES = 256;
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

/** Runs git with a byte cap and a deadline; resolves { status, stdout, stderr } whatever the exit status. */
function runGit({ repo, args, input, maxBytes, limits, signal }) {
  return new Promise((resolve, reject) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(limits.gitDeadlineMs)]);
    const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
    const env = { ...Object.fromEntries(inherited), GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    const child = spawn('git', ['-C', repo, ...args], { env, signal: bounded });
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
  const wanted = new Map(entries.filter((entry) => !entry.problem).map((entry) => [entry.oid, entry.size]));
  const total = [...wanted.values()].reduce((sum, size) => sum + size, 0);
  if (total > base.limits.maxTotalBlobBytes) throw new GateInputError('limit:maxTotalBlobBytes', `the blobs hold more than ${base.limits.maxTotalBlobBytes} bytes`);
  if (wanted.size === 0) return new Map();
  const input = `${[...wanted.keys()].join('\n')}\n`;
  return parseBatch(await git({ ...base, args: ['cat-file', '--batch'], input, maxBytes: total + wanted.size * BATCH_RECORD_SLACK_BYTES }), wanted);
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
