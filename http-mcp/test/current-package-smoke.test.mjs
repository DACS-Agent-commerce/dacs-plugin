// Current tester package smoke: the exact tarball written by
// deploy/scripts/offline-pack-normalized.mjs (mode-normalized staging copy,
// forced-offline `npm pack --offline --ignore-scripts`), checked against this
// source checkout and then run from a test-owned extraction. Child processes
// get a fresh env (PATH/TMPDIR plus the documented server settings), never a
// HOME override.
//
// STAGED RUNTIME, NOT A CLEAN INSTALL: the tarball is extracted by this test
// into <tmp>/project/node_modules/<plugin>, and the remaining production
// dependencies are COPIED from this checkout's existing node_modules after each
// copied package is checked against package-lock.json. No npm install, cache or
// registry is used, so a genuine clean-machine `npm install <tarball>` is not
// proven here. Every chain, directory, seller and proof service is a SIMULATED
// loopback fixture: not testnet, ChatGPT, payment, Listing/Vet or security
// evidence.
//
// Tarball: DACS_CURRENT_PACKAGE_TGZ (with its pack.json alongside). Absent: skip.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTarEntries, checkShippedFileSet, checkRuntimeGraphFiles, walletAssetsFor, fetchAsset, checkAssetResponse, checkToolSet, checkHealthUnconfigured } from '../scripts/check-embedded-wallet-package.mjs';
import { importFindings, probePort } from '../scripts/check-offline-tester-package.mjs';
import { forbiddenPackagePaths } from '../scripts/package-paths.mjs';
import { tarHeaders, headerModeFindings } from '../deploy/scripts/offline-pack-normalized.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = realpathSync(resolve(here, '..'));
const PACKAGE_NAME = '@dacs-agent-commerce/dacs-chatgpt-plugin';
const SDK = '@kynesyslabs/dacs';
const SDK_ARCHIVE = 'vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz';
const SDK_ARCHIVE_SHA256 = '79934553cf3f952de4a442c8db306b68a2d5cd5947b3f1258ac9ac2caa5a69a3';
const STANDARD_PIN = '662be1d4899a2cadf327fe2d5523e93a80334e5f';
// The package tarball before mode normalization (read only), from
// DACS_ORIGINAL_PACKAGE_TGZ: an independent tar-header inspection found 1038
// non-0644/0755 regular files. Absent: that comparison is skipped.
const ORIGINAL_TGZ = process.env.DACS_ORIGINAL_PACKAGE_TGZ ? resolve(process.env.DACS_ORIGINAL_PACKAGE_TGZ) : null;
const ORIGINAL_SHA256 = '26262e8d920926ab0e47ff537f3d3de90893823e5ed895deb89cceeb9d41ff30';
// The test browser executable; helpers never launch a bare browser.
const CHROME_SOURCE = process.env.DACS_TEST_CHROME ? 'DACS_TEST_CHROME' : 'default /usr/bin/chromium-browser';
process.env.DACS_TEST_CHROME ||= '/usr/bin/chromium-browser';
const CANARY = 'public/portal/__installed-copy-canary.txt';
const ENTRYPOINTS = ['bin/dacs-ops-health.mjs', 'src/ops/health.mjs', 'src/ops/purchase-timeline.mjs', 'bin/dacs-chatgpt-plugin.mjs', 'bin/dacs-chatgpt-offline-test.mjs', 'bin/offline-fixtures/operator.mjs', 'src/app.mjs',
  'src/portal/routes.mjs', 'src/portal/offline-agreement-broker.mjs', 'src/dacs/demos-sr2-wallet-bridge.mjs', 'public/portal/index.html',
  'public/portal/portal.js', 'public/portal/offline-agreement-broker.mjs', 'public/portal/embedded-wallet-bridge.mjs',
  'public/portal/embedded-wallet/main.mjs', 'public/portal/embedded-wallet/sdk-provider.mjs', 'docs/OFFLINE-TESTER.md', 'docs/CURRENT-TESTER-PACKAGE.md'];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (parent, child) => child === parent || child.startsWith(`${parent}/`);

export function locateTarball(env = process.env, evidence = null) {
  if (env.DACS_CURRENT_PACKAGE_TGZ) {
    const tgz = resolve(env.DACS_CURRENT_PACKAGE_TGZ);
    return { tgz, packJson: join(dirname(tgz), 'pack.json'), source: 'DACS_CURRENT_PACKAGE_TGZ' };
  }
  // An explicit directory of helper runs: the newest pack-<epoch ms>; a stale one fails the source-binding test.
  const dirs = evidence && existsSync(evidence) ? readdirSync(evidence).filter((n) => /^pack-\d+$/.test(n) && existsSync(join(evidence, n, 'pack.json'))) : [];
  if (!dirs.length) return null;
  const dir = dirs.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).at(-1);
  const packJson = join(evidence, dir, 'pack.json');
  const [packed] = JSON.parse(readFileSync(packJson, 'utf8'));
  return { tgz: join(evidence, dir, packed.filename), packJson, source: `evidence/${dir} (newest of ${dirs.length})` };
}

// Paths (outside node_modules/) whose packed bytes differ from or are absent in `root`.
export function sourceMismatches(entries, root) {
  const out = [];
  for (const [rel, bytes] of entries) {
    if (rel.startsWith('node_modules/')) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) out.push(`${rel}: absent from source`);
    else if (sha256(readFileSync(abs)) !== sha256(bytes)) out.push(`${rel}: bytes differ`);
  }
  return out;
}

// Source files the package.json "files" allowlist plus npm's always-included files select.
function expectedShipped(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.add(child);
    }
  };
  for (const entry of pkg.files) {
    const rel = entry.replace(/\/$/, '');
    if (!existsSync(join(root, rel))) continue;
    if (statSync(join(root, rel)).isDirectory()) walk(rel);
    else out.add(rel);
  }
  return out;
}

const located = (() => { try { return locateTarball(); } catch (error) { return { error }; } })();
const skip = located ? false : 'no current package tarball: run deploy/scripts/offline-pack-normalized.mjs or set DACS_CURRENT_PACKAGE_TGZ';
const state = {};
// File-level: the staged project is shared by every test below.
after(() => { if (state.work) rmSync(state.work, { recursive: true, force: true }); });

test('tarball receipt: npm-reported integrity/shasum and entry count equal the exact bytes', { skip }, (t) => {
  assert.ok(!located.error, located.error?.message);
  const tgz = readFileSync(located.tgz);
  const [packed] = JSON.parse(readFileSync(located.packJson, 'utf8'));
  assert.equal(packed.name, PACKAGE_NAME);
  assert.equal(packed.integrity, `sha512-${createHash('sha512').update(tgz).digest('base64')}`);
  assert.equal(packed.shasum, createHash('sha1').update(tgz).digest('hex'));
  const entries = parseTarEntries(tgz);
  assert.equal(entries.size, packed.entryCount);
  assert.deepEqual([...entries.keys()].sort(), packed.files.map((f) => f.path).sort());
  Object.assign(state, { tgz, packed, entries, tgzSha256: sha256(tgz) });
  t.diagnostic(JSON.stringify({ tarball: located.tgz, from: located.source, sha256: state.tgzSha256, integrity: packed.integrity, entries: entries.size, bundled: packed.bundled }));
});

test('source-bound inventory: every non-dependency entry is this checkout byte-for-byte, the set equals the files allowlist, nothing private ships', { skip }, () => {
  const { entries, packed } = state;
  assert.ok(entries, 'receipt test must pass first');
  // Control for the comparison itself: one altered byte is reported, nothing else.
  const altered = new Map([...entries].filter(([p]) => !p.startsWith('node_modules/')).slice(0, 3));
  const [first] = altered.keys();
  altered.set(first, Buffer.concat([altered.get(first), Buffer.from('x')]));
  assert.deepEqual(sourceMismatches(altered, SOURCE), [`${first}: bytes differ`]);
  assert.deepEqual(sourceMismatches(entries, SOURCE), []);
  const own = [...entries.keys()].filter((p) => !p.startsWith('node_modules/')).sort();
  assert.deepEqual(own, [...expectedShipped(SOURCE)].sort());
  for (const rel of ENTRYPOINTS) assert.ok(entries.has(rel), `entry point ${rel} ships`);
  const shipped = checkShippedFileSet([...entries.keys()], packed.bundled);
  assert.deepEqual(shipped.findings, []);
  assert.deepEqual(forbiddenPackagePaths(own), []);
  assert.deepEqual(own.filter((p) => /^(deploy|test|scripts|vendor|wallet-build|references)\//.test(p) || /(^|\/)\.env$/.test(p)), []);
  assert.deepEqual(checkRuntimeGraphFiles(entries), []);
  const pkg = JSON.parse(entries.get('package.json'));
  assert.deepEqual(pkg.bin, { 'dacs-chatgpt-plugin': './bin/dacs-chatgpt-plugin.mjs', 'dacs-ops-health': './bin/dacs-ops-health.mjs' });
  assert.equal(pkg.private, true);
});

test('shipped file modes: every packed entry is readable by the installing user and others (0644 or 0755)', { skip }, () => {
  assert.ok(state.packed);
  // Modes come from the packing filesystem, not package.json; summarised per top directory.
  const odd = {};
  for (const f of state.packed.files.filter((x) => ![0o644, 0o755].includes(x.mode))) {
    const key = `${f.path.startsWith('node_modules/') ? f.path.split('/').slice(0, f.path.startsWith('node_modules/@') ? 3 : 2).join('/') : f.path} 0${f.mode.toString(8)}`;
    odd[key] = (odd[key] ?? 0) + 1;
  }
  assert.deepEqual(odd, {});
  // Independently of npm's report: the actual tar headers, which also must agree with pack.json.
  const headers = tarHeaders(state.tgz);
  assert.equal(headers.filter((h) => h.type === '0').length, state.packed.entryCount);
  assert.deepEqual(headerModeFindings(headers, state.packed.files), []);
  state.headers = headers;
});

test('mode-normalization control: the header check rejects a 0600 entry and, when DACS_ORIGINAL_PACKAGE_TGZ is set, the original unnormalized artifact (1038 files)', { skip }, (t) => {
  assert.ok(state.headers);
  const target = state.headers.find((h) => h.type === '0' && h.mode === 0o644);
  const altered = state.headers.map((h) => (h === target ? { ...h, mode: 0o600 } : h));
  assert.deepEqual(headerModeFindings(altered), [`${target.path}: 0600`]);
  assert.deepEqual(headerModeFindings(altered, state.packed.files), [`${target.path}: 0600`, `${target.path}: header 0600 != pack.json 0644`]);
  if (!ORIGINAL_TGZ) return t.diagnostic('original-artifact comparison skipped: DACS_ORIGINAL_PACKAGE_TGZ is not set');
  assert.ok(existsSync(ORIGINAL_TGZ), `original artifact present at ${ORIGINAL_TGZ}`);
  const original = readFileSync(ORIGINAL_TGZ);
  assert.equal(sha256(original), ORIGINAL_SHA256);
  const findings = headerModeFindings(tarHeaders(original));
  assert.equal(findings.length, 1038);
  t.diagnostic(JSON.stringify({ original: ORIGINAL_SHA256, nonNormalizedRegularFiles: findings.length, current: state.tgzSha256, currentFindings: 0 }));
});

test('embedded SDK: bundled @kynesyslabs/dacs is exactly the pinned vendor archive (Standard pin unchanged); other bundled deps equal the locked copies', { skip }, () => {
  const { entries, packed } = state;
  assert.ok(entries);
  const archive = readFileSync(join(SOURCE, SDK_ARCHIVE));
  assert.equal(sha256(archive), SDK_ARCHIVE_SHA256);
  const vendor = parseTarEntries(archive);
  const prefix = `node_modules/${SDK}/`;
  const bundledSdk = new Map([...entries].filter(([p]) => p.startsWith(prefix)).map(([p, b]) => [p.slice(prefix.length), b]));
  assert.deepEqual([...bundledSdk.keys()].sort(), [...vendor.keys()].sort());
  for (const [rel, bytes] of vendor) assert.equal(sha256(bundledSdk.get(rel)), sha256(bytes), rel);
  assert.equal(JSON.parse(bundledSdk.get('package.json')).version, '0.1.0-alpha.0');
  assert.match(bundledSdk.get('dist/version.js').toString('utf8'), new RegExp(`DACS_STANDARD_PIN = "${STANDARD_PIN}"`));
  const lock = JSON.parse(readFileSync(join(SOURCE, 'package-lock.json'), 'utf8'));
  for (const name of packed.bundled.filter((n) => n !== SDK)) {
    const manifest = entries.get(`node_modules/${name}/package.json`);
    assert.ok(manifest, `${name} bundled manifest`);
    assert.equal(JSON.parse(manifest).version, lock.packages[`node_modules/${name}`]?.version, `${name} version equals the lockfile`);
    for (const [p, b] of entries) {
      if (p.startsWith(`node_modules/${name}/`)) assert.equal(sha256(readFileSync(join(SOURCE, p))), sha256(b), p);
    }
  }
});

test('staged tester project: extracted package plus copied, lock-checked production dependencies; no dev dependency or source SDK copy', { skip }, (t) => {
  const { entries, packed } = state;
  assert.ok(entries);
  // Node resolves bare specifiers up through every ancestor node_modules, so a
  // stray one above the project (seen on this host above TMPDIR) would leak
  // modules no tester has. Stage under the first base with none above it.
  const bases = [tmpdir(), '/tmp'].map((b) => realpathSync(b));
  const leaks = (dir) => { const out = []; for (let d = dir; ; d = dirname(d)) { if (existsSync(join(d, 'node_modules'))) out.push(join(d, 'node_modules')); if (d === dirname(d)) return out; } };
  const base = bases.find((b) => leaks(b).length === 0);
  assert.ok(base, `every staging base has an ancestor node_modules: ${bases.map((b) => leaks(b).join(',')).join('; ')}`);
  const work = realpathSync(mkdtempSync(join(base, 'dacs-cps-')));
  state.work = work;
  t.diagnostic(JSON.stringify({ stagingBase: base, rejectedBases: bases.filter((b) => b !== base && leaks(b).length).map((b) => ({ base: b, ancestorNodeModules: leaks(b) })) }));
  const project = join(work, 'project');
  const installed = join(project, 'node_modules', ...PACKAGE_NAME.split('/'));
  for (const [rel, bytes] of entries) {
    const dest = join(installed, rel);
    assert.ok(inside(installed, resolve(dest)), `safe path ${rel}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'dacs-current-package-smoke', version: '0.0.0', private: true }, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(join(SOURCE, 'package-lock.json'), 'utf8'));
  const bundled = new Set(packed.bundled);
  const prod = Object.entries(lock.packages).filter(([k, e]) => k && !e.dev && !e.inBundle && !e.link);
  const top = prod.map(([k]) => k).filter((k) => /^node_modules\/(@[^/]+\/)?[^/]+$/.test(k)).map((k) => k.slice('node_modules/'.length)).filter((n) => !bundled.has(n));
  const missing = [];
  for (const name of top) {
    const from = join(SOURCE, 'node_modules', name);
    if (!existsSync(from)) { missing.push(name); continue; }
    cpSync(from, join(project, 'node_modules', name), { recursive: true, verbatimSymlinks: true });
  }
  assert.deepEqual(missing, [], 'every locked production dependency exists in the checkout');
  const drift = [];
  for (const [key, entry] of prod) {
    if (bundled.has(key.slice('node_modules/'.length).match(/^(@[^/]+\/)?[^/]+/)[0])) continue; // checked from the tarball
    const path = join(project, key, 'package.json');
    const version = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null;
    if (version !== entry.version && !(entry.optional && version === null)) drift.push(`${key}: ${version} != ${entry.version}`);
  }
  assert.deepEqual(drift, []);
  assert.equal(existsSync(join(project, 'node_modules', 'playwright-core')), false);
  assert.equal(existsSync(join(project, 'node_modules', SDK)), false, 'only the tarball-bundled SDK is resolvable');
  writeFileSync(join(installed, CANARY), 'installed copy\n'); // distinguishes installed from source serving
  Object.assign(state, { project, installed });
  t.diagnostic(JSON.stringify({ mode: 'staged-copied-locked-deps (NOT a clean npm install)', topLevelCopied: top.length, lockChecked: prod.length }));
});

// Same lifecycle as deploy/scripts/runtime-smoke.mjs, but that helper sets HOME
// for its children; here every child gets PATH/TMPDIR plus the documented
// server settings only.
const freePort = () => new Promise((r, j) => { const s = createServer(); s.once('error', j); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('documented normal server start from the installed bin: health, readiness, restart, backup/restore, SIGTERM exit 0 (no HOME override)', { skip, timeout: 180_000 }, async (t) => {
  assert.ok(state.installed);
  const work = join(state.work, 'normal');
  mkdirSync(work);
  const port = await freePort();
  const keys = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const origin = `http://127.0.0.1:${port}`;
  const envFor = (data) => ({ PATH: process.env.PATH, TMPDIR: work, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: data, DACS_OAUTH_COOKIE_KEYS: keys.join(',') });
  let output = '';
  const steps = [];
  const cycle = async (label, data) => {
    const child = spawn(process.execPath, [join(state.installed, 'bin', 'dacs-chatgpt-plugin.mjs')], { cwd: work, env: envFor(data), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let health = null;
    for (const end = Date.now() + 30_000; !health && Date.now() < end && child.exitCode === null; await delay(250)) {
      health = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.deepEqual(checkHealthUnconfigured(health), [], `${label}: /health ok, directory/chain/external issuer unconfigured`);
    assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).status, 200, `${label}: ready`);
    child.kill('SIGTERM');
    assert.deepEqual(await Promise.race([exited, delay(20_000).then(() => null)]), { code: 0, signal: null }, `${label}: SIGTERM exit 0`);
    steps.push(label);
  };
  const data = join(work, 'data');
  await cycle('first start', data);
  const dbs = readdirSync(data).filter((n) => /\.(sqlite3?|db)$/.test(n));
  assert.ok(dbs.length > 0, 'state persisted to DACS_DATA_DIR');
  assert.deepEqual(dbs.filter((d) => existsSync(join(data, `${d}-wal`)) && statSync(join(data, `${d}-wal`)).size > 0), [], 'clean close (no pending WAL)');
  await cycle('restart on same data', data);
  const backupTool = join(SOURCE, 'deploy', 'scripts', 'state-backup.mjs');
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', backupTool, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: work } });
  const b = run('backup', '--data-dir', data, '--out', join(work, 'backup'), '--confirm-stopped');
  assert.equal(b.status, 0, (b.stdout || b.stderr).trim());
  const r = run('restore', '--backup', join(work, 'backup'), '--data-dir', join(work, 'restored'), '--confirm-stopped');
  assert.equal(r.status, 0, (r.stdout || r.stderr).trim());
  await cycle('start on restored data', join(work, 'restored'));
  assert.ok(!keys.some((k) => output.includes(k)), 'logs free of cookie keys');
  t.diagnostic(JSON.stringify({ steps, backup: 'ok', restore: 'ok', childEnv: Object.keys(envFor(data)) }));
});

test('documented tester startup: installed offline launcher CLI --json serves installed assets, MCP tools, simulated profile; SIGTERM closes every service', { skip, timeout: 120_000 }, async (t) => {
  assert.ok(state.installed);
  const env = { PATH: process.env.PATH, TMPDIR: state.work };
  const child = spawn(process.execPath, [join(state.installed, 'bin', 'dacs-chatgpt-offline-test.mjs'), '--json'], { cwd: state.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  for (const end = Date.now() + 45_000; !out.includes('\n') && Date.now() < end && child.exitCode === null;) await delay(100);
  const summary = JSON.parse(out.split('\n')[0] || 'null');
  assert.ok(summary, `start line; stderr: ${err.slice(0, 300)}`);
  assert.equal(summary.status, 'running');
  assert.match(summary.notice, /SIMULATED/);
  assert.match(summary.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const health = await (await fetch(summary.health)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.dependencies.chain.configured, true);
  const canary = await fetch(`${summary.plugin}/portal/assets/${CANARY.replace('public/portal/', '')}`);
  assert.equal(canary.status, 200, 'assets are served from the installed copy, not the source checkout');
  assert.equal(await canary.text(), 'installed copy\n');
  const problems = [];
  for (const path of [...walletAssetsFor(state.entries), 'public/portal/offline-agreement-broker.mjs', 'public/portal/portal.js']) {
    const p = checkAssetResponse(path, state.entries.get(path), await fetchAsset(summary.plugin, path));
    if (p.length) problems.push(`${path}: ${p.join(', ')}`);
  }
  assert.deepEqual(problems, []);
  const profile = await (await fetch(`${summary.plugin}/portal/api/embedded-wallet/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(profile.writes, 'simulated-loopback');
  assert.equal(profile.evidenceMode, 'simulated-fixture');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'current-package-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(summary.mcp)));
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(checkToolSet(tools.map((x) => x.name)), []);
  child.kill('SIGTERM');
  const stop = await Promise.race([exited, delay(15_000).then(() => null)]);
  assert.deepEqual(stop, { code: 0, signal: null });
  const services = [summary.plugin, summary.fixtures.chain, summary.fixtures.directory, summary.fixtures.proofs];
  for (const origin of services) assert.equal(await probePort(origin), 'refused', origin);
  assert.doesNotMatch(out + err, /mnemonic|private key|cookie/i);
  t.diagnostic(JSON.stringify({ tools: tools.length, assets: walletAssetsFor(state.entries).length + 2, services: services.length }));
});

// In-process runs: the source-only test harness/driver stays in the checkout,
// but every runtime module it would import from src/, public/, bin/ or the SDK
// is resolved to the INSTALLED copy instead, and every resolution is recorded.
const resolutions = [];
let hooked = false;
function hookToInstalled() {
  if (hooked) return;
  hooked = true;
  const src = pathToFileURL(SOURCE).href, dst = pathToFileURL(state.installed).href;
  const redirects = [...['src/', 'public/', 'bin/'].map((d) => [`${src}/${d}`, `${dst}/${d}`]), [`${src}/node_modules/${SDK}/`, `${dst}/node_modules/${SDK}/`]];
  registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context);
      const hit = redirects.find(([from]) => r.url.startsWith(from));
      const url = hit ? hit[1] + r.url.slice(hit[0].length) : r.url;
      resolutions.push({ parent: context.parentURL ?? '', url, redirected: Boolean(hit) });
      return hit ? { ...r, url } : r;
    },
  });
}

test('in-process installed launcher: startOfflineTester from the installed bin; installed imports stay inside the project', { skip, timeout: 60_000 }, async () => {
  assert.ok(state.installed);
  hookToInstalled();
  const mod = await import(pathToFileURL(join(state.installed, 'bin', 'dacs-chatgpt-offline-test.mjs')).href);
  const handle = await mod.startOfflineTester({ logLevel: 'silent', dashboard: false });
  try {
    assert.match(handle.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${handle.origin}/portal/assets/${CANARY.replace('public/portal/', '')}`)).status, 200);
  } finally {
    await handle.stop();
  }
  const fromInstalled = resolutions.filter((r) => r.parent.startsWith('file:') && inside(state.project, fileURLToPath(r.parent)));
  assert.ok(fromInstalled.some((r) => r.url.endsWith('/src/app.mjs')));
  assert.ok(fromInstalled.some((r) => r.url.endsWith(`/node_modules/${SDK}/dist/index.js`) && inside(state.installed, fileURLToPath(r.url))));
  // Oracle control: a checkout runtime module is reported.
  assert.notDeepEqual(importFindings({ url: pathToFileURL(join(SOURCE, 'src/app.mjs')).href, projectRoot: state.project, packageRoot: state.installed, sourceRoot: SOURCE }), []);
  const findings = fromInstalled.flatMap((r) => importFindings({ url: r.url, projectRoot: state.project, packageRoot: state.installed, sourceRoot: SOURCE }));
  assert.deepEqual(findings, []);
});

test('installed built-in wallet + browser broker: real Chrome trusted approval anchors one unchanged Agreement through the installed app (simulated loopback)', { skip, timeout: 180_000 }, async (t) => {
  assert.ok(state.installed);
  hookToInstalled();
  const { startProtocolHarness, addSeller } = await import('./dacs-loopback-fixture.test.mjs');
  const { startAgreementChain } = await import('./helpers/offline-agreement-fixture.mjs');
  const { tool, linkedUser, portal, tokenFrom } = await import('./helpers/flows.mjs');
  const { memoryAnchorJournal } = await import('./helpers/dacs-storage-anchor-wallet-fixture.mjs');
  const { installLoopbackOnlyGuard, externalAttempts } = await import('./helpers/embedded-wallet-flow-fixtures.mjs');
  const { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } = await import('./helpers/embedded-wallet-fixtures.mjs');
  const { canonicalize, contentHash } = await import(SDK);
  installLoopbackOnlyGuard();
  const runtime = resolutions.filter((r) => /\/(src|public|bin)\/|\/node_modules\/@kynesyslabs\/dacs\//.test(r.url) && r.url.startsWith('file:'));
  const fromSource = runtime.filter((r) => inside(SOURCE, fileURLToPath(r.url)) && /^(src|public|bin|node_modules\/@kynesyslabs)\//.test(fileURLToPath(r.url).slice(SOURCE.length + 1)));
  assert.deepEqual(fromSource.map((r) => r.url), [], 'no runtime module loads from the source checkout');
  assert.ok(runtime.some((r) => r.url === pathToFileURL(join(state.installed, 'src/portal/offline-agreement-broker.mjs')).href));

  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal } });
  cleanup.add('loopback harness', 10000, () => h.close());
  assert.equal((await fetch(`${h.origin}/portal/assets/${CANARY.replace('public/portal/', '')}`)).status, 200, 'harness app serves the installed public/');
  const launched = await launchTestChrome(cleanup);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
  const served = new Map();
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/portal/assets/')) served.set(`public/portal/${u.pathname.slice('/portal/assets/'.length)}`, sha256(await r.body().catch(() => Buffer.alloc(0))));
  });
  const user = await linkedUser(h);
  const link = await tool(h, user, 'start_wallet_link');
  await page.goto(link.linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const wallet = page.locator('#embedded-wallet'), password = freshPassword();
  const address = await uiCreate(wallet, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const seller = await addSeller(h, { listingId: `current-package-${Date.now()}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `current-package-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(wallet, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.locator('#dacs-sign-agreement').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // broker authentication
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.artifactKind, 'Agreement');
  assert.equal(shown.contentHash, contentHash(JSON.parse(shown.exactStorageBytes)));
  assert.equal(chain.wire.record.broadcastAttempts.length, 0);
  await dialog.getByRole('button', { name: UI.approve }).click();
  await page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const verified = await tool(h, user, 'verify_deal', { operationId: p.operationId });
  assert.equal(verified.protocol.stage, 'agreement-anchored');
  assert.equal(canonicalize(chain.wire.record.accepted[0].content.data[1].data), shown.exactStorageBytes);
  assert.equal(verified.protocol.limits.payment, 'held');
  assert.equal(chain.wire.record.broadcastAttempts.length, 1);
  assert.equal((await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: tokenFrom(p.approvalUrl), address })).error, 'agreement_payment_held');
  for (const path of ['public/portal/offline-agreement-broker.mjs', 'public/portal/embedded-wallet/sdk-provider.mjs']) {
    assert.equal(served.get(path), sha256(state.entries.get(path)), `browser loaded the packaged ${path}`);
  }
  assertNoSecrets(rec.requests, [password], 'browser HTTP requests');
  assert.deepEqual(rec.consoleErrors, []);
  assert.deepEqual(externalAttempts, []);
  t.diagnostic(JSON.stringify({ chrome: launched.version, executable: launched.executablePath, from: CHROME_SOURCE, stage: verified.protocol.stage, broadcasts: 1, payment: 'held', mode: 'simulated loopback, installed copy' }));
});
