import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../scripts/public-gate/gate.mjs';
import { GateInputError, readCommitObjects } from '../../scripts/public-gate/objects.mjs';
import { SECRET_RULE_ID, scanSecrets } from '../../scripts/public-gate/secret-scan.mjs';
import { REPO_ROOT, createRepo, gateArgs, runGate, sha256 } from '../lib/gate-fixtures.mjs';
import { findPinnedGitleaks, writeStubGitleaks } from '../lib/stub-gitleaks.mjs';

const CONFIG = loadConfig();
const POLICY_FILE = path.join(REPO_ROOT, '.gitleaks.toml');
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SAMPLE_RULE = 'generic-api-key';
const MARKER = ['marker', 'value'].join('-');

/** A GitHub-token-shaped value built at run time, so no key-shaped literal is committed. */
const plantedKey = () => `${['ghp', '_'].join('')}${Array.from(randomBytes(36), (byte) => BASE62[byte % BASE62.length]).join('')}`;
const readEntries = async (repo) => (await readCommitObjects({ repo: repo.dir, commit: repo.commit, limits: CONFIG.limits })).entries;
const withLimits = (limits, config = CONFIG) => ({ ...config, limits: { ...config.limits, ...limits } });
const scan = async (repo, stub, config = CONFIG) => scanSecrets({ entries: await readEntries(repo), config, scanner: { binary: stub.binary, sha256: stub.sha256 } });
const rejectsWith = (promise, cause) => assert.rejects(promise, (error) => error instanceof GateInputError && error.cause === cause);
const foundPaths = (findings) => findings.map(({ entry }) => entry.path).sort();
const scanCalls = (stub) => stub.calls().filter((call) => call.args[0] === 'dir');
const markerStub = (settings = {}) => writeStubGitleaks({ finds: [{ marker: MARKER, rule: SAMPLE_RULE, line: 1 }], ...settings });
const exemption = (entries, filePath, line = 1) => ({ path: filePath, blob: entries.find((entry) => entry.path === filePath).oid, rule: SAMPLE_RULE, line, reason: 'test occurrence' });

test('the wrapper writes each distinct blob of the target tree once from Git objects under a neutral name in a fresh directory, keeps the exact mapping to every occurrence, runs the pinned gitleaks in dir mode with redaction, --ignore-gitleaks-allow and the run\'s own config and trusted run-owned ignore passed explicitly, and fails on a finding', async (t) => {
  const repo = createRepo([
    { path: 'a.txt', content: `${MARKER}\n` }, { path: 'copy/a-again.txt', content: `${MARKER}\n` }, { path: 'link', content: 'a.txt', mode: '120000' },
    { path: 'other.txt', content: 'other\n' }, { path: '.gitleaks.toml', content: '# a policy the target ships\n' },
  ]);
  await t.test('the scanner gets neutral names, the run\'s own config and an empty run-owned ignore', async () => {
    const stub = writeStubGitleaks();
    assert.deepEqual(await scan(repo, stub), []);
    const [call] = scanCalls(stub);
    const contents = ['a.txt', `${MARKER}\n`, 'other\n', '# a policy the target ships\n'];
    assert.deepEqual(Object.values(call.blobs).sort(), contents.map(sha256).sort(), 'one file per distinct blob, holding the exact bytes');
    assert.ok(Object.keys(call.blobs).every((name) => /^b\d+$/.test(name)));
    for (const flag of ['dir', '--redact=100', '--ignore-gitleaks-allow', '--config', '--gitleaks-ignore-path']) assert.ok(call.args.includes(flag), flag);
    assert.equal(call.configSha256, sha256(readFileSync(POLICY_FILE)), 'the policy is the gate\'s, not the target\'s');
    assert.equal(call.ignore, '');
    assert.equal(existsSync(call.cwd), false, 'the fresh directory is removed');
    assert.notEqual(call.self, stub.binary, 'a private copy runs, not the path it was given');
  });
  await t.test('a finding is reported for every occurrence of its blob, by position, without the path in the report', async () => {
    const findings = await scan(repo, markerStub());
    assert.deepEqual(foundPaths(findings), ['a.txt', 'copy/a-again.txt']);
    assert.deepEqual(findings.map(({ rule, kind, line }) => [rule, kind, line]), [[SECRET_RULE_ID, 'content', 1], [SECRET_RULE_ID, 'content', 1]]);
  });
  await t.test('the gate exits 1 with R-SECRET and names no path', () => {
    const stub = markerStub();
    const result = runGate(gateArgs(repo, 'generic', ['--gitleaks', stub.binary, '--gitleaks-sha256', stub.sha256]));
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.rules.find(({ id }) => id === SECRET_RULE_ID).status, 'findings');
    assert.ok(!result.stdout.includes('a-again'));
    assert.deepEqual(Object.keys(report.scanner).sort(), ['configSha256', 'gateRevision', 'scannerPolicySha256', 'scannerVersion', 'secretExceptionsSha256']);
  });
});

test('a missing binary, another version or a checksum mismatch fails before scanning', async () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const entries = await readEntries(repo);
  const run = (scanner) => scanSecrets({ entries, config: CONFIG, scanner });
  const other = writeStubGitleaks({ version: '8.0.0' });
  await rejectsWith(run({ binary: path.join(REPO_ROOT, 'no-such-dir', 'gitleaks'), sha256: sha256('x') }), 'scanner-missing');
  await rejectsWith(run({ binary: other.binary, sha256: other.sha256 }), 'scanner-version-mismatch');
  assert.deepEqual(scanCalls(other), []);
  const stub = writeStubGitleaks();
  await rejectsWith(run({ binary: stub.binary, sha256: sha256('not the binary') }), 'scanner-checksum-mismatch');
  assert.deepEqual(stub.calls(), [], 'a binary that fails its checksum is never executed');
});

test('a scan past its deadline is killed with its process group and fails with a timeout cause; oversized output fails as unscannable', async () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const hanging = writeStubGitleaks({ hang: true });
  await rejectsWith(scan(repo, hanging, withLimits({ secretScanDeadlineMs: 500 })), 'subprocess-timeout');
  const [hung] = scanCalls(hanging);
  assert.equal(existsSync(hung.cwd), false, 'the fresh directory is removed after a kill');
  await rejectsWith(scan(repo, writeStubGitleaks({ flood: true }), withLimits({ secretScanOutputBytes: 1024 })), 'subprocess-output-limit');
});

test('a scanner failure status, an oversized, malformed or inconsistent report, and a finding in an unknown file all fail closed with their own cause', async (t) => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const cases = [
    ['scanner-failed', { exitCode: 1 }, CONFIG],
    ['scanner-report-malformed', { exitCode: 3 }, CONFIG],
    ['scanner-report-malformed', { rawReport: 'not json' }, CONFIG],
    ['scanner-report-malformed', { rawReport: '{}' }, CONFIG],
    ['scanner-report-malformed', { rawReport: JSON.stringify([{ File: 'b1', RuleID: SAMPLE_RULE, StartLine: 1 }]), exitCode: 0 }, CONFIG],
    ['scanner-report-malformed', { rawReport: JSON.stringify([{ File: 'elsewhere', RuleID: SAMPLE_RULE, StartLine: 1 }]), exitCode: 3 }, CONFIG],
    ['limit:maxScanReportBytes', { rawReport: `[${' '.repeat(2048)}]`, exitCode: 0 }, withLimits({ maxScanReportBytes: 1024 })],
    ['limit:maxReportEntries', { rawReport: JSON.stringify(Array(3).fill({ File: 'b1', RuleID: SAMPLE_RULE, StartLine: 1 })), exitCode: 3 }, withLimits({ maxReportEntries: 2 })],
  ];
  for (const [cause, settings, config] of cases) {
    await t.test(`${cause}: ${JSON.stringify(settings).slice(0, 60)}`, () => rejectsWith(scan(repo, writeStubGitleaks(settings), config), cause));
  }
});

test('a baseline blob with an occurrence the ruling does not cover keeps its scanner finding; a fully covered one is ignored under its neutral name', async (t) => {
  const generated = createRepo([{ path: 'gen.js', content: `${MARKER}\n` }]);
  const baseline = async (repo) => [{ ...exemption(await readEntries(repo), 'gen.js', 1), reason: 'reviewed baseline' }];
  await t.test('every occurrence covered: the ignore holds the remapped entry and the occurrence is exempt', async () => {
    const stub = markerStub();
    const config = { ...CONFIG, secretBaseline: await baseline(generated) };
    assert.deepEqual(await scan(generated, stub, config), []);
    const [call] = scanCalls(stub);
    assert.equal(call.ignore, `${Object.keys(call.blobs)[0]}:${SAMPLE_RULE}:1\n`);
  });
  await t.test('a copy at another path: no scanner-level ignore, the copy still fails', async () => {
    const copied = createRepo([{ path: 'gen.js', content: `${MARKER}\n` }, { path: 'copy.js', content: `${MARKER}\n` }]);
    const stub = markerStub();
    const findings = await scan(copied, stub, { ...CONFIG, secretBaseline: await baseline(copied) });
    assert.equal(scanCalls(stub)[0].ignore, '');
    assert.deepEqual(foundPaths(findings), ['copy.js']);
  });
  await t.test('a changed blob at the baseline path is not covered', async () => {
    const changed = createRepo([{ path: 'gen.js', content: `${MARKER}\nchanged\n` }]);
    const findings = await scan(changed, markerStub(), { ...CONFIG, secretBaseline: await baseline(generated) });
    assert.deepEqual(foundPaths(findings), ['gen.js']);
  });
});

test('an exception names one occurrence and a stale one fails before the scanner starts', async (t) => {
  const lateMarker = 'second-text';
  const repo = createRepo([
    { path: 'one.js', content: `${MARKER}\n` }, { path: 'two.js', content: `${MARKER}\n` }, { path: 'three.js', content: `${MARKER}\nmore\n` },
    { path: 'four.js', content: `x\n${lateMarker}\n` },
  ]);
  const entries = await readEntries(repo);
  const stub = markerStub({ finds: [{ marker: MARKER, rule: SAMPLE_RULE, line: 1 }, { marker: lateMarker, rule: SAMPLE_RULE, line: 2 }] });
  await t.test('only the named path and blob is exempt; the same blob elsewhere and another blob still fail', async () => {
    const config = { ...CONFIG, secretExceptions: [exemption(entries, 'one.js')] };
    assert.deepEqual(foundPaths(await scan(repo, stub, config)), ['four.js', 'three.js', 'two.js']);
  });
  await t.test('an entry for another line or another rule exempts nothing', async () => {
    for (const wrong of [{ line: 2 }, { rule: 'other-rule' }]) {
      const config = { ...CONFIG, secretExceptions: [{ ...exemption(entries, 'one.js'), ...wrong }] };
      assert.deepEqual(foundPaths(await scan(repo, stub, config)), ['four.js', 'one.js', 'three.js', 'two.js']);
    }
  });
  await t.test('an entry for a path or blob the target does not hold is stale', async () => {
    const calls = stub.calls().length;
    const gone = { ...exemption(entries, 'one.js'), path: 'gone.js' };
    const moved = { ...exemption(entries, 'one.js'), blob: 'a'.repeat(40) };
    for (const entry of [gone, moved]) await rejectsWith(scan(repo, stub, { ...CONFIG, secretExceptions: [entry] }), 'stale-secret-exception');
    assert.equal(stub.calls().length, calls, 'the scanner was not started');
  });
});

const realScanner = findPinnedGitleaks();
const needsRealScanner = (t) => {
  if (realScanner) return false;
  assert.ok(!process.env.CI, 'CI must provide the pinned gitleaks (GITLEAKS_BIN or PATH)');
  t.skip('the pinned gitleaks is not installed here');
  return true;
};
const scanReal = async (repo, config = CONFIG) => scan(repo, realScanner, config);

test('real scanner: a key-shaped value built at test time is found in the target tree in an ordinary file, in a valid package-lock.json, in a file named .gitleaks.toml, beside a gitleaks:allow comment, in a file marked export-ignore and -diff, and in an export-subst file; a policy or ignore file inside the target changes nothing; in CI the test refuses to skip without the binary', async (t) => {
  if (needsRealScanner(t)) return;
  const keyed = (extra = '') => `const token = "${plantedKey()}";${extra}\n`;
  const lock = JSON.stringify({ name: 'planted', lockfileVersion: 3, packages: { '': { name: 'planted', description: plantedKey() } } }, null, 2);
  const planted = {
    'src/app.js': keyed(), 'package-lock.json': lock, 'config/.gitleaks.toml': keyed(), 'src/allowed.js': keyed(' // gitleaks:allow'),
    'src/hidden.txt': keyed(), 'src/subst.txt': `$Format:%H$\n${keyed()}`, 'vendor/node_modules/pkg/index.js': keyed(),
  };
  const repo = createRepo([
    ...Object.entries(planted).map(([file, content]) => ({ path: file, content })),
    { path: '.gitattributes', content: 'src/hidden.txt export-ignore -diff\nsrc/subst.txt export-subst\n' },
    { path: '.gitleaks.toml', content: '[allowlist]\nregexes = [\'\'\'.*\'\'\']\npaths = [\'\'\'.*\'\'\']\n' },
    { path: '.gitleaksignore', content: Object.keys(planted).flatMap((file) => [1, 2].map((line) => `${file}:github-pat:${line}`)).join('\n') },
  ]);
  assert.deepEqual(foundPaths(await scanReal(repo)), Object.keys(planted).sort());
});

test('real scanner: an exact secretExceptions entry exempts only its own occurrence; the same value at another path, in another blob or on another line still fails; an entry naming no occurrence of the target is reported as stale; F\'s two non-secret groups alone yield zero scanner findings under the trusted remapped ignore, while copied bytes at another path, a changed blob/line, or an altered target .gitleaksignore cannot enlarge that ruling', async (t) => {
  if (needsRealScanner(t)) return;
  const line = `const token = "${plantedKey()}";\n`;
  const repo = createRepo([
    { path: 'one.js', content: line }, { path: 'two.js', content: line }, { path: 'three.js', content: `${line}// other blob\n` }, { path: 'four.js', content: `// shifted\n${line}` },
  ]);
  const entries = await readEntries(repo);
  const exempt = { ...exemption(entries, 'one.js'), rule: 'github-pat' };
  assert.deepEqual(foundPaths(await scanReal(repo, { ...CONFIG, secretExceptions: [exempt] })), ['four.js', 'three.js', 'two.js']);
  await rejectsWith(scanReal(repo, { ...CONFIG, secretExceptions: [{ ...exempt, path: 'gone.js' }] }), 'stale-secret-exception');

  const blobBytes = (blob) => execFileSync('git', ['-C', REPO_ROOT, 'cat-file', 'blob', blob]);
  const baselineFiles = CONFIG.secretBaseline.map((entry) => ({ path: entry.path, content: blobBytes(entry.blob) }));
  assert.deepEqual(await scanReal(createRepo(baselineFiles)), [], 'F\'s two groups alone give zero findings');
  const copied = createRepo([...baselineFiles, ...baselineFiles.map(({ path: file, content }) => ({ path: `copy/${file}`, content }))]);
  const copyFindings = foundPaths(await scanReal(copied));
  assert.ok(copyFindings.length > 0 && copyFindings.every((file) => file.startsWith('copy/')), 'only the copies fail');
  const changed = createRepo(baselineFiles.map(({ path: file, content }) => ({ path: file, content: Buffer.concat([Buffer.from('// first line\n'), content]) })));
  assert.ok((await scanReal(changed)).length > 0, 'a changed blob and shifted lines are not covered');
  const ignoring = createRepo([...baselineFiles, { path: 'extra.js', content: line }, { path: '.gitleaksignore', content: 'extra.js:github-pat:1\nb1:github-pat:1\n' }]);
  assert.deepEqual(foundPaths(await scanReal(ignoring)), ['extra.js']);
});
