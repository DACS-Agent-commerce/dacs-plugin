import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MATRIX } from '../../scripts/ci/test-all.mjs';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';
import { directoryOf, stepsOf, workflows } from '../lib/workflow-fixtures.mjs';

const MATRIX_HEADER = '| Suite | Command | Prepared by | Runtime | Actions job | Owner card | Stage |';
const PENDING_STAGE = 'pending: P54c2';
const PENDING_OWNER = 'P54c2';
const COLUMNS = ['suite', 'command', 'prepared', 'runtime', 'job', 'owner', 'stage'];
const VERSION = /\d+\.\d+\.\d+/g;
const FLOOR_RUNTIME = '20.19.0';

const readme = () => readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const inventory = () => JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts', 'ci', 'dependency-roots.json'), 'utf8')).roots;
const workflowTexts = () => Object.fromEntries(workflows().map(({ file, text }) => [file, text]));
const spans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/** The matrix rows of a README, each as an object keyed by COLUMNS. */
function matrixRows(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(MATRIX_HEADER);
  assert.ok(start >= 0, 'the README holds the command matrix');
  const body = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    body.push(line);
  }
  return body.map((line) => Object.fromEntries(line.slice(1, -1).split('|').map((cell, index) => [COLUMNS[index], cell.trim()])));
}

/** What one job does, read from its workflow text: its runtimes, the directories it runs `npm ci` in, its validation target and its steps. */
function jobFacts(text) {
  const steps = stepsOf(text);
  const commandLines = (step) => step.split('\n').map((line) => line.trim().replace(/^(?:- )?run: /, ''));
  const validation = steps.findIndex((step) => /sdk-input\.mjs --prepare \S+$/m.test(step));
  const installs = steps.flatMap((step, index) => (commandLines(step).some((line) => line.startsWith('npm ci')) ? [{ index, directory: directoryOf(text, step) }] : []));
  return {
    steps,
    runtimes: [...new Set([...text.matchAll(/^\s+node-version: (.+)$/gm)].flatMap((match) => match[1].match(VERSION) ?? []))],
    target: /sdk-input\.mjs --prepare (\S+)$/m.exec(steps[validation] ?? '')?.[1],
    validatedBeforeInstalls: validation >= 0 && installs.length > 0 && installs.every(({ index }) => index > validation),
    installDirectories: installs.map(({ directory }) => directory),
    runsCommand: (command, directory) => steps.some((step) => directoryOf(text, step) === directory
      && commandLines(step).some((line) => line === command || line.endsWith(` ${command}`))),
  };
}

/** The directory a Command cell names: "at the root", or "in `dir`". */
const commandDirectory = (cell) => (cell.includes('at the root') ? '.' : /\bin `([^`]+)`/.exec(cell)?.[1]);

function deliveredRowProblems(row, texts, roots) {
  const text = texts[spans(row.job)[0]];
  if (text === undefined) return [`${row.suite}: no workflow ${row.job}`];
  const problems = [];
  const facts = jobFacts(text);
  const directory = commandDirectory(row.command);
  for (const command of spans(row.command).filter((span) => span !== directory)) {
    if (!facts.runsCommand(command, directory)) problems.push(`${row.suite}: the job does not run \`${command}\` in ${directory}`);
  }
  if (JSON.stringify([...(row.runtime.match(VERSION) ?? [])].sort()) !== JSON.stringify([...facts.runtimes].sort())) problems.push(`${row.suite}: runtime ${row.runtime} is not the job's ${facts.runtimes}`);
  if (!facts.validatedBeforeInstalls) problems.push(`${row.suite}: the job does not validate before it installs`);
  if (!row.prepared.includes(`sdk-input --prepare ${facts.target}`)) problems.push(`${row.suite}: preparation is not sdk-input --prepare ${facts.target}`);
  const needed = roots.filter(({ path: root, prepare, optional }) => prepare.includes(facts.target) && !(optional && !facts.installDirectories.includes(root))).map(({ path: root }) => root);
  if (JSON.stringify([...needed].sort()) !== JSON.stringify([...facts.installDirectories].sort())) problems.push(`${row.suite}: the job installs ${facts.installDirectories}, the inventory needs ${needed}`);
  for (const installed of facts.installDirectories) {
    if (!(installed === '.' ? row.prepared.includes('at the root') : spans(row.prepared).includes(installed))) problems.push(`${row.suite}: the preparation does not name ${installed}`);
  }
  return problems;
}

/** Every way the README matrix, the workflows that exist and the inventory disagree; empty when they match. */
function matrixProblems(text, texts, roots) {
  const rows = matrixRows(text);
  const problems = [];
  const [delivered, pending] = [rows.filter((row) => row.stage === 'delivered'), rows.filter((row) => row.stage !== 'delivered')];
  for (const row of delivered) problems.push(...deliveredRowProblems(row, texts, roots));
  for (const row of pending) {
    if (row.stage !== PENDING_STAGE || !row.owner.includes(PENDING_OWNER)) problems.push(`${row.suite}: a pending row must read "${PENDING_STAGE}" and name ${PENDING_OWNER}`);
    if (texts[spans(row.job)[0]] !== undefined) problems.push(`${row.suite}: ${row.job} exists, so the row is not pending`);
  }
  const buyerRows = rows.filter((row) => /buyer/i.test(row.suite));
  if (buyerRows.length !== 2 || !buyerRows.every((row) => row.prepared.includes('sdk-input --prepare buyer'))) problems.push('both buyer rows are prepared by sdk-input --prepare buyer');
  const floor = buyerRows.find((row) => /floor/i.test(row.suite));
  if (!floor || !floor.prepared.includes('install both stdio and buyer roots') || !floor.prepared.includes('`npm run build` in stdio on the floor leg before refusal tests only') || floor.runtime !== FLOOR_RUNTIME) problems.push('the buyer-floor row keeps the stdio build on 20.19.0 before refusal tests only');
  const members = roots.filter(({ prepare }) => prepare.includes('buyer')).map(({ path: root }) => root);
  if (JSON.stringify(members.sort()) !== JSON.stringify(['stdio-mcp', 'stdio-mcp/buyer'])) problems.push(`the buyer preparation covers ${members}, not both stdio and buyer roots`);
  return problems;
}

/** `text` with `from` replaced by `to` on the one line that holds `marker`. */
const editLine = (text, marker, from, to) => text.split('\n').map((line) => (line.includes(marker) ? line.replace(from, to) : line)).join('\n');

test('intermediate stage: the README\'s delivered rows equal the commands, preparation and runtimes of the jobs that exist (public-gate, http-mcp, stdio), and each delivered job validates and prepares its roots before use; every other row is pending with owner P54c2 and uncredited; mutating a delivered row\'s command, runtime or root, or deleting a delivered job, fails; buyer is explicitly a preparation member of both stdio and buyer roots, and the pending buyer-floor row explicitly retains stdio build on 20.19.0 before refusal tests only', async (t) => {
  const [text, texts, roots] = [readme(), workflowTexts(), inventory()];

  await t.test('the committed README matches the committed workflows and inventory', () => {
    assert.deepEqual(matrixProblems(text, texts, roots), []);
    assert.deepEqual(matrixRows(text).filter((row) => row.stage === 'delivered').map((row) => row.job), ['`public-gate.yml`', '`http-mcp-tests.yml`', '`stdio-mcp.yml`']);
    assert.equal(matrixRows(text).filter((row) => row.stage === PENDING_STAGE).length, 4);
  });

  await t.test('the rows npm run test:all runs are the README\'s rows, in order, with the same commands, directories and preparations', () => {
    const rows = matrixRows(text);
    assert.deepEqual(MATRIX.map((entry) => entry.suite), rows.map((row) => row.suite));
    rows.forEach((row, index) => {
      const entry = MATRIX[index];
      if (entry.pending !== undefined) {
        assert.equal(row.stage, `pending: ${entry.pending}`, row.suite);
      } else {
        assert.equal(row.stage, 'delivered', row.suite);
        assert.equal(commandDirectory(row.command), entry.directory, row.suite);
        assert.deepEqual(spans(row.command).filter((span) => span !== entry.directory), entry.commands, row.suite);
        assert.ok(row.prepared.includes(`sdk-input --prepare ${entry.prepare}`), row.suite);
      }
    });
  });

  const MUTATIONS = [
    ['a delivered row\'s command', editLine(text, '`public-gate.yml`', '`npm test`', '`npm run other`')],
    ['a delivered row\'s runtime', editLine(text, '`stdio-mcp.yml`', '20.19.0', '20.19.1')],
    ['a delivered row\'s root', editLine(text, '`http-mcp-tests.yml`', 'in `http-mcp`', 'in `stdio-mcp`')],
    ['a delivered row\'s preparation target', editLine(text, '`stdio-mcp.yml`', 'sdk-input --prepare stdio', 'sdk-input --prepare root')],
    ['a pending row marked delivered', editLine(text, 'Buyer execution suite', PENDING_STAGE, 'delivered')],
    ['a pending row with another owner', editLine(text, 'Checker regression suite', PENDING_STAGE, 'pending: P54a1')],
    ['the buyer-floor build on the floor leg', editLine(text, 'Buyer runtime refusal', 'on the floor leg before refusal tests only', 'on every leg')],
  ];
  for (const [what, mutated] of MUTATIONS) {
    await t.test(`mutating ${what} fails`, () => assert.notDeepEqual(matrixProblems(mutated, texts, roots), []));
  }

  await t.test('deleting a delivered job fails', () => {
    for (const file of ['public-gate.yml', 'http-mcp-tests.yml', 'stdio-mcp.yml']) {
      const { [file]: removed, ...others } = texts;
      assert.ok(removed !== undefined);
      assert.notDeepEqual(matrixProblems(text, others, roots), [], file);
    }
  });

  await t.test('a delivered job that installs before it validates fails', () => {
    const validation = 'node ../scripts/ci/sdk-input.mjs --prepare stdio';
    const moved = texts['stdio-mcp.yml'].replace(`      - run: ${validation}\n`, '').replace('      - run: npm ci', `      - run: npm ci\n      - run: ${validation}\n      - run: npm ci`);
    assert.notDeepEqual(matrixProblems(text, { ...texts, 'stdio-mcp.yml': moved }, roots), []);
  });

  await t.test('a buyer root dropped from the buyer preparation fails', () => {
    assert.notDeepEqual(matrixProblems(text, texts, roots.map((root) => (root.path === 'stdio-mcp' ? { ...root, prepare: ['stdio'] } : root))), []);
  });
});
