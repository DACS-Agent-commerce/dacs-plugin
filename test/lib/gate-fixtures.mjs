import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = path.join(REPO_ROOT, 'public-gate.config.json');

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

function git(dir, args, { input, env } = {}) {
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
