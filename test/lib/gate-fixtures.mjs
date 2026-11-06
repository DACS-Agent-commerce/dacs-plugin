import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStubGitleaks } from './stub-gitleaks.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'public-gate', 'gate.mjs');
const HISTORY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'public-gate', 'history.mjs');
const CHECK_REPORT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'public-gate', 'check-report.mjs');
export const CONFIG_FILE = path.join(REPO_ROOT, 'public-gate.config.json');
export const ROOT_COMMIT = 'a'.repeat(40);

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function makeTempDir(label) {
  return mkdtempSync(path.join(tmpdir(), `gate-${label}-`));
}

export function git(dir, args, { input, env } = {}) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    input,
    env: { ...process.env, ...GIT_IDENTITY, ...env },
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString('utf8').trim();
}

/**
 * Builds a repository whose one commit holds exactly `entries`, using plumbing only, so path bytes
 * and modes are free and nothing is checked out. Each entry is { path: string | Buffer, content,
 * mode } with mode defaulting to 100644; mode 160000 makes a submodule whose content is its object id.
 */
export function createRepo(entries) {
  const dir = makeTempDir('repo');
  git(dir, ['init', '-q']);
  const records = entries.map((entry) => {
    const mode = entry.mode ?? '100644';
    const oid = mode === '160000'
      ? String(entry.content)
      : git(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(entry.content ?? '') });
    return Buffer.concat([Buffer.from(`${mode} ${oid}\t`), Buffer.from(entry.path), Buffer.from([0])]);
  });
  const indexFile = path.join(dir, 'fixture-index');
  const env = { GIT_INDEX_FILE: indexFile };
  git(dir, ['update-index', '--add', '-z', '--index-info'], { input: Buffer.concat(records), env });
  const tree = git(dir, ['write-tree'], { env });
  const commit = git(dir, ['commit-tree', tree, '-m', 'fixture'], { env });
  spawnSync('rm', ['-f', indexFile]);
  return { dir, commit, tree };
}

const PROJECT = { name: 'Project', email: 'project@example.invalid' };

/**
 * Builds a repository whose commits are `steps`, oldest first, using plumbing only. A step is { files, message, parents
 * (indexes of earlier steps, default the one before), author, committer ({ name, email }), tz }; `refs` maps a branch name
 * to a step index. A file's value is its content, or { content, mode } for another mode (120000 for a symlink).
 * Returns { dir, commits } with the object ids in step order.
 */
export function createHistory(steps, refs = { main: steps.length - 1 }) {
  const dir = makeTempDir('history');
  git(dir, ['init', '-q']);
  const commits = [];
  steps.forEach((step, index) => {
    const records = Object.entries(step.files ?? { 'a.txt': `step ${index}\n` }).map(([file, value]) => {
      const { content, mode } = value?.mode ? value : { content: value, mode: '100644' };
      const oid = git(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(content) });
      return Buffer.from(`${mode} ${oid}\t${file}\0`);
    });
    const env = { GIT_INDEX_FILE: path.join(dir, `fixture-index-${index}`) };
    git(dir, ['update-index', '--add', '-z', '--index-info'], { input: Buffer.concat(records), env });
    const tree = git(dir, ['write-tree'], { env });
    const [author, committer, tz] = [step.author ?? PROJECT, step.committer ?? PROJECT, step.tz ?? '+0000'];
    const identity = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: `1700000000 ${tz}`,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: `1700000000 ${tz}`,
    };
    const parents = (step.parents ?? (index === 0 ? [] : [index - 1])).flatMap((parent) => ['-p', commits[parent]]);
    commits.push(git(dir, ['commit-tree', tree, ...parents, '-m', step.message ?? `step ${index}`], { env: identity }));
  });
  for (const [name, index] of Object.entries(refs)) git(dir, ['update-ref', `refs/heads/${name}`, commits[index]]);
  return { dir, commits };
}

/**
 * Adds an annotated tag `name` on `target` (a commit, or an earlier tag for a tag of a tag), tagged by `tagger` ({ name, email })
 * at `tz`. Returns the object id of the tag object.
 */
export function createAnnotatedTag(dir, name, target, { message = 'tag', tagger = PROJECT, tz = '+0000' } = {}) {
  const env = { GIT_COMMITTER_NAME: tagger.name, GIT_COMMITTER_EMAIL: tagger.email, GIT_COMMITTER_DATE: `1700000000 ${tz}` };
  git(dir, ['tag', '-a', '-m', message, name, target], { env });
  return git(dir, ['rev-parse', `refs/tags/${name}`]);
}

export function writeList(entries) {
  const file = path.join(makeTempDir('list'), 'private-list.txt');
  writeFileSync(file, `${entries.join('\n')}\n`);
  return file;
}

/** An invented entry that no fixture holds; the default wording list holds only this. */
export const DEFAULT_WORDING_ENTRY = ['xyzzy', 'barred'].join('-');

let defaultWordingList;

/** The wording list that complete and history runs get unless they name their own: one invented entry, written once. */
export function defaultWordingListFile() {
  defaultWordingList ??= writeList([DEFAULT_WORDING_ENTRY]);
  return defaultWordingList;
}

/** Runs the gate script with `args`, killed after `timeout` ms, and returns { status, stdout, stderr }. */
export function runGate(args, { env, timeout = 120_000 } = {}) {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the history mode with `args` and returns { status, stdout, stderr }. */
export function runHistory(args, { env } = {}) {
  const result = spawnSync(process.execPath, [HISTORY_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs check-report with `args` and returns { status, stdout, stderr }. */
export function runCheckReport(args) {
  const result = spawnSync(process.execPath, [CHECK_REPORT_SCRIPT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const withWordingList = (extra) => (extra.includes('--wording-list') ? [] : ['--wording-list', defaultWordingListFile()]);

/** History-mode arguments; unless `extra` names a scanner or a wording list, they name the stub that finds nothing and the default wording list. */
export function historyArgs(history, listFile, extra = [], refs = 'main') {
  return ['--repo', history.dir, '--refs', refs, '--private-list', listFile, '--expected-root', history.commits[0], ...withWordingList(extra),
    ...(extra.includes('--gitleaks') ? [] : cleanScannerArgs()), ...extra];
}

let cleanScanner;

/** The gate's scanner arguments for a stub gitleaks that finds nothing. */
export function cleanScannerArgs() {
  cleanScanner ??= writeStubGitleaks();
  return ['--gitleaks', cleanScanner.binary, '--gitleaks-sha256', cleanScanner.sha256];
}

/** Gate arguments for `repo`; unless `extra` names a scanner, they name the stub that finds nothing. */
export function gateArgs(repo, scope, extra = []) {
  return ['--repo', repo.dir, '--commit', repo.commit, '--scope', scope, ...(extra.includes('--gitleaks') ? [] : cleanScannerArgs()), ...extra];
}

/** The scanner identity fields a report carries, computed from the shipped config and policy file; `scannerSha256` is the executable's (default: the clean stub's). */
export function expectedScanIdentity(scannerSha256 = cleanScannerArgs()[3]) {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  return {
    scannerVersion: config.scanner.version,
    scannerSha256,
    scannerPolicySha256: sha256(readFileSync(path.join(REPO_ROOT, '.gitleaks.toml'))),
    secretExceptionsSha256: sha256(JSON.stringify({ baseline: config.secretBaseline, exceptions: config.secretExceptions })),
  };
}

/** The `wordingListSha256` a complete-scope or history report carries for `wordingListFile` (default: the default wording list). */
export const expectedWordingListSha256 = (wordingListFile = defaultWordingListFile()) => sha256(readFileSync(wordingListFile));

/** Complete-scope gate arguments; unless `extra` names a wording list, they name the default one. */
export function completeArgs(repo, listFile, extra = []) {
  return gateArgs(repo, 'complete', ['--private-list', listFile, '--expected-root', repo.commit, ...withWordingList(extra), ...extra]);
}

/** The absolute paths of the files under `entry` (a path in this repo) that git tracks or would add, so a new file counts before it is committed. */
export function walkFiles(entry) {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-co', '--exclude-standard', '--', entry], { encoding: 'utf8' });
  return listing.split('\n').filter(Boolean).map((file) => path.join(REPO_ROOT, file));
}

/** Hashes every file under `dir` (including .git) so a test can prove a run changed nothing. */
export function snapshotTree(dir) {
  const lines = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else lines.push(`${path.relative(dir, full)} ${sha256(readFileSync(full))}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}
