import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, makeTempDir } from './gate-fixtures.mjs';

export const WORKFLOW_DIRECTORY = path.join(REPO_ROOT, '.github', 'workflows');
const INVENTORY_FILE = path.join(REPO_ROOT, 'scripts', 'ci', 'dependency-roots.json');
const BASH = '/bin/bash';

export const readWorkflow = (file) => readFileSync(path.join(WORKFLOW_DIRECTORY, file), 'utf8');
export const workflows = () => readdirSync(WORKFLOW_DIRECTORY).filter((file) => /\.ya?ml$/.test(file)).sort().map((file) => ({ file, text: readWorkflow(file) }));

/** The text of each step of a workflow, split at the six-space `- ` that opens a step in this repo's workflow files. */
export const stepsOf = (text) => text.split(/^ {6}- /m).slice(1);

/** The one-line `run:` command of a step, or null when the step has none or runs a block. */
export const commandOf = (step) => /^(?: {8})?run: (.+)$/m.exec(step)?.[1] ?? null;

/** The job's default `working-directory` (declared before its steps), or `.`. */
const defaultDirectoryOf = (text) => /^ {8}working-directory: (\S+)$/m.exec(text.split(/^ {4}steps:$/m)[0])?.[1] ?? '.';

/** The step's own `working-directory`, else the job's default. */
export const directoryOf = (text, step) => /^ {8}working-directory: (\S+)$/m.exec(step)?.[1] ?? defaultDirectoryOf(text);

/** The inventoried dependency roots, as repo-relative paths. */
export const inventoryRoots = () => JSON.parse(readFileSync(INVENTORY_FILE, 'utf8')).roots.map(({ path: root }) => root);

/** A temporary checkout holding this repository's scripts and the manifest-and-lock pair of every inventoried root; `plant(checkout)` may then edit it. */
export function makeJobCheckout(plant = () => {}) {
  const dir = makeTempDir('job-checkout');
  cpSync(path.join(REPO_ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  for (const root of inventoryRoots()) {
    for (const file of ['package.json', 'package-lock.json']) {
      if (!existsSync(path.join(REPO_ROOT, root, file))) continue;
      mkdirSync(path.join(dir, root), { recursive: true });
      cpSync(path.join(REPO_ROOT, root, file), path.join(dir, root, file));
    }
  }
  const editJson = (root, file, edit) => {
    const target = path.join(dir, root, file);
    const value = JSON.parse(readFileSync(target, 'utf8'));
    edit(value);
    writeFileSync(target, JSON.stringify(value));
  };
  plant({ dir, editJson });
  return dir;
}

/** A PATH folder with this `node` and an `npm` that records each call and fails. */
function instrumentedPath() {
  const dir = makeTempDir('job-path');
  const log = path.join(dir, 'npm-calls.log');
  symlinkSync(process.execPath, path.join(dir, 'node'));
  writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
  chmodSync(path.join(dir, 'npm'), 0o755);
  return { dir, npmCalls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

/** Runs the one-line commands of `steps` in order in `checkout`, each in its step's directory, stopping at the first failure as Actions does. Returns each run's { command, status, stdout, stderr } and the recorded npm calls. */
export function runSteps(checkout, workflowText, steps) {
  const tools = instrumentedPath();
  const runs = [];
  for (const step of steps) {
    const command = commandOf(step);
    if (command === null) continue;
    const result = spawnSync(BASH, ['-c', command], { cwd: path.join(checkout, directoryOf(workflowText, step)), encoding: 'utf8', env: { PATH: tools.dir } });
    runs.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0) break;
  }
  return { runs, npmCalls: tools.npmCalls() };
}
