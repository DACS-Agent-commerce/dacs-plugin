import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';

const WORKFLOW_DIRECTORY = path.join(REPO_ROOT, '.github', 'workflows');
const GATE_WORKFLOW = 'public-gate.yml';
const GATE_JOB = 'public-gate';
const REPORT_ARTIFACT = 'public-gate-report';
const HEAD_COMMIT_EXPRESSION = '${{ github.event.pull_request.head.sha || github.sha }}';
const REPORT_FILE_EXPRESSION = '${{ runner.temp }}/gate-report/report.json';
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+$/;

const literal = (text) => text.replaceAll(/[$.{|}]/g, '\\$&');
const readWorkflow =(file) => readFileSync(path.join(WORKFLOW_DIRECTORY, file), 'utf8');
const workflows = () => readdirSync(WORKFLOW_DIRECTORY).filter((file) => /\.ya?ml$/.test(file)).sort().map((file) => ({ file, text: readWorkflow(file) }));

/** The text of each step of a workflow, split at the six-space `- ` that opens a step in this repo's workflow files. */
const stepsOf = (text) => text.split(/^ {6}- /m).slice(1);

const stepIndex = (steps, marker) => {
  const found = steps.map((step, index) => (step.includes(marker) ? index : -1)).filter((index) => index >= 0);
  assert.equal(found.length, 1, `exactly one step holds ${marker}`);
  return found[0];
};

test('every action is pinned by SHA, contents are read-only, checkouts keep no credentials, no job reads a secret and none uses pull_request_target', () => {
  const all = workflows();
  assert.ok(all.some(({ file }) => file === GATE_WORKFLOW));
  for (const { file, text } of all) {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${file} uses an action`);
    for (const reference of uses) assert.match(reference, PINNED_ACTION, `${file}: ${reference}`);
    assert.match(text, /^permissions:\n {2}contents: read\n/m, file);
    assert.doesNotMatch(text, /:\s*write\b/, `${file} grants write access`);
    for (const step of stepsOf(text).filter((candidate) => candidate.includes('actions/checkout@'))) {
      assert.match(step, /^ {10}persist-credentials: false$/m, `${file}: a checkout keeps credentials`);
    }
    assert.doesNotMatch(text, /\bsecrets\b/, `${file} reads a secret`);
    assert.doesNotMatch(text, /pull_request_target/, file);
  }
});

test('every setup-node step installs an exact Node release, so a new release cannot change a run', () => {
  for (const { file, text } of workflows()) {
    const setupNodes = stepsOf(text).filter((step) => step.includes('actions/setup-node@'));
    for (const step of setupNodes) assert.match(step, /^ {10}node-version: "\d+\.\d+\.\d+"$/m, `${file}: node-version is not an exact release`);
  }
});

test('the gate job is named public-gate, runs on every pull request and push with no path filter and full history, installs root dependencies and gitleaks through the bounded installer, runs generic scope and npm test, and uploads the report under a fixed name even on failure', () => {
  const text = readWorkflow(GATE_WORKFLOW);
  assert.match(text, /^name: public-gate\n/);
  assert.match(text, /^on:\n {2}pull_request:\n {2}push:\n\n/m);
  assert.doesNotMatch(text, /^\s+(?:paths|paths-ignore|branches|branches-ignore|tags):/m);
  assert.deepEqual([...text.matchAll(/^ {2}(\S[^:]*):$/gm)].map((match) => match[1]).filter((key) => key !== 'pull_request' && key !== 'push'), [GATE_JOB]);
  assert.match(text, new RegExp(`^ {4}name: ${GATE_JOB}$`, 'm'));

  const steps = stepsOf(text);
  const order = [
    'actions/checkout@', 'actions/setup-node@', 'run: npm ci', 'node scripts/ci/install-gitleaks.mjs', 'npm run gate:generic', 'run: npm test', 'actions/upload-artifact@',
  ].map((marker) => stepIndex(steps, marker));
  assert.deepEqual(order, [...order].sort((first, second) => first - second), 'the steps run in the card\'s order');
  assert.equal(order.at(-1), steps.length - 1, 'the upload is the last step');

  const [checkout, setupNode, install, installer, gate, rootTests, upload] = order.map((index) => steps[index]);
  assert.match(checkout, /^ {10}fetch-depth: 0$/m);
  assert.match(checkout, new RegExp(`^ {10}ref: ${literal(HEAD_COMMIT_EXPRESSION)}$`, 'm'));
  assert.match(setupNode, /^ {10}node-version: "22\.23\.3"$/m);
  assert.doesNotMatch(install, /--ignore-scripts|\bnpm install\b/);
  assert.match(installer, /--dir "\$\{\{ runner\.temp \}\}\/gitleaks"/);
  assert.match(gate, /sha256sum "\$\{\{ runner\.temp \}\}\/gitleaks\/gitleaks"/);
  assert.match(gate, /--commit "\$HEAD_COMMIT"/);
  assert.match(gate, new RegExp(`^ {10}HEAD_COMMIT: ${literal(HEAD_COMMIT_EXPRESSION)}$`, 'm'));
  assert.match(gate, /--gitleaks "\$\{\{ runner\.temp \}\}\/gitleaks\/gitleaks" --gitleaks-sha256 "\$GITLEAKS_SHA256"/);
  assert.ok(gate.includes(`--out "${REPORT_FILE_EXPRESSION}"`));
  assert.match(gate, /mkdir -p "\$\{\{ runner\.temp \}\}\/gate-report"/);
  assert.match(rootTests, /^ {8}run: npm test$/m);
  assert.match(rootTests, /^ {8}env:\n {10}GITLEAKS_BIN: \$\{\{ runner\.temp \}\}\/gitleaks\/gitleaks$/m, 'the root tests find the gitleaks the installer placed');

  assert.match(upload, /^ {8}if: always\(\)$/m);
  assert.match(upload, /^ {10}overwrite: true$/m, 'a re-run of the job replaces the report it uploaded before');
  assert.match(upload, new RegExp(`^ {10}name: ${REPORT_ARTIFACT}$`, 'm'));
  assert.match(upload, new RegExp(`^ {10}path: ${literal(REPORT_FILE_EXPRESSION)}$`, 'm'));
  for (const step of steps.filter((candidate) => candidate !== upload)) {
    assert.doesNotMatch(step, /^\s+(?:if|continue-on-error|shell):/m, 'a failed step must skip the rest');
    assert.doesNotMatch(step.replaceAll(/\$\{\{.*?\}\}/g, ''), /\|\||set \+e|;\s*true\b|\bexit 0\b/, 'a run line must not swallow a failure');
  }
  assert.doesNotMatch(upload, /continue-on-error/);
});
