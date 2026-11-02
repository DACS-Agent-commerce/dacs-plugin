// Unit tests for the embedded-wallet package/container checkers. Every case
// starts from a valid accepting control and changes one thing, so a failing
// check is attributable to that change. Fixtures are labelled: SOURCE_FIXTURE
// and ARTIFACT_FIXTURE are synthetic in-memory files, not the shipped wallet.
// The real artifact path (npm pack -> install -> boot -> HTTP) is exercised by
// scripts/check-embedded-wallet-package.mjs itself, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  PACKAGE_ROOT, RUNTIME_ASSET, RUNTIME_BANNER, RUNTIME_GRAPH_RESULT, RUNTIME_MANIFEST_ASSET, RUNTIME_SDK_LABEL, WALLET_ASSETS, WALLET_DIR, EXPECTED_TOOLS,
  checkAssetResponse, checkHealthUnconfigured, checkRuntimeGraphFiles, checkShippedFileSet, checkToolSet, compareWalletFiles,
  compareWithCandidateManifest, mimeEssence, parseTarEntries, readSourceFiles, sha256, shippedPathFindings, walletAssetsFor,
  DEFAULT_PACKAGE_OVERALL_MS, boundedSignal, parsePackageArgs, withTimeout,
} from '../scripts/check-embedded-wallet-package.mjs';
import { parseContainerArgs, waitForHealth, UsageError } from '../scripts/check-embedded-wallet-container.mjs';
import { serializeRuntimeManifest } from '../scripts/embedded-wallet-runtime.mjs';

// ---- fixtures -------------------------------------------------------------

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

// Synthetic npm-style tarball: every entry under "package/".
function makeTgz(files, { corruptChecksumOf = null } = {}) {
  const parts = [];
  for (const [rel, body] of files) {
    const header = tarHeader(`package/${rel}`, body.length);
    if (rel === corruptChecksumOf) header[0] ^= 1;
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

// Synthetic stand-in shaped like the generated split runtime (banner entry, an
// eager chunk, a lazily imported chunk, manifest). It is NOT the SDK and proves
// nothing about wallet behaviour; graph rules themselves are covered in
// embedded-wallet-runtime.test.mjs.
const BANNER = `/*\n * ${RUNTIME_BANNER} Experimental, default-off.\n * Browser bundle of the ${RUNTIME_SDK_LABEL} (public npm,\n */\n`;
const GRAPH_SOURCES = {
  'demos-runtime.mjs': `${BANNER}export * from "./runtime-chunks/entry-AAAAAAAA.mjs";\n`,
  'runtime-chunks/entry-AAAAAAAA.mjs': 'import{a}from"./chunk-BBBBBBBB.mjs";export const Demos=a;export const later=()=>import("./chunk-CCCCCCCC.mjs");',
  'runtime-chunks/chunk-BBBBBBBB.mjs': 'export const a=1;',
  'runtime-chunks/chunk-CCCCCCCC.mjs': 'import"./chunk-BBBBBBBB.mjs";export const c=2;',
};
const GRAPH_EDGES = new Map([
  ['demos-runtime.mjs', { imports: ['runtime-chunks/entry-AAAAAAAA.mjs'], dynamicImports: [] }],
  ['runtime-chunks/entry-AAAAAAAA.mjs', { imports: ['runtime-chunks/chunk-BBBBBBBB.mjs'], dynamicImports: ['runtime-chunks/chunk-CCCCCCCC.mjs'] }],
  ['runtime-chunks/chunk-CCCCCCCC.mjs', { imports: ['runtime-chunks/chunk-BBBBBBBB.mjs'], dynamicImports: [] }],
]);
const LAZY_CHUNK = `${WALLET_DIR}/runtime-chunks/chunk-CCCCCCCC.mjs`;

function runtimeGraphFixture(sources = GRAPH_SOURCES) {
  const files = new Map(Object.entries(sources).map(([p, t]) => [p, Buffer.from(t)]));
  files.set('runtime-manifest.json', Buffer.from(serializeRuntimeManifest({ files, edges: GRAPH_EDGES, esbuildVersion: '0.25.12' })));
  return files;
}

function sourceFixture(graph = runtimeGraphFixture()) {
  const files = new Map();
  for (const path of WALLET_ASSETS) files.set(path, Buffer.from(`SOURCE_FIXTURE ${path}\n`));
  for (const [path, bytes] of graph) files.set(`${WALLET_DIR}/${path}`, bytes);
  return files;
}

const artifactFixture = (source) => new Map([...source].map(([k, v]) => [k, Buffer.from(v)]));
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

const validResponse = (path, body) => ({
  status: 200,
  contentType: path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
  nosniff: 'nosniff',
  body: Buffer.from(body),
});

const validHealth = () => ({
  status: 'ok',
  dependencies: { database: 'ok', directory: { configured: false }, chain: { configured: false }, externalIssuer: { configured: false } },
});

// ---- tarball reading ------------------------------------------------------

test('parseTarEntries reads an npm-style tarball byte-exactly', () => {
  const files = new Map([['package.json', Buffer.from('{}')], [`${WALLET_DIR}/index.html`, Buffer.from('<!doctype html>')], ['big.bin', Buffer.alloc(1300, 7)]]);
  const parsed = parseTarEntries(makeTgz(files));
  assert.deepEqual([...parsed.keys()].sort(), [...files.keys()].sort());
  for (const [k, v] of files) assert.equal(sha256(parsed.get(k)), sha256(v), k);
});

test('parseTarEntries rejects a corrupted header and a traversal path', () => {
  const files = new Map([['a.txt', Buffer.from('a')], ['b.txt', Buffer.from('b')]]);
  assert.doesNotThrow(() => parseTarEntries(makeTgz(files)));
  assert.throws(() => parseTarEntries(makeTgz(files, { corruptChecksumOf: 'b.txt' })), /checksum mismatch/);
  assert.throws(() => parseTarEntries(makeTgz(new Map([['../escape.txt', Buffer.from('x')]]))), /unsafe tar entry/);
});

// ---- shipped file set -----------------------------------------------------

const BUNDLED = ['@kynesyslabs/dacs', 'boolbase'];
const validShipList = () => ['package.json', 'bin/dacs-chatgpt-plugin.mjs', '.env.example', `${WALLET_DIR}/index.html`, RUNTIME_ASSET, RUNTIME_MANIFEST_ASSET,
  `${WALLET_DIR}/runtime-chunks/chunk-BBBBBBBB.mjs`,
  'node_modules/@kynesyslabs/dacs/package.json', 'node_modules/@kynesyslabs/dacs/dist/index.js', 'node_modules/boolbase/index.js', 'docs/EMBEDDED-WALLET-SDK.md'];

test('shipped file set: the public runtime manifest and chunks are allowed; wallet-named JSON stays forbidden beside them', () => {
  assert.deepEqual(shippedPathFindings(RUNTIME_MANIFEST_ASSET, BUNDLED), []);
  assert.deepEqual(shippedPathFindings(`${WALLET_DIR}/runtime-chunks/chunk-BBBBBBBB.mjs`, BUNDLED), []);
  for (const path of [`${WALLET_DIR}/wallet.json`, `${WALLET_DIR}/runtime-chunks/wallet-state.json`, 'public/portal/my-wallet-backup.json']) {
    assert.deepEqual(shippedPathFindings(path, BUNDLED), ['wallet-json'], path);
  }
});

test('shipped file set: control passes; each forbidden path is reported with its reason', () => {
  assert.deepEqual(checkShippedFileSet(validShipList(), BUNDLED), { ok: true, findings: [] });
  const cases = [
    ['wallet-build/build.mjs', 'wallet-build-shipped'],
    ['wallet-build/node_modules/esbuild/package.json', 'unexpected-node-modules'],
    ['node_modules/not-bundled/index.js', 'unexpected-node-modules'],
    ['.env', 'env-file'],
    ['deploy/.env.production', 'env-file'],
    ['.data/dacs-chatgpt.sqlite', 'runtime-state'],
    ['public/portal/state.db-wal', 'runtime-state'],
    ['public/portal/server.pem', 'credential-file'],
    ['public/portal/embedded-wallet/test-wallet.json', 'wallet-json'],
    ['test/unit.test.mjs', 'dev-only-files'],
    ['STATUS.md', 'working-notes'],
  ];
  for (const [path, reason] of cases) {
    assert.ok(shippedPathFindings(path, BUNDLED).includes(reason), `${path} -> ${reason}`);
    const result = checkShippedFileSet([...validShipList(), path], BUNDLED);
    assert.equal(result.ok, false, path);
    assert.deepEqual(result.findings, shippedPathFindings(path, BUNDLED).map((id) => `${id}:${path}`), path);
  }
});

test('shipped file set: the declared DACS bundle must actually be packed', () => {
  const withoutDacs = validShipList().filter((p) => !p.startsWith('node_modules/@kynesyslabs/'));
  assert.deepEqual(checkShippedFileSet(withoutDacs, ['boolbase']).findings, ['declared-bundle-not-packed:@kynesyslabs/dacs']);
  // npm listing the name without its package.json is still not a packed bundle.
  assert.deepEqual(checkShippedFileSet(withoutDacs, BUNDLED).findings, ['declared-bundle-not-packed:@kynesyslabs/dacs']);
});

// ---- source vs artifact bytes ---------------------------------------------

test('compareWalletFiles: identical SOURCE_FIXTURE/ARTIFACT_FIXTURE pass every check', () => {
  const source = sourceFixture();
  const results = compareWalletFiles({ sourceFiles: source, artifactFiles: artifactFixture(source), label: 'fixture' });
  assert.deepEqual(failed(results), []);
  // The three declared chunks (eager and lazy) are compared like every other asset.
  assert.deepEqual(walletAssetsFor(source).slice(WALLET_ASSETS.length), [`${WALLET_DIR}/runtime-chunks/chunk-BBBBBBBB.mjs`, LAZY_CHUNK, `${WALLET_DIR}/runtime-chunks/entry-AAAAAAAA.mjs`]);
  assert.equal(results.length, WALLET_ASSETS.length + 3 + 2);
});

test('compareWalletFiles: one changed byte fails exactly that asset', () => {
  const source = sourceFixture();
  const artifact = artifactFixture(source);
  const changed = `${WALLET_DIR}/vault.mjs`;
  const bytes = Buffer.from(artifact.get(changed));
  bytes[0] ^= 1;
  artifact.set(changed, bytes);
  assert.deepEqual(failed(compareWalletFiles({ sourceFiles: source, artifactFiles: artifact, label: 'fixture' })), [`fixture: ${changed} bytes match source`]);
});

test('compareWalletFiles: missing and extra wallet files are both reported', () => {
  const source = sourceFixture();
  const missing = artifactFixture(source);
  missing.delete(`${WALLET_DIR}/sdk-provider.mjs`);
  assert.deepEqual(failed(compareWalletFiles({ sourceFiles: source, artifactFiles: missing, label: 'fixture' })),
    ['fixture: embedded-wallet file set equals source', `fixture: ${WALLET_DIR}/sdk-provider.mjs present`]);
  const extra = artifactFixture(source);
  extra.set(`${WALLET_DIR}/debug-notes.txt`, Buffer.from('x'));
  const results = compareWalletFiles({ sourceFiles: source, artifactFiles: extra, label: 'fixture' });
  assert.deepEqual(failed(results), ['fixture: embedded-wallet file set equals source']);
  assert.match(results[0].detail, /extra public\/portal\/embedded-wallet\/debug-notes\.txt/);
});

test('runtime graph: a declared lazy chunk must ship, in the artifact and even when the source lacks it too', () => {
  assert.deepEqual(checkRuntimeGraphFiles(sourceFixture()), []);
  const artifactOnly = artifactFixture(sourceFixture());
  artifactOnly.delete(LAZY_CHUNK);
  assert.deepEqual(failed(compareWalletFiles({ sourceFiles: sourceFixture(), artifactFiles: artifactOnly, label: 'fixture' })),
    ['fixture: embedded-wallet file set equals source', `fixture: ${LAZY_CHUNK} present`, `fixture: ${RUNTIME_GRAPH_RESULT}`]);
  const both = sourceFixture();
  both.delete(LAZY_CHUNK);
  const results = compareWalletFiles({ sourceFiles: both, artifactFiles: artifactFixture(both), label: 'fixture' });
  assert.deepEqual(failed(results), [`fixture: ${LAZY_CHUNK} present`, `fixture: ${RUNTIME_GRAPH_RESULT}`]);
  assert.equal(results.at(-1).detail, 'runtime-chunks/chunk-CCCCCCCC.mjs missing');
});

test('runtime graph: the entry banner is required, and an absent runtime is named', () => {
  const unlabelled = runtimeGraphFixture({ ...GRAPH_SOURCES, 'demos-runtime.mjs': '/* hand-made */\nexport * from "./runtime-chunks/entry-AAAAAAAA.mjs";\n' });
  assert.deepEqual(checkRuntimeGraphFiles(sourceFixture(unlabelled)), [
    'runtime banner missing (not the generated wallet-build output)',
    'runtime banner does not name the pinned upstream SDK 4.0.16',
  ]);
  assert.deepEqual(checkRuntimeGraphFiles(new Map()), ['runtime entry demos-runtime.mjs missing', 'runtime-manifest.json missing']);
});

test('candidate manifest binding: equal hashes pass, any drift is named', () => {
  const source = sourceFixture();
  const assets = walletAssetsFor(source);
  const manifest = { files: assets.map((p) => ({ path: `chatgpt/${p}`, sha256: sha256(source.get(p)), bytes: source.get(p).length })) };
  assert.deepEqual(compareWithCandidateManifest(manifest, source), []);
  manifest.files[2].sha256 = '0'.repeat(64);
  assert.deepEqual(compareWithCandidateManifest(manifest, source), [`${assets[2]} differs from candidate manifest`]);
  manifest.files.pop();
  assert.equal(compareWithCandidateManifest(manifest, source).at(-1), `${assets.at(-1)} not in candidate manifest`);
});

// ---- HTTP responses ----------------------------------------------------------

test('asset response: control passes for every asset; each defect is reported alone', () => {
  const source = sourceFixture();
  for (const path of walletAssetsFor(source)) assert.deepEqual(checkAssetResponse(path, source.get(path), validResponse(path, source.get(path))), [], path);
  assert.deepEqual(checkAssetResponse(RUNTIME_MANIFEST_ASSET, source.get(RUNTIME_MANIFEST_ASSET), { ...validResponse(RUNTIME_MANIFEST_ASSET, source.get(RUNTIME_MANIFEST_ASSET)), contentType: 'text/plain' }),
    ['content-type text/plain != application/json']);
  const path = `${WALLET_DIR}/ui.mjs`;
  const good = () => validResponse(path, source.get(path));
  assert.deepEqual(checkAssetResponse(path, source.get(path), { ...good(), status: 404 }), ['status 404']);
  assert.deepEqual(checkAssetResponse(path, source.get(path), { ...good(), contentType: 'application/octet-stream' }), ['content-type application/octet-stream != text/javascript']);
  assert.deepEqual(checkAssetResponse(path, source.get(path), { ...good(), contentType: null }), ['content-type (none) != text/javascript']);
  assert.deepEqual(checkAssetResponse(path, source.get(path), { ...good(), nosniff: null }), ['x-content-type-options nosniff missing']);
  const body = Buffer.from(source.get(path));
  body[body.length - 1] ^= 1;
  assert.match(checkAssetResponse(path, source.get(path), { ...good(), body }).join(), /^body sha256 [0-9a-f]{64} != [0-9a-f]{64}$/);
  assert.equal(mimeEssence('Text/JavaScript ; charset=UTF-8'), 'text/javascript');
});

test('health: control passes; a configured or missing dependency flag fails', () => {
  assert.deepEqual(checkHealthUnconfigured(validHealth()), []);
  const chain = validHealth();
  chain.dependencies.chain = { configured: true, rpcOrigin: 'http://127.0.0.1:1' };
  assert.deepEqual(checkHealthUnconfigured(chain), ['chain.configured is true (expected false)']);
  const absent = validHealth();
  delete absent.dependencies.externalIssuer;
  assert.deepEqual(checkHealthUnconfigured(absent), ['externalIssuer.configured is undefined (expected false)']);
  assert.deepEqual(checkHealthUnconfigured({ ...validHealth(), status: 'degraded' }), ['status degraded']);
  assert.ok(checkHealthUnconfigured(null).length >= 4);
});

test('tool set: exact named set passes; a missing or extra tool fails', () => {
  assert.deepEqual(checkToolSet([...EXPECTED_TOOLS].reverse()), []);
  assert.deepEqual(checkToolSet(EXPECTED_TOOLS.filter((t) => t !== 'verify_deal')), ['missing verify_deal']);
  assert.deepEqual(checkToolSet([...EXPECTED_TOOLS, 'send_transaction']), ['unexpected send_transaction']);
});

// ---- container client arguments and startup wait ------------------------------

test('container args: only http://127.0.0.1:<port> plus a package root are accepted', () => {
  const ok = parseContainerArgs(['--origin', 'http://127.0.0.1:18787', '--package-root', '.', '--restart-cycle']);
  assert.equal(ok.origin, 'http://127.0.0.1:18787');
  assert.equal(ok.restartCycle, true);
  assert.equal(ok.startupTimeoutMs, 60_000);
  for (const origin of ['http://localhost:18787', 'http://0.0.0.0:18787', 'https://127.0.0.1:18787', 'http://127.0.0.1:18787/', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://203.0.113.2:8787']) {
    assert.throws(() => parseContainerArgs(['--origin', origin, '--package-root', '.']), UsageError, origin);
  }
  assert.throws(() => parseContainerArgs(['--origin', 'http://127.0.0.1:1']), /--package-root is required/);
  assert.throws(() => parseContainerArgs(['--origin', 'http://127.0.0.1:1', '--package-root', '.', '--startup-timeout-ms', '999999']), UsageError);
  assert.throws(() => parseContainerArgs(['--origin', 'http://127.0.0.1:1', '--package-root', '.', '--docker']), /unknown argument/);
});

test('waitForHealth: waits through refused connections, and is bounded', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return { ok: true, status: 200 };
  };
  const up = await waitForHealth('http://127.0.0.1:1', 5000, { fetchImpl: flaky, intervalMs: 5 });
  assert.equal(up.ok, true);
  assert.equal(calls, 3);
  const down = await waitForHealth('http://127.0.0.1:1', 60, { fetchImpl: async () => ({ ok: false, status: 503 }), intervalMs: 10 });
  assert.equal(down.ok, false);
  assert.equal(down.detail, 'status 503');
  assert.ok(down.waitedMs < 1000);
});

// ---- request and run bounds --------------------------------------------------------

test('withTimeout: a settled promise passes through; a hung one rejects within its bound', async () => {
  assert.equal(await withTimeout(Promise.resolve('value'), 1000, 'control'), 'value');
  await assert.rejects(withTimeout(Promise.reject(new Error('own error')), 1000, 'control'), /own error/);
  const started = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 50, 'MCP connect'), /^Error: MCP connect timed out after 50ms$/);
  assert.ok(Date.now() - started < 1000);
});

test('boundedSignal: aborts at its own timeout or when the overall signal aborts', async () => {
  const open = boundedSignal(10_000, new AbortController().signal);
  assert.equal(open.aborted, false);
  const overall = new AbortController();
  const linked = boundedSignal(10_000, overall.signal);
  overall.abort();
  assert.equal(linked.aborted, true);
  const short = boundedSignal(20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(short.aborted, true);
});

test('waitForHealth: stops promptly once the overall signal has aborted', async () => {
  let calls = 0;
  const refused = async () => {
    calls += 1;
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const overall = new AbortController();
  overall.abort();
  const started = Date.now();
  const result = await waitForHealth('http://127.0.0.1:1', 60_000, { fetchImpl: refused, intervalMs: 5, signal: overall.signal });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(Date.now() - started < 1000);
});

test('overall timeout arguments: defaults, accepted values and rejected values', () => {
  assert.equal(parsePackageArgs([]).overallTimeoutMs, DEFAULT_PACKAGE_OVERALL_MS);
  assert.equal(parsePackageArgs(['--overall-timeout-ms', '60000']).overallTimeoutMs, 60_000);
  for (const bad of ['0', '9999', '900001', 'abc', '15000.5']) assert.throws(() => parsePackageArgs(['--overall-timeout-ms', bad]), /overall-timeout-ms/, bad);
  const base = ['--origin', 'http://127.0.0.1:18787', '--package-root', '.'];
  assert.equal(parseContainerArgs(base).overallTimeoutMs, 240_000);
  assert.equal(parseContainerArgs([...base, '--startup-timeout-ms', '180000']).overallTimeoutMs, 240_000);
  assert.equal(parseContainerArgs([...base, '--overall-timeout-ms', '90000']).overallTimeoutMs, 90_000);
  for (const bad of ['89999', '900001', 'x']) {
    assert.throws(() => parseContainerArgs([...base, '--overall-timeout-ms', bad]), UsageError, bad);
  }
  assert.throws(() => parseContainerArgs([...base, '--startup-timeout-ms', '120000', '--overall-timeout-ms', '120000']), UsageError);
});

// ---- the real source tree (presence/size only, not functionality) ---------------

test('real package source: every wallet asset and declared graph file exists and the runtime graph is closed', () => {
  const files = readSourceFiles(PACKAGE_ROOT);
  const assets = walletAssetsFor(files);
  assert.ok(assets.length > WALLET_ASSETS.length, 'runtime chunks are declared');
  for (const path of assets) assert.ok(files.has(path), path);
  assert.deepEqual(checkRuntimeGraphFiles(files), []);
  assert.ok(![...files.keys()].some((p) => /node_modules|wallet-build/.test(p)));
  for (const path of files.keys()) assert.deepEqual(shippedPathFindings(path, []), [], path);
});
