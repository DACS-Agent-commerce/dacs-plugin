/**
 * These checks hold .github/workflows/stdio-mcp.yml to these rules:
 *  1. It runs on pull requests that touch stdio-mcp/ or the workflow, and on pushes to any
 *     branch that touch the same paths, but not on tag pushes.
 *  2. A newer run for the same ref cancels the one in progress, for pushes and pull requests.
 *  3. The token has read-only contents permission, set once at the top, and every checkout
 *     runs without persisted credentials.
 *  4. One job on ubuntu-24.04, one leg each for Node 20.19 and 22, fail-fast off, and
 *     setup-node installs the leg's own version. The versions are exact, and the 20.19 leg
 *     is the floor in package.json "engines", not whichever 20.19 patch is newest.
 *  5. The steps are checkout, setup-node, then npm ci --ignore-scripts, typecheck, test and
 *     build in stdio-mcp/, in that order and nothing else.
 *  6. No top-level, job or step key outside the ones it uses, since others could skip a step,
 *     mask a failure or widen access.
 *  7. The npm scripts those steps run are the ones in package.json today, and no project
 *     .npmrc changes how npm runs them.
 *  8. stdio-mcp's Markdown says CI runs only npm commands the workflow runs.
 * The pins themselves are checked in workflow-pins.test.ts.
 *
 * The repo has no YAML parser, so this reads lines. Comments and blank lines go first:
 * YAML ignores a comment's indentation, so a comment must never end a block. Flow
 * mappings, anchors, aliases, tags and block scalars in the job are refused, since lines
 * can't follow them, and so are flow sequences other than the Node matrix and a quote left
 * open at the end of a line. The file must be printable ASCII, since JavaScript and YAML
 * read a BOM, a no-break space or NEL differently.
 *
 * Each requirement is a check that throws at the first problem. settingsProblems() runs
 * them all, and the last test feeds it bad edits of the workflow, so a check that stops
 * refusing one fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORKFLOW = path.join(import.meta.dirname, '../../../.github/workflows/stdio-mcp.yml');
/** Without the CI workflow in the checkout there is nothing to check. CI always has it. */
const skip = !fs.existsSync(WORKFLOW) && !process.env.GITHUB_ACTIONS ? 'without the CI workflow' : false;

/** The workflow's text, and its lines without comments, blank lines or trailing space. */
interface Workflow { text: string; lines: string[] }

function parse(text: string): Workflow {
  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((l) => l !== '');
  return { text, lines };
}

const real = (): Workflow => parse(fs.readFileSync(WORKFLOW, 'utf8'));

const indent = (line: string): number => line.length - line.trimStart().length;

/** The lines under the exact line `header`: those indented deeper, up to the first that is not. */
function block(lines: string[], header: string): string[] {
  const start = lines.indexOf(header);
  assert.ok(start >= 0, `no "${header.trim()}" line`);
  const end = lines.findIndex((l, i) => i > start && indent(l) <= indent(header));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const topBlock = (w: Workflow, key: string): string[] => block(w.lines, `${key}:`);

/** The job's steps, each as its lines with the step indentation and the leading `- ` removed. */
function jobSteps(w: Workflow): string[][] {
  const out: string[][] = [];
  for (const line of block(topBlock(w, 'jobs'), '    steps:')) {
    if (line.startsWith('      - ')) out.push([line.slice(8)]);
    else {
      assert.ok(out.length > 0 && line.startsWith('        '), `not inside a step: ${line.trim()}`);
      out[out.length - 1]!.push(line.slice(8));
    }
  }
  return out;
}

const PATHS = ['    paths:', "      - 'stdio-mcp/**'", "      - '.github/workflows/stdio-mcp.yml'"];
const NODE_VERSIONS = ['20.19.0', '22.23.3'];
const MATRIX = `        node-version: [${NODE_VERSIONS.map((v) => `'${v}'`).join(', ')}]`;

/**
 * The keys the job uses. Others, such as permissions, continue-on-error, if, env or shell,
 * could widen its access or let a failing step pass.
 */
const JOB_KEYS = new Set([
  'test', 'name', 'runs-on', 'timeout-minutes', 'strategy', 'fail-fast', 'matrix', 'node-version', 'defaults',
  'run', 'working-directory', 'steps', 'uses', 'with', 'persist-credentials', 'cache', 'cache-dependency-path',
]);

const CHECKS = {
  triggers(w: Workflow): void {
    // GitHub ignores path filters on tag pushes; listing only branches under push skips tags.
    assert.deepEqual(topBlock(w, 'on'), ['  pull_request:', ...PATHS, '  push:', "    branches: ['**']", ...PATHS]);
  },

  concurrency(w: Workflow): void {
    assert.deepEqual(topBlock(w, 'concurrency'), [
      '  group: ${{ github.workflow }}-${{ github.ref }}',
      '  cancel-in-progress: true',
    ]);
  },

  access(w: Workflow): void {
    assert.deepEqual(topBlock(w, 'permissions'), ['  contents: read']);
    assert.ok(!topBlock(w, 'jobs').some((l) => /permissions/i.test(l)), 'the job or a step sets its own permissions');
    const checkouts = jobSteps(w).filter((s) => s.some((l) => /actions\/checkout/.test(l)));
    assert.ok(checkouts.length > 0, 'no actions/checkout step');
    for (const step of checkouts) {
      // actions/checkout persists the token unless told not to.
      assert.deepEqual(step.filter((l) => /persist-credentials/.test(l)), ['  persist-credentials: false'], step[0]);
      assert.ok(block(step, 'with:').includes('  persist-credentials: false'), step[0]);
    }
  },

  job(w: Workflow): void {
    const jobs = topBlock(w, 'jobs');
    assert.equal(jobs[0], '  test:');
    assert.ok(jobs.slice(1).every((l) => indent(l) >= 4), 'more than one job');
    const keys = jobs.filter((l) => indent(l) === 4).map((l) => l.trim().replace(/:.*$/, ''));
    assert.deepEqual(keys.sort(), ['defaults', 'name', 'runs-on', 'steps', 'strategy', 'timeout-minutes']);
    assert.deepEqual(jobs.filter((l) => /runs-on/.test(l)), ['    runs-on: ubuntu-24.04']);
    // fail-fast: false, so a failing leg doesn't cancel the other.
    assert.deepEqual(block(jobs, '    strategy:'), [
      '      fail-fast: false',
      '      matrix:',
      MATRIX,
    ]);
    assert.deepEqual(jobs.filter((l) => /fail-fast|node-version\s*:/.test(l)), [
      '      fail-fast: false',
      MATRIX,
      '          node-version: ${{ matrix.node-version }}',
    ]);
    // setup-node installs the leg's own version.
    const setupNodes = jobSteps(w).filter((s) => s.some((l) => /actions\/setup-node/.test(l)));
    assert.equal(setupNodes.length, 1, 'not exactly one actions/setup-node step');
    assert.ok(block(setupNodes[0]!, 'with:').includes('  node-version: ${{ matrix.node-version }}'));
  },

  steps(w: Workflow): void {
    const jobs = topBlock(w, 'jobs');
    // The job default is the only working directory, so no step runs anywhere else.
    assert.deepEqual(block(jobs, '    defaults:'), ['      run:', '        working-directory: stdio-mcp']);
    assert.deepEqual(jobs.filter((l) => /working-directory/.test(l)), ['        working-directory: stdio-mcp']);
    // Each step's own keys, in order, with the pinned SHA dropped from uses:.
    const sequence = jobSteps(w).map((s) => s.filter((l) => indent(l) === 0).map((l) => l.replace(/^(uses: \S+)@[0-9a-f]{40}$/, '$1')));
    assert.deepEqual(sequence, [
      ['uses: actions/checkout', 'with:'],
      ['uses: actions/setup-node', 'with:'],
      ['run: npm ci --ignore-scripts --no-audit --no-fund'],
      ['run: npm run typecheck'],
      ['run: npm test'],
      ['run: npm run build'],
    ]);
  },

  keys(w: Workflow): void {
    // JavaScript reads a BOM or a no-break space as whitespace and NEL as neither, so the lines
    // above could differ from what YAML reads.
    assert.ok(!/[^\x20-\x7e\n]/.test(w.text.replace(/\r\n/g, '\n')), 'a character other than printable ASCII, LF or CRLF');
    assert.deepEqual(w.lines.filter((l) => indent(l) === 0), ['name: stdio-mcp', 'on:', 'permissions:', 'concurrency:', 'jobs:']);
    assert.deepEqual(block(w.lines, 'name: stdio-mcp'), [], 'lines under name:');
    // A quoted value left open continues on the next lines and can swallow a line checked above.
    for (const line of w.lines) {
      const bare = line.replace(/\$\{\{.*?\}\}/g, '');
      const count = (s: string, q: string): number => s.split(q).length - 1;
      assert.ok(count(bare.replace(/\\./g, ''), '"') % 2 === 0 && count(bare, "'") % 2 === 0, `a quote left open: ${line.trim()}`);
    }
    for (const line of topBlock(w, 'jobs')) {
      const key = /^\s*(?:-\s+)?([a-z-]+):(?:\s|$)/.exec(line)?.[1];
      assert.ok(key !== undefined && JOB_KEYS.has(key), `not a key this job uses: ${line.trim()}`);
      const bare = line.replace(/\$\{\{.*?\}\}/g, '');
      assert.ok(!/[{}]|(^|\s)[&*!]\S|:\s+[|>][-+0-9]*$/.test(bare), `a flow mapping, anchor, alias, tag or block scalar: ${line.trim()}`);
      // A quote inside a flow sequence's other values can offset the count above.
      assert.ok(line === MATRIX || !/[[\]]/.test(bare), `a flow sequence other than the Node matrix: ${line.trim()}`);
    }
  },
};

/** What each check refuses in a workflow text, as `check: message`; empty if it keeps every setting. */
function settingsProblems(text: string): string[] {
  const w = parse(text);
  const problems: string[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      check(w);
    } catch (e) {
      if (!(e instanceof assert.AssertionError)) throw e;
      problems.push(`${name}: ${e.message.split('\n')[0]}`);
    }
  }
  return problems;
}

test('workflow: runs on pull requests and on pushes to any branch that touch stdio-mcp/, not on tag pushes', { skip }, () => {
  CHECKS.triggers(real());
});

test('workflow: a newer run for the same ref cancels the superseded one, for pushes and pull requests', { skip }, () => {
  CHECKS.concurrency(real());
});

test('workflow: read-only contents permission and every checkout without persisted credentials', { skip }, () => {
  CHECKS.access(real());
});

test('workflow: one job on ubuntu-24.04, one leg each for Node 20.19.0 and 22.23.3, both run to the end', { skip }, () => {
  CHECKS.job(real());
});

test('workflow: the Node legs are exact versions, and the first is the floor in package.json "engines"', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'));
  assert.ok(NODE_VERSIONS.every((v) => /^\d+\.\d+\.\d+$/.test(v)), `not exact versions: ${NODE_VERSIONS.join(', ')}`);
  assert.equal(`>=${NODE_VERSIONS[0]}`, pkg.engines.node);
});

test('workflow: checkout, setup-node, then npm ci --ignore-scripts, typecheck, test and build in stdio-mcp/, and nothing else', { skip }, () => {
  CHECKS.steps(real());
});

test('workflow: no other top-level settings, and no job or step key that could skip a step or mask a failure', { skip }, () => {
  CHECKS.keys(real());
});

test('package.json: the scripts CI runs are the typecheck, unit tests and build, and no project .npmrc changes how npm runs them', () => {
  const dir = path.join(import.meta.dirname, '../..');
  const { scripts } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepEqual([scripts.typecheck, scripts.test, scripts.build], [
    'tsc -p tsconfig.json --noEmit',
    'tsx --test test/unit/*.test.ts',
    'tsc -p tsconfig.json',
  ]);
  // A project .npmrc can set script-shell or node-options, so that every npm run exits 0.
  assert.ok(!fs.existsSync(path.join(dir, '.npmrc')), 'stdio-mcp/.npmrc exists');
});

/**
 * A heuristic for CI claims in prose, not a general English parser. Read sentences across
 * line breaks, then scope negation to the words before each command in its own clause.
 * Keep colons within sentences so a label such as "CI:" applies to the commands after it.
 * Recognise npm commands with or without backticks and direct integration-test CI claims.
 */
function unrunCiClaims(markdown: string, runs: string[]): string[] {
  const out: string[] = [];
  for (const sentence of markdown.split(/\n\s*\n/).flatMap((p) => p.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+/))) {
    if (!/\bCI\b/.test(sentence)) continue;
    for (const clause of sentence.split(/(?:[,;]|\bbut\b|\band(?=\s+CI\b))\s*/i)) {
      for (const m of clause.matchAll(/`(npm (?:ci|test|run [\w:-]+)[^`]*)`|\b(npm (?:ci|test|run [\w:-]+))\b/g)) {
        const before = clause.slice(0, m.index).trimEnd();
        if (/(?:\bnot|n't|\bnever)(?:\s+[\w-]+){0,3}\s*$/i.test(before)) continue;
        const command = m[1] ?? m[2]!;
        if (!runs.some((r) => r === command || r.startsWith(`${command} `))) out.push(command);
      }
      if (/\bintegration tests?\s+(?:also\s+)?runs?\s+in\s+CI\b|\bCI\s+(?:also\s+)?runs?\s+(?:the\s+)?(?:testnet\s+)?integration tests?\b/i.test(clause)
        && !runs.includes('npm run test:integration')) out.push('npm run test:integration');
    }
  }
  return out;
}

/** Include commands and skills too; dependency, generated and Git directories are not docs. */
function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) return markdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

test('docs: stdio-mcp\'s Markdown says CI runs only npm commands the workflow runs', { skip }, () => {
  const runs = jobSteps(real()).flatMap((s) => s.filter((l) => l.startsWith('run: ')).map((l) => l.slice(5)));
  const dir = path.join(import.meta.dirname, '../..');
  const docs = markdownFiles(dir);
  assert.ok(docs.includes(path.join(dir, 'SECURITY.md')), 'no SECURITY.md');
  for (const doc of docs) assert.deepEqual(unrunCiClaims(fs.readFileSync(doc, 'utf8'), runs), [], doc);
});

test('docs: unrelated negation cannot hide a CI claim in another sentence or clause', () => {
  const runs = ['npm ci --ignore-scripts --no-audit --no-fund', 'npm run typecheck', 'npm test', 'npm run build'];
  assert.deepEqual(unrunCiClaims('The verifier runs against the testnet in CI\n(`npm run test:integration`).', runs), ['npm run test:integration']);
  assert.deepEqual(unrunCiClaims('CI does not run `npm run test:integration`. CI runs `npm ci` and `npm test`.', runs), []);
  assert.deepEqual(unrunCiClaims('The verifier runs in CI (`npm run test:integration`). Attestation was not run live.', runs), ['npm run test:integration']);
  assert.deepEqual(unrunCiClaims('CI runs `npm run test:integration` too, so a break is not missed.', runs), ['npm run test:integration']);
  assert.deepEqual(unrunCiClaims('CI does not run `npm run test:integration`, but CI runs `npm run bogus`.', runs), ['npm run bogus']);
  assert.deepEqual(unrunCiClaims('CI does not run npm run test:integration, but CI runs npm run bogus.', runs), ['npm run bogus']);
  assert.deepEqual(unrunCiClaims("CI doesn't run `npm run test:integration` and CI runs `npm test`.", runs), []);
  assert.deepEqual(unrunCiClaims('The testnet integration test runs in CI too.', runs), ['npm run test:integration']);
  assert.deepEqual(unrunCiClaims('CI runs the testnet integration test too.', runs), ['npm run test:integration']);
  assert.deepEqual(unrunCiClaims('The testnet integration test does not run in CI.', runs), []);
  assert.deepEqual(unrunCiClaims('CI does not run the testnet integration test.', runs), []);
});

test('docs: a CI label before a colon keeps its command context', () => {
  const runs = ['npm ci --ignore-scripts --no-audit --no-fund', 'npm run typecheck', 'npm test', 'npm run build'];
  for (const markdown of [
    'CI: npm run bogus',
    'CI: `npm run bogus`.',
    'CI:\n  npm run bogus',
    'CI: runs `npm test`, but also runs `npm run bogus`.',
  ]) assert.deepEqual(unrunCiClaims(markdown, runs), ['npm run bogus'], markdown);
  assert.deepEqual(unrunCiClaims('CI: `npm ci`, `npm run typecheck`, `npm test` and `npm run build`.', runs), []);
  assert.deepEqual(unrunCiClaims('CI: does not run `npm run test:integration`.', runs), []);
  assert.deepEqual(unrunCiClaims('CI: does not run `npm run test:integration`, but runs `npm run bogus`.', runs), ['npm run bogus']);
});

test('docs: Markdown discovery includes nested skills and commands and excludes dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-ci-docs-'));
  try {
    const included = ['SECURITY.md', 'docs/ci.md', 'skills/example/SKILL.md', 'commands/example.md'];
    for (const file of [...included, 'node_modules/example/README.md', 'dist/output.md', '.git/notes.md', 'docs/plain.txt']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'CI runs `npm run bogus`.');
    }
    const docs = markdownFiles(dir).map((file) => path.relative(dir, file).split(path.sep).join('/'));
    assert.deepEqual(docs.sort(), included.sort());
    for (const file of docs) assert.deepEqual(unrunCiClaims(fs.readFileSync(path.join(dir, file), 'utf8'), []), ['npm run bogus']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** [check that must refuse it, what the edit does, text in the workflow, what replaces its first occurrence]. */
const REFUSED: [keyof typeof CHECKS, string, string, string][] = [
  ['triggers', 'a tags filter under push', "    branches: ['**']\n", "    branches: ['**']\n    tags: ['**']\n"],
  ['triggers', 'no branch filter under push, so tags run', "    branches: ['**']\n", ''],
  ['triggers', 'a pull_request_target trigger', '  push:\n', '  pull_request_target:\n  push:\n'],
  ['triggers', 'a tags filter after a column-0 comment', "    branches: ['**']\n", "    branches: ['**']\n# note\n    tags: ['v*']\n"],
  ['concurrency', 'cancel-in-progress: false', '  cancel-in-progress: true\n', '  cancel-in-progress: false\n'],
  ['concurrency', 'a group without the ref', '  group: ${{ github.workflow }}-${{ github.ref }}\n', '  group: ${{ github.workflow }}\n'],
  ['access', 'contents: write', '  contents: read\n', '  contents: write\n'],
  ['access', 'id-token: write', '  contents: read\n', '  contents: read\n  id-token: write\n'],
  ['access', 'job-level permissions', '    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    permissions: write-all\n'],
  ['access', 'job-level permissions after a column-0 comment', '    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n# x\n    permissions:\n      contents: write\n'],
  ['access', 'persist-credentials: true', '          persist-credentials: false\n', '          persist-credentials: true\n'],
  ['access', 'persist-credentials repeated as true', '          persist-credentials: false\n', '          persist-credentials: false\n          persist-credentials: true\n'],
  ['job', 'runs-on: ubuntu-latest', '    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-latest\n'],
  ['job', 'runs-on as a flow sequence', '    runs-on: ubuntu-24.04\n', '    runs-on: [ubuntu-24.04]\n'],
  ['job', 'the 20.19.x range, not the 20.19.0 floor', "'20.19.0'", "'20.19.x'"],
  ['job', 'the 22.x range, not an exact version', "'22.23.3'", "'22.x'"],
  ['job', 'fail-fast: true', '      fail-fast: false\n', '      fail-fast: true\n'],
  ['job', 'continue-on-error on the job', '    timeout-minutes: 20\n', '    timeout-minutes: 20\n    continue-on-error: true\n'],
  ['job', 'if: false on the job', '    timeout-minutes: 20\n', '    timeout-minutes: 20\n    if: false\n'],
  ['steps', 'npm test dropped', '      - run: npm test\n', ''],
  ['steps', 'npm test || true', '      - run: npm test\n', '      - run: npm test || true\n'],
  ['steps', 'a # inside a word before || true', '      - run: npm test\n', '      - run: npm test#|| true\n'],
  ['steps', 'continue-on-error on a step', '      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n'],
  ['steps', '--ignore-scripts dropped', '      - run: npm ci --ignore-scripts --no-audit --no-fund\n', '      - run: npm ci --no-audit --no-fund\n'],
  ['keys', 'checkout of the pull request head', '          persist-credentials: false\n', '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}\n'],
  ['keys', '|| true continued on the next line', '      - run: npm test\n', '      - run: npm test\n          || true\n'],
  ['keys', 'a block scalar run', '      - run: npm test\n', '      - run: |\n          npm test || true\n'],
  ['keys', 'node-version-file for setup-node', '          cache: npm\n', '          cache: npm\n          node-version-file: .nvmrc\n'],
  ['keys', 'registry-url for setup-node', '          cache: npm\n', '          cache: npm\n          registry-url: https://example.com\n'],
  ['keys', 'a mirror for setup-node', '          cache: npm\n', '          cache: npm\n          mirror: https://example.com\n'],
  ['keys', 'a token for setup-node', '          cache: npm\n', '          cache: npm\n          token: ${{ github.token }}\n'],
  ['keys', 'a no-break space hiding || true', '      - run: npm test\n', '      - run: npm test\u00a0#|| true\n'],
  ['keys', 'a tab-indented if: false', '      - run: npm test\n', '      - run: npm test\n\t  if: false\n'],
  ['keys', 'a BOM-indented top-level env', 'name: stdio-mcp\n', '\ufeffenv:\n  X: 1\nname: stdio-mcp\n'],
  ['keys', 'a double quote left open over the next step', '      - run: npm run typecheck\n      - run: npm test\n', '      - run: "npm run typecheck\n      - run: npm test"\n'],
  ['keys', 'a single quote left open over persist-credentials', '          persist-credentials: false\n', "          cache: 'x\n          persist-credentials: false\n          cache-dependency-path: y'\n"],
  ['keys', 'a flow sequence whose quotes offset the count', '          persist-credentials: false\n', "          cache: [\"'\", 'x\n          persist-credentials: false\n          cache-dependency-path: y', \"'\"]\n"],
  ['keys', 'a second YAML document', '      - run: npm run build\n', '      - run: npm run build\n---\nfoo: bar\n'],
  ['keys', 'a top-level run-name', 'name: stdio-mcp\n', 'name: stdio-mcp\nrun-name: x\n'],
  ['keys', 'a top-level defaults.run.shell', 'permissions:\n', "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\npermissions:\n"],
];

function checkRefusalFixtures(workflow: string): void {
  assert.deepEqual(settingsProblems(workflow), []);
  const text = workflow.replace(/\r\n/g, '\n');
  for (const [check, what, from, to] of REFUSED) {
    assert.ok(text.includes(from), `${what}: no ${JSON.stringify(from)} in the workflow`);
    const problems = settingsProblems(text.replace(from, () => to));
    assert.ok(problems.some((p) => p.startsWith(`${check}: `)), `${what}: not refused by the ${check} check, only ${JSON.stringify(problems)}`);
  }
}

test('workflow: the settings checks accept LF and CRLF and each refuses its bad edits', { skip }, () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  checkRefusalFixtures(text);
  checkRefusalFixtures(text.replace(/\r?\n/g, '\r\n'));
});
