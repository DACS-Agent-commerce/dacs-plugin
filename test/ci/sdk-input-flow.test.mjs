import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOf, makeJobCheckout, readWorkflow, runSteps, stepsOf } from '../lib/workflow-fixtures.mjs';

const SDK_KEY = '@kynesyslabs/demosdk';
const SDK_LOCK_KEY = `node_modules/${SDK_KEY}`;

/** Each job's own validation command, its first install, and the root that install reads. */
const JOBS = [
  { name: 'public-gate', workflow: 'public-gate.yml', validation: /sdk-input\.mjs --prepare root$/, install: 'npm ci', root: '.' },
  { name: 'http-mcp', workflow: 'http-mcp-tests.yml', validation: /sdk-input\.mjs --prepare http-mcp$/, install: 'npm ci ', root: 'http-mcp/wallet-build' },
];

const STDIO_JOB = { name: 'stdio-mcp', workflow: 'stdio-mcp.yml', validation: /sdk-input\.mjs --prepare stdio$/, install: 'npm ci ', root: 'stdio-mcp' };

const FORBIDDEN_INPUTS = [
  ['a path spec in the manifest', 'local-path-spec', (editJson, root) => editJson(root, 'package.json', (manifest) => {
    manifest.dependencies = { ...manifest.dependencies, [SDK_KEY]: 'file:../sdk' };
  })],
  ['a path resolution in the lock', 'lock-local-resolution', (editJson, root) => editJson(root, 'package-lock.json', (lock) => {
    lock.packages[SDK_LOCK_KEY] = { version: '4.0.16', resolved: 'file:../sdk' };
  })],
];

/** The job's steps from its validation through its first install, as the job runs them. */
function validationToInstall({ workflow, validation, install }) {
  const text = readWorkflow(workflow);
  const steps = stepsOf(text);
  const first = steps.findIndex((step) => validation.test(commandOf(step) ?? ''));
  const last = steps.findIndex((step, index) => index > first && (commandOf(step) ?? '').startsWith(install));
  assert.ok(first >= 0 && last > first, `${workflow} validates before its first install`);
  return { text, steps: steps.slice(first, last + 1) };
}

test('each of the public-gate and http-mcp jobs\' own preparation commands, run with a forbidden SDK spec or lock resolution and an instrumented npm, fails at validation and never invokes npm', async (t) => {
  for (const job of JOBS) {
    const { text, steps } = validationToInstall(job);

    if (job.name === 'public-gate') {
      await t.test('public-gate: with no forbidden input the validation passes and the instrumented install is reached', () => {
        const { runs, npmCalls } = runSteps(makeJobCheckout(), text, steps);
        assert.deepEqual(runs.map(({ status }) => status), [0, 1]);
        assert.equal(npmCalls, 'ci\n');
      });
    }

    for (const [label, cause, plant] of FORBIDDEN_INPUTS) {
      await t.test(`${job.name}: ${label} fails at validation with exit 1 and npm is never invoked`, () => {
        const checkout = makeJobCheckout(({ editJson }) => plant(editJson, job.root));
        const { runs, npmCalls } = runSteps(checkout, text, steps);
        assert.equal(runs.length, 1, 'the install after the validation never runs');
        assert.equal(runs[0].status, 1);
        assert.match(runs[0].stderr, /^sdk-input-refused: /);
        assert.equal(JSON.parse(runs[0].stdout).roots.find(({ root }) => root === job.root).cause, cause);
        assert.equal(npmCalls, '');
      });
    }
  }
});

test('the stdio job\'s own preparation commands, run with a forbidden SDK spec in stdio\'s manifest and an instrumented npm, fail at the validation step and never invoke npm', async (t) => {
  const { text, steps } = validationToInstall(STDIO_JOB);

  await t.test('stdio-mcp: with no forbidden input the validation passes and the instrumented install is reached', () => {
    const { runs, npmCalls } = runSteps(makeJobCheckout(), text, steps);
    assert.deepEqual(runs.map(({ status }) => status), [0, 1]);
    assert.equal(npmCalls, 'ci --ignore-scripts --no-audit --no-fund\n');
  });

  const [label, cause, plant] = FORBIDDEN_INPUTS[0];
  await t.test(`stdio-mcp: ${label} fails at validation with exit 1 and npm is never invoked`, () => {
    const checkout = makeJobCheckout(({ editJson }) => plant(editJson, STDIO_JOB.root));
    const { runs, npmCalls } = runSteps(checkout, text, steps);
    assert.equal(runs.length, 1, 'the install after the validation never runs');
    assert.equal(runs[0].status, 1);
    assert.match(runs[0].stderr, /^sdk-input-refused: /);
    assert.equal(JSON.parse(runs[0].stdout).roots.find(({ root }) => root === STDIO_JOB.root).cause, cause);
    assert.equal(npmCalls, '');
  });
});
