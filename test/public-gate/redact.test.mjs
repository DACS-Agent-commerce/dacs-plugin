import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DIAGNOSTIC_ROUTES } from '../../scripts/public-gate/redact.mjs';
import {
  REPO_ROOT, ROOT_COMMIT, cleanScannerArgs, completeArgs, createRepo, expectedScanIdentity, expectedWordingListSha256, makeTempDir, runCheckReport, runGate, writeList,
} from '../lib/gate-fixtures.mjs';

const PRIVATE_VALUE = ['onyx', 'meridian'].join('-');
const AWKWARD_PATH = `has space/${PRIVATE_VALUE}\nline.txt`;
const DIAGNOSTIC_DIRS = ['scripts/public-gate', 'scripts/ci'];
const EMITTER_FILE = path.join('scripts', 'public-gate', 'redact.mjs');
const OUTPUT_SINK = /\bconsole\.|process\.std(?:out|err)\b|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync)\b/;
// Exact-byte export and materialization writers are data writes, not diagnostics; later cards list theirs here.
const EXACT_BYTE_WRITERS = [path.join('scripts', 'public-gate', 'secret-scan.mjs')];
// The eval parser child answers its parent on stdout with line numbers and fixed cause names only; its error text goes through the emitter.
const PARENT_PIPE_WRITERS = [path.join('scripts', 'public-gate', 'rules-eval-child.mjs')];

function sourceFiles(dir) {
  const full = path.join(REPO_ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return relative.endsWith('.mjs') ? [relative] : [];
  });
}

const leaksNothing = (...texts) => texts.forEach((text) => assert.ok(!text.toLowerCase().includes(PRIVATE_VALUE), 'private value leaked'));
/** Writes `value` as JSON to a new file whose name holds the private value, so a leaked path would show. */
function writeJsonFile(value) {
  const file = path.join(makeTempDir('check-input'), `${PRIVATE_VALUE}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}
const leakRepo = () => createRepo([{ path: AWKWARD_PATH, content: `line one\n${PRIVATE_VALUE}\n` }]);

/** A PATH folder whose git writes `stderr` and exits 128 for `rev-parse`, and runs the real git otherwise. */
function gitFailingWith(stderr) {
  const binDir = makeTempDir('fake-git');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\ncase "$*" in *rev-parse*) printf '%s' '${stderr}' >&2; exit 128;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(path.join(binDir, 'git'), 0o755);
  return { PATH: `${binDir}:${process.env.PATH}` };
}

const INSTALLER = path.join(REPO_ROOT, 'scripts', 'ci', 'install-gitleaks.mjs');
const SDK_INPUT = path.join(REPO_ROOT, 'scripts', 'ci', 'sdk-input.mjs');
const EVAL_CHILD = path.join(REPO_ROOT, 'scripts', 'public-gate', 'rules-eval-child.mjs');
const REGISTERED_CAUSE_SOURCES = ['scripts/lib/fetch-bounded.mjs', 'scripts/lib/run-bounded.mjs', 'scripts/ci/install-gitleaks.mjs'];
const HELPER_CAUSE = /'((?:download|subprocess|install)-[a-z-]+|unsupported-platform)'/g;

/** A checkout whose stdio manifest names the private value in an SDK spec, a refused local path. */
function sdkInputCheckout() {
  const dir = makeTempDir('sdk-input-leak');
  for (const root of ['.', 'http-mcp', 'http-mcp/wallet-build', 'stdio-mcp']) {
    mkdirSync(path.join(dir, root), { recursive: true });
    const dependencies = root === 'stdio-mcp' ? { '@kynesyslabs/demosdk': `file:../${PRIVATE_VALUE}` } : {};
    writeFileSync(path.join(dir, root, 'package.json'), JSON.stringify({ dependencies }));
    writeFileSync(path.join(dir, root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies } } }));
  }
  return dir;
}

const scenarios = {
  'test-all.stdout': () => {
    const checkout = sdkInputCheckout();
    cpSync(path.join(REPO_ROOT, 'scripts'), path.join(checkout, 'scripts'), { recursive: true });
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts', 'ci', 'test-all.mjs')], { cwd: checkout, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^test-all: stdio typecheck and unit tests: fail \(sdk-input-refused\)$/m);
    leaksNothing(result.stdout, result.stderr);
  },
  'sdk-input.stdout': () => {
    const result = spawnSync(process.execPath, [SDK_INPUT, '--repo', sdkInputCheckout(), '--prepare', 'stdio'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).roots.find(({ root }) => root === 'stdio-mcp').cause, 'local-path-spec');
    leaksNothing(result.stdout, result.stderr);
  },
  'sdk-input.stderr': () => {
    const result = spawnSync(process.execPath, [SDK_INPUT, '--prepare', PRIVATE_VALUE], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'invalid-choice: a choice is not one of its allowed values\n');
    leaksNothing(result.stdout, result.stderr);
  },
  'gate.stdout': () => {
    const repo = leakRepo();
    const result = runGate(completeArgs(repo, writeList([PRIVATE_VALUE])));
    leaksNothing(result.stdout, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).findings, [
      { rule: 'R-PRIVATE', kind: 'content', location: `${repo.commit}:1`, line: 2 },
      { rule: 'R-PRIVATE', kind: 'path', location: `${repo.commit}:1` },
    ]);
  },
  'gate.report-file': () => {
    const out = path.join(makeTempDir('out'), 'report.json');
    const result = runGate(completeArgs(leakRepo(), writeList([PRIVATE_VALUE]), ['--out', out]));
    assert.equal(result.status, 1);
    leaksNothing(readFileSync(out, 'utf8'), result.stdout, result.stderr);
  },
  'gate.stderr': () => {
    const repo = leakRepo();
    const result = runGate(completeArgs(repo, writeList([PRIVATE_VALUE])), { env: gitFailingWith(`fatal: ${'x'.repeat(1012)}/${PRIVATE_VALUE}`) });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^git-refused: git refused the request$/m);
    leaksNothing(result.stdout, result.stderr);
    assert.ok(!result.stderr.includes(PRIVATE_VALUE.slice(0, 4)) && !result.stderr.includes('fatal'));
  },
  'install-gitleaks.stderr': async () => {
    // The installer refuses any platform but its pinned archive's before it touches the folder, so the cause depends on where this runs.
    const { GITLEAKS_PIN } = await import('../../scripts/ci/install-gitleaks.mjs');
    const pinned = process.platform === GITLEAKS_PIN.platform && process.arch === GITLEAKS_PIN.arch;
    const blocker = path.join(makeTempDir('install-blocker'), PRIVATE_VALUE);
    writeFileSync(blocker, 'a file where a folder is needed\n');
    const result = spawnSync(process.execPath, [INSTALLER, '--dir', path.join(blocker, 'bin')], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, pinned ? 'install-dir-unwritable: the install folder cannot be prepared\n' : 'unsupported-platform: the pinned gitleaks archive is not for this platform\n');
    leaksNothing(result.stdout, result.stderr);
  },
  'rules-eval-child.stderr': () => {
    const result = spawnSync(process.execPath, [EVAL_CHILD], { input: `{"units": "${PRIVATE_VALUE}`, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'eval-parser-failed: the eval parser stopped with an error status or wrote an unexpected result\n');
    leaksNothing(result.stdout, result.stderr);
  },
  'check-report.stderr': () => {
    const repo = leakRepo();
    const report = JSON.parse(runGate(completeArgs(repo, writeList([PRIVATE_VALUE]))).stdout);
    const context = { gateRevision: report.scanner.gateRevision, configSha256: report.scanner.configSha256, ...expectedScanIdentity(), expectedRoot: repo.commit, wordingListSha256: expectedWordingListSha256() };
    const inputs = [
      [{ ...report, rules: [{ id: PRIVATE_VALUE, status: 'passed' }] }, 'report-rules-differ', 1],
      [{ ...report, rules: [{ id: PRIVATE_VALUE, status: PRIVATE_VALUE }] }, 'report-malformed', 2],
      [{ ...report, [PRIVATE_VALUE]: PRIVATE_VALUE }, 'report-malformed', 2],
      [report, 'report-not-passing', 1],
    ];
    for (const [input, cause, status] of inputs) {
      const result = runCheckReport(['--report', writeJsonFile(input), '--head', repo.commit, '--context', writeJsonFile(context)]);
      assert.equal(result.status, status);
      assert.match(result.stderr, new RegExp(`^${cause}: [^\\n]+\\n$`));
      leaksNothing(result.stdout, result.stderr);
    }
    const unreadable = runCheckReport(['--report', path.join(makeTempDir('check-input'), PRIVATE_VALUE), '--head', repo.commit, '--context', writeJsonFile(context)]);
    assert.match(unreadable.stderr, /^report-unreadable: /);
    leaksNothing(unreadable.stdout, unreadable.stderr);
  },
};

test('at this PR: gate `--scope` and the gate\'s own routes; later owners add their rows. A private value in a path, including one with spaces or a newline, appears in no report field, stdout or stderr record; the finding keeps rule id, location identifier, line and cause; the exact mapping is only in the private evidence file; one table enumerates the diagnostic routes; a static route check rejects direct console.*, process.std*.write or diagnostic writeFile sinks outside the emitter; stderr carries only a cause and its fixed text', async (t) => {
  await t.test('the route table holds exactly the routes this PR registers, each with a runtime scenario', () => {
    assert.deepEqual(Object.keys(DIAGNOSTIC_ROUTES).sort(), Object.keys(scenarios).sort());
  });

  for (const [route, scenario] of Object.entries(scenarios)) {
    await t.test(`a runtime-built list value does not reach ${route}`, scenario);
  }

  await t.test('every cause the download, subprocess and installer code can raise has a fixed diagnostic text', () => {
    const emitter = readFileSync(path.join(REPO_ROOT, EMITTER_FILE), 'utf8');
    const causes = REGISTERED_CAUSE_SOURCES.flatMap((file) => [...readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(HELPER_CAUSE)].map(([, cause]) => cause));
    assert.ok(causes.length >= 15, `found only ${causes.length} causes`);
    for (const cause of causes) assert.ok(emitter.includes(`'${cause}':`), `${cause} has no diagnostic text`);
  });

  await t.test('no diagnostic sink exists outside the emitter', () => {
    const sinks = DIAGNOSTIC_DIRS.flatMap(sourceFiles)
      .filter((file) => file !== EMITTER_FILE && !EXACT_BYTE_WRITERS.includes(file) && !PARENT_PIPE_WRITERS.includes(file))
      .filter((file) => OUTPUT_SINK.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')));
    assert.deepEqual(sinks, []);
  });

  await t.test('a huge or malformed argument gives one bounded cause line and no echo', () => {
    const cases = [
      [['--repo', 'm'.repeat(70_000), '--commit', ROOT_COMMIT, '--scope', 'generic', ...cleanScannerArgs()], 'git-refused: git refused the request'],
      [['--repo', 'r', '--commit', ROOT_COMMIT, '--scope', 'm'.repeat(70_000)], 'oversized-choice: a choice value is too long'],
      [['--repo', 'r', '--commit', 'HEAD', '--scope', 'generic', ...cleanScannerArgs()], 'bad-arguments: the arguments are malformed (see docs/PUBLIC-GATE.md)'],
      [['stray'], 'bad-arguments: the arguments are malformed (see docs/PUBLIC-GATE.md)'],
    ];
    for (const [args, line] of cases) {
      const result = runGate(args);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.split('\n').includes(line), result.stderr.slice(0, 200));
      assert.ok(!result.stderr.includes('mmmm') && !result.stderr.includes('HEAD'));
    }
    const missingRepo = runGate(['--repo', path.join(makeTempDir('missing'), AWKWARD_PATH), '--commit', ROOT_COMMIT, '--scope', 'generic', ...cleanScannerArgs()]);
    assert.match(missingRepo.stderr, /^git-refused: git refused the request$/m);
    leaksNothing(missingRepo.stderr);
  });
});

test('the private evidence is the only output holding the exact path, is owner-only and is never overwritten', () => {
  const repo = leakRepo();
  const evidence = path.join(makeTempDir('evidence'), 'mapping.json');
  const list = writeList([PRIVATE_VALUE]);
  const previousMask = process.umask(0o022);
  try {
    const result = runGate(completeArgs(repo, list, ['--private-evidence', evidence]));
    assert.equal(result.status, 1);
    leaksNothing(result.stdout, result.stderr);
  } finally {
    process.umask(previousMask);
  }
  assert.equal(statSync(evidence).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), { [`${repo.commit}:1`]: AWKWARD_PATH });
  const again = runGate(completeArgs(repo, list, ['--private-evidence', evidence]));
  assert.equal(again.status, 2);
  assert.match(again.stderr, /^evidence-exists: /m);
  assert.equal(JSON.parse(readFileSync(evidence, 'utf8'))[`${repo.commit}:1`], AWKWARD_PATH);
  assert.equal(runGate(['--repo', repo.dir, '--commit', repo.commit, '--scope', 'generic', ...cleanScannerArgs(), '--private-evidence', evidence]).status, 2);
});

test('the evidence is written only after the report: a refused report destination leaves no evidence, and a failed evidence write exits 2', () => {
  const repo = leakRepo();
  const list = writeList([PRIVATE_VALUE]);
  const dir = makeTempDir('destinations');
  const existing = path.join(dir, 'existing.json');
  writeFileSync(existing, 'kept\n');
  for (const [out, cause] of [[existing, 'output-exists'], [path.join(dir, 'missing', 'report.json'), 'output-unwritable']]) {
    const evidence = path.join(dir, `${cause}-evidence.json`);
    const result = runGate(completeArgs(repo, list, ['--out', out, '--private-evidence', evidence]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`^${cause}: `, 'm'));
    assert.ok(!existsSync(evidence), `${cause} left evidence`);
  }
  assert.equal(readFileSync(existing, 'utf8'), 'kept\n');
  const failed = runGate(completeArgs(repo, list, ['--private-evidence', path.join(dir, 'missing', 'evidence.json')]));
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /^evidence-unwritable: /m);
});

test('the report file and the private evidence file must be different files, however the path is spelled, and nothing is written', () => {
  const repo = leakRepo();
  const list = writeList([PRIVATE_VALUE]);
  const dir = makeTempDir('destinations');
  const linkedDir = path.join(makeTempDir('destination-link'), 'link');
  symlinkSync(dir, linkedDir);
  const spellings = [
    [path.join(dir, 'same.json'), path.join(dir, 'same.json')],
    [path.join(dir, 'dot.json'), path.join(dir, '.', 'sub', '..', 'dot.json')],
    [path.join(dir, 'link.json'), path.join(linkedDir, 'link.json')],
  ];
  for (const [out, evidence] of spellings) {
    const result = runGate(completeArgs(repo, list, ['--out', out, '--private-evidence', evidence]));
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^bad-arguments: /m);
    assert.equal(result.stdout, '');
    leaksNothing(result.stdout, result.stderr);
    assert.deepEqual(readdirSync(dir), []);
  }
});
