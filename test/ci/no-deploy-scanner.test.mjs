import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';

// Built from parts so that this file does not name the module it looks for.
const SCANNER = ['deploy', 'scripts', 'lib', 'rules.mjs'].join('/');
const trackedFiles = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

// The title must not spell the path either: this file is tracked and scanned.
test('no carried file imports or names the excluded deploy scanner module', () => {
  const naming = trackedFiles
    .filter((file) => existsSync(path.join(REPO_ROOT, file)) && !file.endsWith('package-lock.json'))
    .filter((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8').includes(SCANNER));
  assert.deepEqual(naming, []);
});
