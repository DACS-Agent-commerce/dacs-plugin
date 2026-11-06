import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../scripts/public-gate/gate.mjs';
import { GateInputError, readCommitObjects } from '../../scripts/public-gate/objects.mjs';
import { hasValidSecretConfig, PATH_GATED_RULES, SECRET_RULE_ID, scanSecrets } from '../../scripts/public-gate/secret-scan.mjs';
import { REPO_ROOT, completeArgs, createRepo, gateArgs, makeTempDir, runGate, sha256, writeList } from '../lib/gate-fixtures.mjs';
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
const markerStub = (settings = {}) => writeStubGitleaks({ finds: [{ marker: MARKER, rule: SAMPLE_RULE }], ...settings });
const exemption = (entries, filePath, line = 1) => ({ path: filePath, blob: entries.find((entry) => entry.path === filePath).oid, rule: SAMPLE_RULE, line, reason: 'test occurrence' });

test('the wrapper writes each distinct blob of the target tree once from Git objects under a neutral name in a fresh directory, keeps the exact mapping to every occurrence, runs the pinned gitleaks in dir mode with redaction, --ignore-gitleaks-allow and the run\'s own config and trusted run-owned ignore passed explicitly, and fails on a finding', async (t) => {
  const repo = createRepo([
    { path: 'a.txt', content: `${MARKER}\n` }, { path: 'copy/a-again.txt', content: `${MARKER}\n` }, { path: 'link', content: 'a.txt', mode: '120000' },
    { path: 'other.txt', content: 'other\n' }, { path: '.gitleaks.toml', content: '# a policy the target ships\n' },
  ]);
  await t.test('the scanner gets one neutral name per occurrence, each blob written once, the run\'s own config and an empty run-owned ignore', async () => {
    const stub = writeStubGitleaks();
    assert.deepEqual(await scan(repo, stub), []);
    const [call] = scanCalls(stub);
    const entries = await readEntries(repo);
    assert.deepEqual(Object.keys(call.blobs).sort(), entries.map(({ position }) => `o${position}`).sort(), 'one name per occurrence, by position');
    for (const entry of entries) assert.equal(call.blobs[`o${entry.position}`], sha256(entry.bytes), 'each name holds its occurrence\'s exact bytes');
    const inodeOf = (file) => call.inodes[`o${entries.find((entry) => entry.path === file).position}`];
    assert.equal(inodeOf('a.txt'), inodeOf('copy/a-again.txt'), 'two occurrences of one blob are links to one written file');
    assert.equal(new Set(Object.values(call.inodes)).size, 4, 'one written file per distinct blob');
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

test('every blob is written behind a one-line text header that spans every fixed offset a file-type check reads, a short one unless the blob can reach offset 32769; findings count lines from the blob\'s own first line, and one on the header line fails closed', async (t) => {
  const small = '#!/bin/sh\n';
  const large = `${'x'.repeat(40_000)}\n`;
  const marked = `first\n${MARKER}\n`;
  const repo = createRepo([{ path: 'small.txt', content: small }, { path: 'large.txt', content: large }, { path: 'marked.txt', content: marked }]);
  await t.test('the header is one line of 262 bytes for a small blob and 32774 for a blob that can reach the ISO check', async () => {
    const stub = writeStubGitleaks();
    await scan(repo, stub);
    const [call] = scanCalls(stub);
    const headerOf = (content) => call.headers[Object.keys(call.blobs).find((name) => call.blobs[name] === sha256(content))];
    assert.deepEqual(headerOf(small), { bytes: 262, first: '#', size: 262 + small.length });
    assert.deepEqual(headerOf(large), { bytes: 32_774, first: '#', size: 32_774 + large.length });
    assert.equal(headerOf(marked).bytes, 262);
  });
  await t.test('a finding is reported on the blob\'s own line', async () => {
    assert.deepEqual((await scan(repo, markerStub())).map(({ entry, line }) => [entry.path, line]), [['marked.txt', 2]]);
  });
  await t.test('a finding on the header line, or on line 0 for any rule but pkcs12-file, names no line of any blob', async () => {
    for (const StartLine of [1, 0]) {
      await rejectsWith(scan(repo, writeStubGitleaks({ rawReport: JSON.stringify([{ File: 'o1', RuleID: SAMPLE_RULE, StartLine }]), exitCode: 3 })), 'scanner-report-malformed');
    }
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

test('a scanner failure status, an oversized, malformed or inconsistent report, a finding in an unknown file and a path-gated rule on a file not at its path all fail closed with their own cause', async (t) => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }, { path: 'k.yaml', content: 'a\n' }]);
  const item = (File, RuleID = SAMPLE_RULE, StartLine = 2) => ({ rawReport: JSON.stringify([{ File, RuleID, StartLine }]), exitCode: 3 });
  const cases = [
    ['scanner-failed', { exitCode: 1 }, CONFIG],
    ['scanner-report-malformed', { exitCode: 3 }, CONFIG],
    ['scanner-report-malformed', { rawReport: 'not json' }, CONFIG],
    ['scanner-report-malformed', { rawReport: '{}' }, CONFIG],
    ['scanner-report-malformed', { ...item('o1'), exitCode: 0 }, CONFIG],
    ...['elsewhere', 'b1', 'o3', 'o1.yaml', 'o2', './o1', 'sub/o1'].map((name) => ['scanner-report-malformed', item(name), CONFIG]),
    ['scanner-report-malformed', item('o1', 'kubernetes-secret-yaml'), CONFIG],
    ['scanner-report-malformed', item('o2.yaml', 'freemius-secret-key'), CONFIG],
    ['scanner-report-malformed', item('o1', 'pkcs12-file', 0), CONFIG],
    ['scanner-report-malformed', item('o2.yaml', 'pkcs12-file', 0), CONFIG],
    ['limit:maxScanReportBytes', { rawReport: `[${' '.repeat(2048)}]`, exitCode: 0 }, withLimits({ maxScanReportBytes: 1024 })],
    ['limit:maxReportEntries', { rawReport: JSON.stringify(Array(3).fill({ File: 'o1', RuleID: SAMPLE_RULE, StartLine: 2 })), exitCode: 3 }, withLimits({ maxReportEntries: 2 })],
  ];
  for (const [cause, settings, config] of cases) {
    await t.test(`${cause}: ${JSON.stringify(settings).slice(0, 60)}`, () => rejectsWith(scan(repo, writeStubGitleaks(settings), config), cause));
  }
});

test('a baseline or exception ruling is one exact ignore line for the one occurrence it names; the same blob at another path keeps its scanner finding', async (t) => {
  const generated = createRepo([{ path: 'gen.js', content: `${MARKER}\n` }]);
  const baseline = async (repo) => [{ ...exemption(await readEntries(repo), 'gen.js', 1), reason: 'reviewed baseline' }];
  await t.test('the ignore holds the occurrence\'s own name, rule and line, and the occurrence is exempt', async () => {
    const stub = markerStub();
    const config = { ...CONFIG, secretBaseline: await baseline(generated) };
    assert.deepEqual(await scan(generated, stub, config), []);
    assert.equal(scanCalls(stub)[0].ignore, `o1:${SAMPLE_RULE}:2\n`, 'the ignore line counts the one-line header');
  });
  await t.test('a copy at another path: only the named occurrence is ignored, the copy still fails', async () => {
    const copied = createRepo([{ path: 'gen.js', content: `${MARKER}\n` }, { path: 'copy.js', content: `${MARKER}\n` }]);
    for (const list of ['secretBaseline', 'secretExceptions']) {
      const stub = markerStub();
      const findings = await scan(copied, stub, { ...CONFIG, [list]: await baseline(copied) });
      assert.equal(scanCalls(stub)[0].ignore, `o2:${SAMPLE_RULE}:2\n`, list);
      assert.deepEqual(foundPaths(findings), ['copy.js'], list);
    }
  });
  await t.test('a changed blob at the baseline path is not covered', async () => {
    const changed = createRepo([{ path: 'gen.js', content: `${MARKER}\nchanged\n` }]);
    const findings = await scan(changed, markerStub(), { ...CONFIG, secretBaseline: await baseline(generated) });
    assert.deepEqual(foundPaths(findings), ['gen.js']);
  });
});

test('an occurrence at a path a path-gated default rule needs gets that rule\'s neutral suffix and nothing else of its path; baseline rulings and exceptions apply per occurrence', async (t) => {
  const repo = createRepo([
    { path: 'k8s/db.yaml', content: `${MARKER}\n` }, { path: 'copy/other.YML', content: `${MARKER}\n` }, { path: 'a.txt', content: `${MARKER}\n` },
    { path: 'infra/main.tf', content: 'terraform\n' }, { path: 'infra/vars.HCL', content: 'terraform\n' }, { path: 'cfg/NuGet.Config', content: 'nuget\n' },
    { path: 'web/index.PHP', content: 'php\n' }, { path: 'certs/c.PFX', content: 'php\n' }, { path: 'plain.yaml.txt', content: 'plain\n' },
  ]);
  const yamlStub = () => writeStubGitleaks({ finds: [{ marker: MARKER, rule: 'kubernetes-secret-yaml', file: '\\.yaml$' }] });
  await t.test('each name is o<position> and at most one suffix, the one the occurrence\'s own path needs', async () => {
    const stub = writeStubGitleaks();
    await scan(repo, stub);
    const entries = await readEntries(repo);
    const suffixes = Object.fromEntries(Object.keys(scanCalls(stub)[0].blobs).map((name) => {
      const [, position, suffix] = /^o(\d+)(.*)$/.exec(name);
      return [entries[position - 1].path, suffix];
    }));
    assert.deepEqual(suffixes, {
      'k8s/db.yaml': '.yaml', 'copy/other.YML': '.yaml', 'a.txt': '', 'infra/main.tf': '.tf', 'infra/vars.HCL': '.tf', 'cfg/NuGet.Config': '.nuget.config',
      'web/index.PHP': '.php', 'certs/c.PFX': '.p12', 'plain.yaml.txt': '',
    });
  });
  await t.test('a finding under a suffix is reported for the occurrences at paths that need it, not for the same blob elsewhere', async () => {
    assert.deepEqual(foundPaths(await scan(repo, yamlStub())), ['copy/other.YML', 'k8s/db.yaml']);
  });
  await t.test('an exception for one of those occurrences leaves the other', async () => {
    const config = { ...CONFIG, secretExceptions: [{ ...exemption(await readEntries(repo), 'k8s/db.yaml'), rule: 'kubernetes-secret-yaml' }] };
    assert.deepEqual(foundPaths(await scan(repo, yamlStub(), config)), ['copy/other.YML']);
  });
  await t.test('a baseline ruling for a suffixed occurrence is one ignore line under its suffixed name', async () => {
    const single = createRepo([{ path: 'gen.yaml', content: `${MARKER}\n` }]);
    const stub = yamlStub();
    const config = { ...CONFIG, secretBaseline: [{ ...exemption(await readEntries(single), 'gen.yaml'), rule: 'kubernetes-secret-yaml', reason: 'reviewed baseline' }] };
    assert.deepEqual(await scan(single, stub, config), []);
    assert.equal(scanCalls(stub)[0].ignore, 'o1.yaml:kubernetes-secret-yaml:2\n');
  });
});

test('results the scanner repeats, or several rules on one line of one occurrence, are one finding', async () => {
  const repo = createRepo([{ path: 'a.txt', content: `x\n${MARKER}\n` }]);
  const repeated = [{ File: 'o1', RuleID: SAMPLE_RULE, StartLine: 3 }, { File: 'o1', RuleID: SAMPLE_RULE, StartLine: 3 }, { File: 'o1', RuleID: 'github-pat', StartLine: 3 }];
  const findings = await scan(repo, writeStubGitleaks({ rawReport: JSON.stringify(repeated), exitCode: 3 }));
  assert.deepEqual(findings.map(({ entry, line }) => [entry.path, line]), [['a.txt', 2]]);
});

test('an exception names one occurrence and a stale one fails before the scanner starts', async (t) => {
  const lateMarker = 'second-text';
  const repo = createRepo([
    { path: 'one.js', content: `${MARKER}\n` }, { path: 'two.js', content: `${MARKER}\n` }, { path: 'three.js', content: `${MARKER}\nmore\n` },
    { path: 'four.js', content: `x\n${lateMarker}\n` },
  ]);
  const entries = await readEntries(repo);
  const stub = markerStub({ finds: [{ marker: MARKER, rule: SAMPLE_RULE }, { marker: lateMarker, rule: SAMPLE_RULE }] });
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

test('an entry named *.p12 or *.pfx is scanned under a .p12 name, so the scanner\'s pkcs12-file result is one finding without a line that no exception covers; other names get no .p12 suffix', async (t) => {
  const repo = createRepo([
    { path: 'text.p12', content: 'plain text\n' }, { path: 'deep/dir/Bundle.PFX', content: Buffer.from([0x30, 0x82, 0x00, 0x01, 0x00]) }, { path: 'link.pfx', content: 'text.p12', mode: '120000' },
    { path: 'empty.p12', content: '' }, { path: 'p12', content: 'x\n' }, { path: 'a.p12.txt', content: 'x\n' }, { path: 'dir.p12/file.txt', content: 'x\n' }, { path: 'x.p120', content: 'x\n' }, { path: 'xp12', content: 'x\n' },
  ]);
  const flagged = ['deep/dir/Bundle.PFX', 'empty.p12', 'link.pfx', 'text.p12'];
  const pkcs12Stub = (finds = []) => writeStubGitleaks({ finds: [{ rule: 'pkcs12-file', file: '\\.p12$' }, ...finds] });
  await t.test('a text, a binary, an empty and a symlink entry are each reported, with no line', async () => {
    const findings = await scan(repo, pkcs12Stub());
    assert.deepEqual(foundPaths(findings), flagged);
    assert.ok(findings.every((finding) => finding.rule === SECRET_RULE_ID && finding.kind === 'content' && !('line' in finding)));
  });
  await t.test('an exception cannot cover it, and a value the scanner also finds in the blob is its own finding', async () => {
    const config = { ...CONFIG, secretExceptions: [{ ...exemption(await readEntries(repo), 'text.p12'), rule: 'pkcs12-file' }] };
    assert.deepEqual(foundPaths(await scan(repo, pkcs12Stub(), config)), flagged);
    const both = await scan(repo, pkcs12Stub([{ marker: 'plain text', rule: SAMPLE_RULE }]));
    assert.deepEqual(foundPaths(both), [...flagged, 'text.p12'].sort());
  });
  await t.test('an entry whose name is not UTF-8 is never written (the gate reports it unscannable as invalid-utf8-path)', async () => {
    const entry = { position: 1, pathBytes: Buffer.from([0x66, 0xff, 0x2e, 0x70, 0x31, 0x32]), path: null, mode: '100644', kind: 'blob', oid: 'a'.repeat(40), size: 0, problem: 'invalid-utf8-path', bytes: null };
    const stub = pkcs12Stub();
    assert.deepEqual(await scanSecrets({ entries: [entry], config: CONFIG, scanner: { binary: stub.binary, sha256: stub.sha256 } }), []);
    assert.deepEqual(scanCalls(stub)[0].blobs, {});
  });
});

test('the findings never outnumber maxReportEntries: one blob at many paths, many .p12 paths and a mix of both pass at the cap and fail one past it', async (t) => {
  const cap = 10;
  const config = withLimits({ maxReportEntries: cap });
  const stub = writeStubGitleaks({ finds: [{ marker: MARKER, rule: SAMPLE_RULE }, { rule: 'pkcs12-file', file: '\\.p12$' }] });
  const shapes = {
    'one blob at many paths': (count) => Array.from({ length: count }, (_, index) => ({ path: `d/f${index}.txt`, content: `${MARKER}\n` })),
    'many .p12 paths': (count) => Array.from({ length: count }, (_, index) => ({ path: `d/f${index}.p12`, content: 'x\n' })),
    'a mix of both': (count) => Array.from({ length: count }, (_, index) => ({ path: `d/f${index}${index % 2 ? '.p12' : '.txt'}`, content: index % 2 ? 'x\n' : `${MARKER}\n` })),
  };
  for (const [shape, files] of Object.entries(shapes)) {
    await t.test(shape, async () => {
      for (const count of [cap - 1, cap]) assert.equal((await scan(createRepo(files(count)), stub, config)).length, count);
      await rejectsWith(scan(createRepo(files(cap + 1)), stub, config), 'limit:maxReportEntries');
    });
  }
});

test('hasValidSecretConfig accepts the shipped config and refuses each malformed scanner pin or ruling', () => {
  assert.equal(hasValidSecretConfig(CONFIG), true);
  const ruling = { path: 'a.js', blob: 'a'.repeat(40), rule: SAMPLE_RULE, line: 1, reason: 'reviewed' };
  const withoutReason = Object.fromEntries(Object.entries(ruling).filter(([key]) => key !== 'reason'));
  const bad = {
    'scanner.version 8.30': { scanner: { version: '8.30' } }, 'no scanner': { scanner: undefined }, 'baseline not a list': { secretBaseline: {} },
    'exceptions missing': { secretExceptions: undefined }, 'extra key': [{ ...ruling, commit: 'x' }], 'missing reason': [withoutReason],
    'empty reason': [{ ...ruling, reason: '' }], 'line 0': [{ ...ruling, line: 0 }], 'line 1.5': [{ ...ruling, line: 1.5 }], 'line as text': [{ ...ruling, line: '1' }],
    'short blob': [{ ...ruling, blob: 'a'.repeat(39) }], 'empty path': [{ ...ruling, path: '' }],
    'rule with a separator': [{ ...ruling, rule: 'generic-api-key:1\no1' }], 'empty rule': [{ ...ruling, rule: '' }], 'null ruling': [null],
  };
  for (const [name, change] of Object.entries(bad)) {
    const lists = Array.isArray(change) ? [{ secretBaseline: change }, { secretExceptions: change }] : [change];
    for (const changed of lists) assert.equal(hasValidSecretConfig({ ...CONFIG, ...changed }), false, name);
  }
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

test('real scanner: a secret in a PHP, Terraform, Kubernetes YAML or NuGet config file is found by the default rule that needs the file\'s path; the same bytes at a plain path are not', async (t) => {
  if (needsRealScanner(t)) return;
  const word = ['Zq8', 'xK2mP9vL'].join('');
  const files = {
    'k8s/db-secret.yaml': ['apiVersion: v1', 'kind: Secret', 'metadata:', '  name: db', 'data:', `  password: ${Buffer.from(['hunter2', 'hunter2'].join('-')).toString('base64')}`, ''].join('\n'),
    'infra/main.tf': `resource "db" "main" {\n  administrator_login_password = "${word}"\n}\n`,
    'cfg/NuGet.Config': ['<configuration>', ['<add key="ClearText', 'Password" value="', word, '" />'].join(''), '</configuration>', ''].join('\n'),
    'site/plugin.php': `<?php\n$keys = ['secret_key' => '${['sk', '_'].join('')}${word}${'x'.repeat(18)}'];\n`,
  };
  const genericLines = { 'k8s/db-secret.yaml': 6, 'site/plugin.php': 2 };
  const exemptGeneric = async (repo, renamed = (file) => file) => {
    const entries = await readEntries(repo);
    return Object.entries(genericLines).map(([file, line]) => ({ ...exemption(entries, renamed(file), line), rule: 'generic-api-key' }));
  };
  const gated = createRepo(Object.entries(files).map(([file, content]) => ({ path: file, content })));
  const gatedConfig = { ...CONFIG, secretExceptions: await exemptGeneric(gated) };
  assert.deepEqual(foundPaths(await scanReal(gated, gatedConfig)), Object.keys(files).sort(), 'with the generic rule exempted, the path-gated rule still finds each file');
  const renamed = (file) => `plain/${path.posix.basename(file)}.txt`;
  const plain = createRepo(Object.entries(files).map(([file, content]) => ({ path: renamed(file), content })));
  assert.deepEqual(await scanReal(plain, { ...CONFIG, secretExceptions: await exemptGeneric(plain, renamed) }), [], 'at a plain path only the generic rule sees them');
  const both = createRepo([...Object.entries(files), ...Object.entries(files).map(([file, content]) => [renamed(file), content])].map(([file, content]) => ({ path: file, content })));
  const bothConfig = { ...CONFIG, secretExceptions: [...await exemptGeneric(both), ...await exemptGeneric(both, renamed)] };
  assert.deepEqual(foundPaths(await scanReal(both, bothConfig)), Object.keys(files).sort(), 'the same blob at a matching and a plain path: only the matching occurrence');
});

test('real scanner: a key-shaped value is found on its own line under every neutral suffix', async (t) => {
  if (needsRealScanner(t)) return;
  const content = `x\nconst token = "${plantedKey()}";\n`;
  const files = ['a.txt', 'a.php', 'a.tf', 'a.yml', 'NuGet.Config', 'a.pfx'];
  const findings = await scanReal(createRepo(files.map((file) => ({ path: file, content }))));
  assert.deepEqual(findings.filter(({ line }) => line === 2).map(({ entry }) => entry.path).sort(), [...files].sort());
});

test('real scanner: a text, binary, empty or symlink .p12 or .pfx entry, in any case and at any depth, is one finding without a line that no exception covers; near-miss names are not', async (t) => {
  if (needsRealScanner(t)) return;
  const flagged = {
    'certs/client.p12': 'not a key\n', 'certs/client.PFX': 'not a key\n', 'a/b/c/Deep.pFx': Buffer.from([0x30, 0x82, 0x00, 0x01, 0x00, 0xff]), 'empty.p12': '',
  };
  const repo = createRepo([
    ...Object.entries(flagged).map(([file, content]) => ({ path: file, content })), { path: 'link.p12', content: 'certs/client.p12', mode: '120000' },
    ...['p12', 'a.p12.txt', 'dir.p12/file.txt', 'x.p120', 'xp12', 'certs/client.txt'].map((file) => ({ path: file, content: 'not a key\n' })),
  ]);
  const expected = [...Object.keys(flagged), 'link.p12'].sort();
  const findings = await scanReal(repo);
  assert.deepEqual(foundPaths(findings), expected);
  assert.ok(findings.every((finding) => !('line' in finding)));
  const entries = await readEntries(repo);
  const exceptions = expected.map((file) => ({ ...exemption(entries, file), rule: 'pkcs12-file' }));
  assert.deepEqual(foundPaths(await scanReal(repo, { ...CONFIG, secretExceptions: exceptions })), expected);
});

test('real scanner: the pinned default rules that test a path are exactly PATH_GATED_RULES, by rule id and path pattern', (t) => {
  if (needsRealScanner(t)) return;
  const embedded = Object.fromEntries(readFileSync(realScanner.binary, 'latin1').split('\n[[rules]]\n').slice(1)
    .map((block) => [/^id = "([^"]+)"$/m.exec(block)?.[1], /^path = '''(.*)'''$/m.exec(block)?.[1]]).filter(([, pattern]) => pattern !== undefined));
  const accounted = Object.fromEntries(PATH_GATED_RULES.map(({ rule, pattern }) => [rule, `(?${pattern.flags})${pattern.source.replace('[^/]', '[^\\/]')}`]));
  assert.deepEqual(embedded, accounted);
});

test('real scanner: one secret blob at maxReportEntries + 1 paths fails the complete gate with limit:maxReportEntries, publishes nothing and leaves no run folder', async (t) => {
  if (needsRealScanner(t)) return;
  const content = `const token = "${plantedKey()}";\n`;
  const repo = createRepo(Array.from({ length: CONFIG.limits.maxReportEntries + 1 }, (_, index) => ({ path: `d/f${index}.js`, content })));
  const temp = makeTempDir('secret-cap-tmp');
  const out = path.join(makeTempDir('secret-cap-out'), 'report.json');
  const result = runGate(completeArgs(repo, writeList(['unrelated-word']), ['--gitleaks', realScanner.binary, '--gitleaks-sha256', realScanner.sha256, '--out', out]), { env: { TMPDIR: temp } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^limit:maxReportEntries\b/);
  assert.equal(existsSync(out), false, 'no report is published');
  assert.deepEqual(readdirSync(temp), [], 'the run folder is removed');
});

test('real scanner: a key on a blob\'s first line, on a deep line and across a 100 KiB read boundary is found on its own line, either side of the long-header size', async (t) => {
  if (needsRealScanner(t)) return;
  const keyLine = () => `const token = "${plantedKey()}";\n`;
  const sized = (bytes, line) => Buffer.concat([Buffer.from(line), Buffer.alloc(bytes - line.length - 1, 'a'), Buffer.from('\n')]);
  const files = [];
  for (const size of [32_774 - 262 - 1, 32_774 - 262]) files.push({ path: `first-${size}.txt`, content: sized(size, keyLine()), line: 1 });
  files.push({ path: 'deep.txt', content: `${'line\n'.repeat(29_999)}${keyLine()}`, line: 30_000 });
  for (const offset of [-30, -10, 0]) {
    const line = keyLine();
    files.push({ path: `boundary${offset}.txt`, content: `${'b'.repeat(102_400 + offset - 262)} ${line}`, line: 1 });
  }
  const findings = await scanReal(createRepo(files));
  assert.deepEqual(findings.map(({ entry, line }) => [entry.path, line]).sort(), files.map(({ path: file, line }) => [file, line]).sort());
});

/** [offset, bytes] pairs the scanner's file-type check takes for an application type: at offset 0, and at the fixed offsets of tar (257), DICOM (128) and ISO (32769), also one either side. */
const SKIPPED_TYPE_MAGICS = {
  pdf: [0, '%PDF-1.4'], bzip2: [0, 'BZh9'], postscript: [0, '%!PS-Adobe-3.0'], mz: [0, 'MZ'], sqlite: [0, 'SQLite format 3'], elf: [0, '\x7fELF'], zip: [0, 'PK\x03\x04'],
  tarAtOffset: [257, 'ustar'], tarOneBefore: [256, 'ustar'], tarOneAfter: [258, 'ustar'], dicom: [128, 'DICM'], isoAtOffset: [32_769, 'CD001'], isoOneBefore: [32_768, 'CD001'],
};

test('real scanner: a key-shaped value is found in a text file that carries a skipped file type\'s bytes at offset 0 or at a fixed offset (tar 257, DICOM 128, ISO 32769, also shifted by one), on its own line', async (t) => {
  if (needsRealScanner(t)) return;
  const withMagic = ([offset, magic]) => {
    const head = Buffer.alloc(offset + magic.length, 'a');
    head.write(magic, offset, 'latin1');
    return Buffer.concat([head, Buffer.from(`\nconst token = "${plantedKey()}";\n`)]);
  };
  const files = Object.entries(SKIPPED_TYPE_MAGICS).map(([name, spec]) => ({ path: `${name}.txt`, content: withMagic(spec) }));
  const findings = await scanReal(createRepo(files));
  assert.deepEqual(foundPaths(findings), files.map(({ path: file }) => file).sort());
  assert.deepEqual([...new Set(findings.map(({ line }) => line))], [2]);
});
