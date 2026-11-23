// The stop file: <dataDir>/KILL, read with two lstat calls on real filesystem states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStopFileCheck, ensureStateDirectory } from '../src/stop-file.mjs';
import { ConfigError } from '../src/config.mjs';

function recordingLogger() {
  const warnings = [];
  return { warnings, logger: { debug() {}, info() {}, error() {}, warn: (event, fields) => warnings.push({ event, ...fields }) } };
}

// Each row builds one state under `root` and returns the state directory the check reads.
const ROWS = [
  { state: 'no KILL', stopped: false, build: (root) => mkdirSync(join(root, 'state')) },
  { state: 'KILL is a regular file', stopped: true, cause: 'present', build: (root) => { mkdirSync(join(root, 'state')); writeFileSync(join(root, 'state', 'KILL'), 'stop\n'); } },
  { state: 'KILL is an empty file', stopped: true, cause: 'present', build: (root) => { mkdirSync(join(root, 'state')); writeFileSync(join(root, 'state', 'KILL'), ''); } },
  { state: 'KILL is a directory', stopped: true, cause: 'present', build: (root) => mkdirSync(join(root, 'state', 'KILL'), { recursive: true }) },
  { state: 'KILL is a symlink to a file', stopped: true, cause: 'present', build: (root) => { mkdirSync(join(root, 'state')); writeFileSync(join(root, 'target'), ''); symlinkSync(join(root, 'target'), join(root, 'state', 'KILL')); } },
  { state: 'KILL is a broken symlink', stopped: true, cause: 'present', build: (root) => { mkdirSync(join(root, 'state')); symlinkSync(join(root, 'gone'), join(root, 'state', 'KILL')); } },
  { state: 'KILL is a symlink to itself', stopped: true, cause: 'present', build: (root) => { mkdirSync(join(root, 'state')); symlinkSync(join(root, 'state', 'KILL'), join(root, 'state', 'KILL')); } },
  { state: 'the state directory has mode 000', stopped: true, cause: 'EACCES', build: (root) => { mkdirSync(join(root, 'state')); chmodSync(join(root, 'state'), 0o000); } },
  { state: 'the state directory path is a file', stopped: true, cause: 'not_a_directory', build: (root) => writeFileSync(join(root, 'state'), '') },
  { state: 'the state directory is missing', stopped: true, cause: 'ENOENT', build: () => {} },
  { state: 'the state directory is a symlink', stopped: true, cause: 'symlink', build: (root) => { mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'state')); } },
];

test('the stop check reports absent only for ENOENT on KILL inside a real state directory, for every stop-file state', async (t) => {
  for (const row of ROWS) {
    await t.test(row.state, async () => {
      const root = mkdtempSync(join(tmpdir(), 'dacs-stop-file-'));
      try {
        row.build(root);
        const { warnings, logger } = recordingLogger();
        const stopped = createStopFileCheck({ dataDir: join(root, 'state'), logger });
        assert.equal(await stopped(), row.stopped);
        assert.equal(await stopped(), row.stopped, 'a second check reads the same state');
        if (row.stopped) assert.equal(warnings[0].cause, row.cause, 'the cause is logged');
        else assert.deepEqual(warnings, []);
      } finally {
        try { chmodSync(join(root, 'state'), 0o700); } catch { /* not every row has a directory there */ }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('the stop check sees KILL created and removed between two checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dacs-stop-file-'));
  try {
    const stopped = createStopFileCheck({ dataDir: root, logger: recordingLogger().logger });
    assert.equal(await stopped(), false);
    writeFileSync(join(root, 'KILL'), '');
    assert.equal(await stopped(), true);
    rmSync(join(root, 'KILL'));
    assert.equal(await stopped(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the state directory is created private when absent, kept when it is a real directory, and refused when it is a symlink or a file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dacs-state-dir-'));
  try {
    const created = join(root, 'parent', 'state');
    await ensureStateDirectory(created);
    assert.ok(lstatSync(created).isDirectory());
    assert.equal(statSync(created).mode & 0o777, 0o700);
    writeFileSync(join(created, 'kept'), '');
    await ensureStateDirectory(created);
    assert.ok(lstatSync(join(created, 'kept')).isFile(), 'an existing directory is left as it is');
    symlinkSync(created, join(root, 'link'));
    await assert.rejects(ensureStateDirectory(join(root, 'link')), (error) => error instanceof ConfigError && /real directory/.test(error.message));
    writeFileSync(join(root, 'file'), '');
    await assert.rejects(ensureStateDirectory(join(root, 'file')), (error) => error instanceof ConfigError && /real directory/.test(error.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
