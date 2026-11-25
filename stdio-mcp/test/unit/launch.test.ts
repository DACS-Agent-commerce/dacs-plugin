/**
 * scripts/launch.mjs, when the server is not built, writes a build command to stderr and exits 1.
 * These checks copy the launcher into temporary plugin folders whose names hold spaces, quotes and
 * shell metacharacters, run it, and then run the printed `cd` in a POSIX shell: it must land in
 * exactly that folder and run nothing that appears in the name. stdout must stay empty, since it
 * is the MCP stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const LAUNCHER = path.join(import.meta.dirname, '../../scripts/launch.mjs');
const skip = process.platform === 'win32' ? 'the printed command is for a POSIX shell' : false;

const SHELLS = ['/bin/sh', '/bin/bash'].filter((s) => fs.existsSync(s));

const NAMES = [
  'plugin with spaces',
  "it's here",
  'say "hi"',
  'cost $HOME and ${PATH}',
  'a $(touch ran-subst) b',
  'a `touch ran-backtick` b',
  // No backslash: Node will not start an ES module from a path that holds one.
  'bang! star* semi; amp & pipe |',
  'line\nbreak',
];

/** Runs a copy of the launcher from <tmp>/<name>/scripts/ with nothing built beside it. */
function runFrom(name: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'demos launch '));
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(LAUNCHER, path.join(root, 'scripts', 'launch.mjs'));
  const env = { ...process.env };
  delete env.NODE_USE_ENV_PROXY;
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'launch.mjs')], {
    cwd: base,
    encoding: 'utf8',
    env,
  });
  return { base, root: fs.realpathSync(root), run };
}

/** The `cd` target exactly as printed, newlines included. */
function printedTarget(stderr: string): string {
  const m = /\n {2}cd ([\s\S]*) && npm ci && npm run build\n/.exec(stderr);
  assert.ok(m, `no build command in:\n${stderr}`);
  return m[1]!;
}

test('missing build: the printed cd lands in the plugin folder in a POSIX shell', { skip }, () => {
  assert.ok(SHELLS.length > 0, 'no POSIX shell found');
  for (const name of NAMES) {
    const { base, root, run } = runFrom(name);
    try {
      assert.equal(run.status, 1, `exit status for ${JSON.stringify(name)}`);
      assert.equal(run.stdout, '', 'stdout is the MCP stream and must stay empty');
      assert.match(run.stderr, /^demos-mcp is not built yet\. Run:\n/);
      const target = printedTarget(run.stderr);
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-launch-cwd-'));
      try {
        for (const sh of SHELLS) {
          const r = spawnSync(sh, ['-c', `cd ${target} && pwd -P`], { cwd: sandbox, encoding: 'utf8' });
          assert.equal(r.status, 0, `${sh} for ${JSON.stringify(name)}: ${r.stderr}`);
          assert.equal(r.stdout, `${root}\n`, `${sh} for ${JSON.stringify(name)}`);
          assert.deepEqual(fs.readdirSync(sandbox), [], `${sh} ran part of ${JSON.stringify(name)}`);
        }
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});
