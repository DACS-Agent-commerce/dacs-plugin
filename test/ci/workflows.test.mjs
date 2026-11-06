import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';
import { commandOf, directoryOf, inventoryRoots, makeJobCheckout, readWorkflow, runSteps, stepsOf, workflows } from '../lib/workflow-fixtures.mjs';

const GATE_WORKFLOW = 'public-gate.yml';
const HTTP_WORKFLOW = 'http-mcp-tests.yml';
const SHARED_INPUT_PATHS = ['scripts/ci/**', 'package.json', 'package-lock.json'];
const HTTP_VALIDATION = 'node ../scripts/ci/sdk-input.mjs --prepare http-mcp';
const GATE_VALIDATION = 'node scripts/ci/sdk-input.mjs --prepare root';
const NPM_COMMAND = /\bnpm\s+(?:ci|install|i|rebuild|run|test|exec)\b[^\n]*/g;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);
const GATE_JOB = 'public-gate';
const REPORT_ARTIFACT = 'public-gate-report';
const HEAD_COMMIT_EXPRESSION = '${{ github.event.pull_request.head.sha || github.sha }}';
const REPORT_FILE_EXPRESSION = '${{ runner.temp }}/gate-report/report.json';
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+$/;

const literal = (text) => text.replaceAll(/[$.{|}]/g, '\\$&');

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

const indicesOf = (steps, matches) => steps.flatMap((step, index) => (matches(commandOf(step) ?? '') ? [index] : []));
const pathFilter = (text, event) => [...(new RegExp(`^ {2}${event}:\\n((?: {4}.*\\n)+)`, 'm').exec(text)?.[1] ?? '').matchAll(/^ {6}- '(.+)'$/gm)].map((match) => match[1]);

test('the http-mcp job runs sdk-input before both installs, http-mcp and wallet-build, and the public-gate job runs it before the root install; while the input is unavailable the http-mcp job reports unverifiable, not a test failure; both http-mcp push and pull-request filters contain scripts/ci/**, package.json and package-lock.json', async (t) => {
  const http = readWorkflow(HTTP_WORKFLOW);
  const httpSteps = stepsOf(http);
  const validations = indicesOf(httpSteps, (command) => command === HTTP_VALIDATION);
  const installs = indicesOf(httpSteps, (command) => command.startsWith('npm ci '));

  await t.test('http-mcp validates before the http-mcp install and again before the wallet-build install', () => {
    assert.equal(validations.length, 2);
    assert.equal(installs.length, 2);
    assert.deepEqual(installs.map((index) => directoryOf(http, httpSteps[index])), ['http-mcp', 'http-mcp/wallet-build']);
    assert.deepEqual(validations.map((index) => directoryOf(http, httpSteps[index])), ['http-mcp', 'http-mcp']);
    assert.ok(validations[0] < installs[0] && installs[0] < validations[1] && validations[1] < installs[1], 'each install follows its own validation');
  });

  await t.test('public-gate validates the root input after setting up Node and before the root install', () => {
    const gate = stepsOf(readWorkflow(GATE_WORKFLOW));
    const [validation, ...extra] = indicesOf(gate, (command) => command === GATE_VALIDATION);
    assert.equal(extra.length, 0);
    assert.ok(stepIndex(gate, 'actions/setup-node@') < validation && validation < stepIndex(gate, 'run: npm ci'));
  });

  await t.test('an unavailable input stops the http-mcp job at the validation step with its own exit status and cause, before any install or test', () => {
    const [firstValidation] = validations;
    const guarded = httpSteps.slice(firstValidation, validations[1] + 1);
    for (const step of guarded) assert.doesNotMatch(step, /^\s*(?:if|continue-on-error):|\|\||set \+e/m, 'the validation is neither skipped nor tolerated');
    assert.ok(indicesOf(httpSteps, (command) => command.includes('npm run test:ci')).every((index) => index > validations[1]));
    const checkout = makeJobCheckout(({ editJson }) => editJson('http-mcp', 'package.json', (manifest) => { manifest.dependencies = { ...manifest.dependencies, '@kynesyslabs/demosdk': '^4.0.16' }; }));
    const { runs, npmCalls } = runSteps(checkout, http, httpSteps.slice(firstValidation));
    assert.equal(runs.length, 1, 'nothing runs after the validation');
    assert.equal(runs[0].status, 2, 'unverifiable is exit 2, apart from refused (1) and a failed test');
    assert.match(runs[0].stderr, /^sdk-input-unavailable: /);
    assert.equal(npmCalls, '');
  });

  await t.test('both the pull-request and push filters hold the plugin folder, the workflow and the shared validation inputs', () => {
    for (const event of ['pull_request', 'push']) {
      const filter = pathFilter(http, event);
      assert.deepEqual([...filter].sort(), ['.github/workflows/http-mcp-tests.yml', 'http-mcp/**', ...SHARED_INPUT_PATHS].sort(), event);
    }
  });
});

const npmDirectories = (text) => stepsOf(text).flatMap((step) => [...step.replaceAll(/^\s*#.*$/gm, '').matchAll(NPM_COMMAND)]
  .map(([line]) => path.posix.normalize(/--prefix[ =](\S+)/.exec(line)?.[1] ?? directoryOf(text, step)).replace(/(?<=.)\/$/, '')));

const manifestLockPairs = (relative = '.') => {
  const entries = readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const here = names.has('package.json') && (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) ? [relative] : [];
  return [...here, ...entries.filter((entry) => entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)).flatMap((entry) => manifestLockPairs(path.posix.join(relative, entry.name)))];
};

const unlistedRoots = (directories, roots) => [...new Set(directories)].filter((directory) => !roots.includes(directory));
const unlistedPairs = (pairs, roots) => pairs.filter((directory) => !roots.includes(directory) && !directory.split('/').includes('fixtures'));

const UNLISTED_JOB = [
  'jobs:', '  build:', '    defaults:', '      run:', '        working-directory: tools/extra', '    steps:',
  '      - run: npm ci', '      # npm run commented-out in packages/ignored', '      - run: npm run build --prefix packages/other', '',
].join('\n');

test('dependency roots: every directory any workflow job installs, builds or tests in is an inventoried root, and every committed manifest-and-lock pair is an inventoried root or fixture; a job installing in an unlisted root, or an unlisted pair, fails', async (t) => {
  const roots = inventoryRoots();

  await t.test('every directory the committed workflows run npm in is an inventoried root', () => {
    for (const { file, text } of workflows()) {
      const directories = npmDirectories(text);
      assert.ok(directories.length > 0, `${file} runs npm somewhere`);
      assert.deepEqual(unlistedRoots(directories, roots), [], file);
    }
  });

  await t.test('every committed manifest-and-lock pair is an inventoried root or a fixture', () => {
    const pairs = manifestLockPairs();
    assert.ok(existsSync(path.join(REPO_ROOT, 'package-lock.json')) && pairs.includes('.'), 'the walk finds the root pair');
    assert.deepEqual(unlistedPairs(pairs, roots), []);
  });

  await t.test('a job installing in an unlisted root fails, whether by working-directory or --prefix', () => {
    assert.deepEqual(npmDirectories(UNLISTED_JOB), ['tools/extra', 'packages/other']);
    assert.deepEqual(unlistedRoots(npmDirectories(UNLISTED_JOB), roots), ['tools/extra', 'packages/other']);
  });

  await t.test('an unlisted pair fails and a pair under a fixtures folder does not', () => {
    assert.deepEqual(unlistedPairs(['http-mcp', 'packages/extra', 'test/fixtures/sample'], roots), ['packages/extra']);
  });
});
