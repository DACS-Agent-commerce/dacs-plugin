import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hermeticGitEnvironment, makeTempDir } from './gate-fixtures.mjs';

const FIXTURES_MODULE = new URL('./gate-fixtures.mjs', import.meta.url).href;

test('a fixture folder does not belong to the git checkout that holds the temp folder', () => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'fixture-outer-'));
  execFileSync('git', ['init', '-q', checkout], { env: hermeticGitEnvironment() });
  const temp = path.join(checkout, 'tmp');
  mkdirSync(temp);
  const script = `const { makeTempDir } = await import(${JSON.stringify(FIXTURES_MODULE)}); process.stdout.write(makeTempDir('probe'));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: temp } });
  assert.equal(child.status, 0, child.stderr);
  const top = execFileSync('git', ['-C', child.stdout, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: hermeticGitEnvironment() }).trim();
  assert.notEqual(top, realpathSync(checkout), 'the fixture is in the surrounding checkout');
});

test('the fixture git environment drops caller GIT_ variables and ignores caller and system git config', () => {
  const [bare, config] = [path.join(makeTempDir('bare'), 'bare.git'), path.join(makeTempDir('config'), 'gitconfig')];
  writeFileSync(config, '[init]\n\tdefaultBranch = caller-branch\n');
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_DIR: bare, GIT_WORK_TREE: bare, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
  try {
    const env = hermeticGitEnvironment();
    assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('GIT_') && !name.startsWith('GIT_AUTHOR') && !name.startsWith('GIT_COMMITTER')).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);
    const dir = makeTempDir('init');
    execFileSync('git', ['init', '-q', dir], { env });
    assert.ok(existsSync(path.join(dir, '.git')), 'git did not init the folder it was given');
    assert.notEqual(execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8', env }).trim(), 'refs/heads/caller-branch');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
