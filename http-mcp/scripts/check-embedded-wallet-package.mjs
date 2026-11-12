#!/usr/bin/env node
// Artifact-bound packaging check for the EXPERIMENTAL embedded wallet assets
// (no deployment; the install needs no registry, see candidate-archives.mjs):
//  1. `npm pack` (lifecycle scripts off) into a fresh task directory; record the
//     exact tarball SHA-256 and confirm npm's reported sha512 integrity.
//  2. Read the tarball itself: every embedded-wallet file ships with bytes equal
//     to the source; the generated SDK module graph (demos-runtime.mjs plus
//     every runtime-chunks/ file listed in runtime-manifest.json, lazily loaded
//     chunks included) is complete, local-only and closed; and no wallet-build/,
//     stray node_modules, private or state files ship.
//  3. Install the tarball into a new task-owned project (lifecycle scripts off,
//     two fresh empty npm configs, offline from a seeded cache) and compare
//     installed bytes and the installed graph closure with the tarball.
//  4. Boot the INSTALLED bin on 127.0.0.1 with fresh cookie keys and data and no
//     directory/RPC configuration; check /health, MCP initialize + tools/list
//     over Streamable HTTP, and every wallet asset and every declared graph file
//     over HTTP (status, MIME, nosniff, exact bytes), then the graph closure of
//     the downloaded bytes.
//  5. Bounded SIGTERM shutdown and removal of the task directory.
//
// Asset presence and byte equality prove packaging only. They do NOT prove the
// wallet works: SDK/WASM initialisation, signing and browser behaviour are
// separate workstreams.
//
//   DACS_SDK_CANDIDATE_DIR=DIR node scripts/check-embedded-wallet-package.mjs
//        [--candidate-manifest FILE] [--keep] [--overall-timeout-ms N]
//
// Every npm run, HTTP request and MCP request has its own timeout, and the
// whole run has an overall deadline (default 480 s). Each result line is
// printed as soon as it is known, so a run stopped from outside still leaves
// partial evidence; the final JSON is printed on completion or deadline.
//
// Exit 0 all checks pass, 1 any check fails or the deadline passes.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { CANDIDATE_DIR_ENV, installOffline, isolatedNpmEnv, lockProblems, seedOfflineCache } from './candidate-archives.mjs';
import { RUNTIME_BANNER, RUNTIME_ENTRY, RUNTIME_MANIFEST, RUNTIME_SDK_LABEL, checkRuntimeGraph, parseRuntimeManifest, runtimeManifestPaths } from './embedded-wallet-runtime.mjs';

export { RUNTIME_BANNER, RUNTIME_SDK_LABEL };

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, '..');
export const WALLET_DIR = 'public/portal/embedded-wallet';
export const RUNTIME_ASSET = `${WALLET_DIR}/${RUNTIME_ENTRY}`;
export const RUNTIME_MANIFEST_ASSET = `${WALLET_DIR}/${RUNTIME_MANIFEST}`;

// Every hand-written file the standalone wallet page loads: the page, its
// module graph (main -> ui/stores -> vault/approval/dom, then sdk-provider +
// demos-runtime on first use), its stylesheet, the shared portal stylesheet it
// links, and the generated runtime's entry and manifest. The runtime's chunks
// are added from runtime-manifest.json by walletAssetsFor().
export const WALLET_ASSETS = [
  `${WALLET_DIR}/index.html`,
  `${WALLET_DIR}/main.mjs`,
  `${WALLET_DIR}/ui.mjs`,
  `${WALLET_DIR}/stores.mjs`,
  `${WALLET_DIR}/vault.mjs`,
  `${WALLET_DIR}/approval.mjs`,
  `${WALLET_DIR}/dom.mjs`,
  `${WALLET_DIR}/sdk-provider.mjs`,
  RUNTIME_ASSET,
  RUNTIME_MANIFEST_ASSET,
  `${WALLET_DIR}/embedded-wallet.css`,
  'public/portal/portal.css',
];

// WALLET_ASSETS plus every runtime graph file runtime-manifest.json declares in
// `files` (Map<relPath, Buffer>), eager and lazy alike. An unusable manifest
// adds nothing here; the graph check reports it.
export function walletAssetsFor(files) {
  const manifestBytes = files.get(RUNTIME_MANIFEST_ASSET);
  const declared = manifestBytes ? runtimeManifestPaths(parseRuntimeManifest(manifestBytes).manifest) : [];
  const extra = declared.map((p) => `${WALLET_DIR}/${p}`).filter((p) => !WALLET_ASSETS.includes(p)).sort();
  return [...WALLET_ASSETS, ...extra];
}

// The generated graph files of a Map<relPath, Buffer>, keyed relative to WALLET_DIR.
export function runtimeGraphFilesOf(files) {
  const prefix = `${WALLET_DIR}/`;
  return new Map([...files].filter(([p]) => p.startsWith(prefix)).map(([p, b]) => [p.slice(prefix.length), b])
    .filter(([p]) => p === RUNTIME_MANIFEST || p === RUNTIME_ENTRY || p.startsWith('runtime-chunks/')));
}

// The v2 MCP buyer surface plus the identity tools.
export const EXPECTED_TOOLS = ['search_agents', 'get_listing', 'get_profile', 'get_account_status', 'start_wallet_link', 'prepare_purchase', 'get_purchase_status', 'verify_deal', 'cancel_wallet_handoff', 'get_identities', 'start_identity_action'].sort();

export const MCP_REQUEST_TIMEOUT_MS = 15_000;
export const HTTP_TIMEOUT_MS = 20_000;
export const DEFAULT_PACKAGE_OVERALL_MS = 480_000;
export const MAX_OVERALL_MS = 900_000;

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Settles like `promise`, or rejects once `ms` has passed. The timer keeps
// the event loop alive so the bound fires even when the hung work holds no
// handle, and is cleared as soon as the promise settles.
export function withTimeout(promise, ms, what) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// A per-request timeout that also ends when the run's overall signal does.
export const boundedSignal = (ms, signal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));

export function parseOverallTimeout(value) {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 10_000 || ms > MAX_OVERALL_MS) throw new Error(`--overall-timeout-ms must be an integer in [10000, ${MAX_OVERALL_MS}]`);
  return ms;
}

export function expectedMime(path) {
  const ext = /\.[^./]+$/.exec(path)?.[0] ?? '';
  return MIME[ext] ?? null;
}

// Media-type essence of a Content-Type header value, lowercased.
export function mimeEssence(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

// Reads every regular file from an npm tarball (gzip + ustar/pax). Paths are
// returned relative to the single top-level directory ("package/").
export function parseTarEntries(gz) {
  const tar = gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let longName = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const stored = parseInt(field(148, 8).trim() || '0', 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== stored) throw new Error(`tar header checksum mismatch at offset ${offset}`);
    const sizeField = field(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) throw new Error('malformed tar size field');
    const size = parseInt(sizeField || '0', 8);
    if (offset + 512 + size > tar.length) throw new Error('truncated tar entry');
    const type = field(156, 1);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName;
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type !== '0' && type !== '') continue;
    const slash = name.indexOf('/');
    if (slash < 0) throw new Error(`tar entry outside a top-level directory: ${name}`);
    const rel = name.slice(slash + 1);
    if (rel.split('/').some((part) => part === '..' || part === '')) throw new Error(`unsafe tar entry path: ${name}`);
    files.set(rel, Buffer.from(body));
  }
  return files;
}

// Reasons a shipped path must not be in the artifact. Empty array = allowed.
// `bundledNames` is npm pack's own "bundled" list, empty unless the package
// declares bundled dependencies. Any other node_modules path is unexpected.
export function shippedPathFindings(rel, bundledNames = []) {
  const out = [];
  const bundled = bundledNames.some((name) => rel.startsWith(`node_modules/${name}/`));
  if (/^wallet-build\//.test(rel) || /(^|\/)wallet-build\//.test(rel)) out.push('wallet-build-shipped');
  if (!bundled && /(^|\/)node_modules\//.test(rel)) out.push('unexpected-node-modules');
  if (/(^|\/)\.env$|(^|\/)\.env\.(?!example$)[^/]+$/.test(rel)) out.push('env-file');
  if (/\.(sqlite3?|db)(-wal|-shm|-journal)?$/i.test(rel) || /(^|\/)\.(data|state)\//.test(rel)) out.push('runtime-state');
  if (/\.(pem|key|p12|pfx)$/i.test(rel) || /(^|\/)\.npmrc$/.test(rel)) out.push('credential-file');
  if (/(^|\/)[^/]*wallet[^/]*\.json$/i.test(rel)) out.push('wallet-json');
  if (!bundled && /^(test|references|scripts)\//.test(rel)) out.push('dev-only-files');
  if (!bundled && /(^|\/)(AGENTS\.md|STATUS\.md|ACCEPTANCE\.md)$/i.test(rel)) out.push('working-notes');
  return out;
}

// The generated runtime in one copy of the package (Map<relPath, Buffer>): the
// entry carries the generated banner naming the pinned SDK, and the module
// graph is complete, local-only and closed as runtime-manifest.json declares
// (see scripts/embedded-wallet-runtime.mjs). Packaging only, not functionality.
export function checkRuntimeGraphFiles(files) {
  const graph = runtimeGraphFilesOf(files);
  const entry = graph.get(RUNTIME_ENTRY);
  if (!entry) return ['runtime entry demos-runtime.mjs missing', ...checkRuntimeGraph(graph).filter((p) => p !== `${RUNTIME_ENTRY} missing`)];
  const problems = [];
  const head = entry.subarray(0, 1024).toString('utf8');
  if (!head.includes(RUNTIME_BANNER)) problems.push('runtime banner missing (not the generated wallet-build output)');
  if (!head.includes(RUNTIME_SDK_LABEL)) problems.push('runtime banner does not name the pinned upstream SDK 4.0.16');
  return [...problems, ...checkRuntimeGraph(graph)];
}

export const RUNTIME_GRAPH_RESULT = 'runtime module graph is complete, local and equal to runtime-manifest.json (packaging only, not functionality)';

// Compares the packed (or installed) wallet file set and bytes with the source.
// sourceFiles / artifactFiles: Map<relPath, Buffer>. The whole WALLET_DIR
// listing is compared too, so an unlisted missing or extra file is reported.
export function compareWalletFiles({ sourceFiles, artifactFiles, label }) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name: `${label}: ${name}`, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  const srcWallet = [...sourceFiles.keys()].filter((p) => p.startsWith(`${WALLET_DIR}/`)).sort();
  const artWallet = [...artifactFiles.keys()].filter((p) => p.startsWith(`${WALLET_DIR}/`)).sort();
  const missing = srcWallet.filter((p) => !artifactFiles.has(p));
  const extra = artWallet.filter((p) => !sourceFiles.has(p));
  add('embedded-wallet file set equals source', !missing.length && !extra.length, [missing.length && `missing ${missing.join(',')}`, extra.length && `extra ${extra.join(',')}`].filter(Boolean).join('; '));
  for (const path of walletAssetsFor(sourceFiles)) {
    const src = sourceFiles.get(path);
    const art = artifactFiles.get(path);
    if (!src || !art) {
      add(`${path} present`, false, !src ? 'absent from source' : 'absent from artifact');
      continue;
    }
    add(`${path} bytes match source`, sha256(src) === sha256(art), `${art.length} bytes sha256 ${sha256(art)}`);
  }
  const runtime = checkRuntimeGraphFiles(artifactFiles);
  const graphSize = runtimeManifestPaths(parseRuntimeManifest(artifactFiles.get(RUNTIME_MANIFEST_ASSET) ?? '').manifest).length;
  add(RUNTIME_GRAPH_RESULT, runtime.length === 0, runtime.slice(0, 10).join('; ') || `${graphSize} graph files`);
  return results;
}

export function checkShippedFileSet(paths, bundledNames = []) {
  const findings = paths.flatMap((p) => shippedPathFindings(p, bundledNames).map((id) => `${id}:${p}`));
  return { ok: findings.length === 0, findings };
}

// One HTTP response for one asset. `response` = { status, contentType, nosniff, body }.
export function checkAssetResponse(path, expectedBytes, response) {
  const problems = [];
  const want = expectedMime(path);
  if (response.status !== 200) problems.push(`status ${response.status}`);
  if (!want) problems.push('no expected MIME for extension');
  else if (mimeEssence(response.contentType) !== want) problems.push(`content-type ${response.contentType ?? '(none)'} != ${want}`);
  if (response.nosniff !== 'nosniff') problems.push('x-content-type-options nosniff missing');
  if (!response.body || sha256(response.body) !== sha256(expectedBytes)) {
    problems.push(`body sha256 ${response.body ? sha256(response.body) : '(none)'} != ${sha256(expectedBytes)}`);
  }
  return problems;
}

export function checkHealthUnconfigured(health) {
  const problems = [];
  const deps = health?.dependencies ?? {};
  if (health?.status !== 'ok') problems.push(`status ${health?.status}`);
  if (deps.database !== 'ok') problems.push(`database ${deps.database}`);
  for (const name of ['directory', 'chain', 'externalIssuer']) {
    if (deps[name]?.configured !== false) problems.push(`${name}.configured is ${JSON.stringify(deps[name]?.configured)} (expected false)`);
  }
  return problems;
}

export function checkToolSet(names) {
  const listed = [...names].sort();
  const missing = EXPECTED_TOOLS.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !EXPECTED_TOOLS.includes(t));
  return [...missing.map((t) => `missing ${t}`), ...extra.map((t) => `unexpected ${t}`)];
}

// Candidate-manifest binding: { files: [{ path: 'chatgpt/...', sha256, bytes }] }.
export function compareWithCandidateManifest(manifest, sourceFiles) {
  const byPath = new Map((manifest.files ?? []).map((f) => [f.path.replace(/^chatgpt\//, ''), f]));
  const problems = [];
  for (const path of walletAssetsFor(sourceFiles)) {
    const entry = byPath.get(path);
    const src = sourceFiles.get(path);
    if (!entry) problems.push(`${path} not in candidate manifest`);
    else if (!src) problems.push(`${path} absent from source`);
    else if (entry.sha256 !== sha256(src) || entry.bytes !== src.length) problems.push(`${path} differs from candidate manifest`);
  }
  return problems;
}

export function readSourceFiles(root) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.set(child, readFileSync(join(root, child)));
    }
  };
  walk(WALLET_DIR);
  for (const path of WALLET_ASSETS) if (!files.has(path) && existsSync(join(root, path))) files.set(path, readFileSync(join(root, path)));
  return files;
}

export async function fetchAsset(origin, path, { timeoutMs = HTTP_TIMEOUT_MS, signal } = {}) {
  const url = `${origin}/portal/assets/${path.replace(/^public\/portal\//, '')}`;
  const res = await fetch(url, { redirect: 'manual', signal: boundedSignal(timeoutMs, signal) });
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    nosniff: res.headers.get('x-content-type-options'),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

// Server-side checks shared by the installed-package and container checkers.
// `signal` is the run's overall deadline; every request is also bounded alone.
export async function checkRunningServer({ origin, expectedFiles, add, label, signal }) {
  const health = await fetch(`${origin}/health`, { signal: boundedSignal(10_000, signal) }).then((r) => r.json()).catch(() => null);
  const healthProblems = checkHealthUnconfigured(health);
  add(`${label}: /health ok with directory/chain/external issuer unconfigured`, healthProblems.length === 0, healthProblems.join('; '));

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'embedded-wallet-package-check', version: '1' });
  const mcp = { timeout: MCP_REQUEST_TIMEOUT_MS, maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS * 2, ...(signal ? { signal } : {}) };
  try {
    await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)), mcp), MCP_REQUEST_TIMEOUT_MS * 3, 'MCP connect');
    add(`${label}: MCP initialize over Streamable HTTP`, true, client.getServerVersion?.()?.name);
    const { tools } = await withTimeout(client.listTools(undefined, mcp), MCP_REQUEST_TIMEOUT_MS * 3, 'MCP tools/list');
    const toolProblems = checkToolSet(tools.map((t) => t.name));
    add(`${label}: MCP tools/list is exactly the named v2 tool set`, toolProblems.length === 0, toolProblems.join('; ') || `${tools.length} tools`);
  } catch (error) {
    add(`${label}: MCP initialize + tools/list`, false, String(error?.message ?? error).slice(0, 300));
  } finally {
    await withTimeout(client.close(), 5_000, 'MCP close').catch(() => {});
  }

  // Every declared asset, lazily loaded runtime chunks included, is downloaded
  // and hashed; the downloaded runtime graph must then be closed on its own.
  const downloaded = new Map();
  for (const path of walletAssetsFor(expectedFiles)) {
    const expected = expectedFiles.get(path);
    if (!expected) {
      add(`${label}: GET ${path}`, false, 'no expected bytes');
      continue;
    }
    try {
      const response = await fetchAsset(origin, path, { signal });
      const problems = checkAssetResponse(path, expected, response);
      if (response.status === 200) downloaded.set(path, response.body);
      add(`${label}: GET ${path} (MIME ${expectedMime(path)}, nosniff, exact bytes)`, problems.length === 0, problems.join('; ') || `${response.body.length} bytes`);
    } catch (error) {
      add(`${label}: GET ${path}`, false, String(error?.message ?? error).slice(0, 200));
    }
  }
  const graph = checkRuntimeGraphFiles(downloaded);
  add(`${label}: HTTP-downloaded ${RUNTIME_GRAPH_RESULT}`, graph.length === 0, graph.slice(0, 10).join('; '));
}

function npmCommand() {
  const cli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? { file: process.execPath, pre: [cli] } : { file: 'npm', pre: [] };
}

function runNpm(args, { cwd, env, timeout = 300_000, signal }) {
  const { file, pre } = npmCommand();
  return new Promise((resolveRun, reject) => {
    execFile(file, [...pre, ...args], { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(`npm ${args[0]} failed: ${String(stderr || error.message).slice(0, 400)}`));
      else resolveRun(stdout);
    });
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function parsePackageArgs(argv) {
  const args = { keep: false, candidateManifest: null, overallTimeoutMs: DEFAULT_PACKAGE_OVERALL_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--candidate-manifest') args.candidateManifest = argv[++i];
    else if (argv[i] === '--overall-timeout-ms') args.overallTimeoutMs = parseOverallTimeout(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

// Prints one result line as soon as the result is known.
export const formatResult = (r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`;

// Server children started by this process, so the CLI backstop can stop them.
const activeChildren = new Set();

export async function runPackageCheck({ packageRoot = PACKAGE_ROOT, candidateManifest = null, keep = false, overallTimeoutMs = DEFAULT_PACKAGE_OVERALL_MS, onResult } = {}) {
  const results = [];
  const record = (r) => {
    results.push(r);
    onResult?.(r);
  };
  const add = (name, ok, detail) => record({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  const overall = AbortSignal.timeout(overallTimeoutMs);
  const summary = { label: 'embedded-wallet package candidate (source frozen before portal integration edits)', overallTimeoutMs, tarball: null, assets: [] };

  const sourceFiles = readSourceFiles(packageRoot);
  if (candidateManifest) {
    const problems = compareWithCandidateManifest(JSON.parse(readFileSync(candidateManifest, 'utf8')), sourceFiles);
    summary.candidateManifestSha256 = sha256(readFileSync(candidateManifest));
    add('source wallet assets equal the frozen candidate manifest', problems.length === 0, problems.join('; '));
  } else {
    summary.candidateManifestSha256 = 'not-compared (no --candidate-manifest)';
  }

  const work = mkdtempSync(join(tmpdir(), 'dacs-ewpkg-'));
  summary.workDir = work;
  let child = null;
  let output = '';
  const cookieKeys = [randomBytes(32).toString('base64url')];
  try {
    const env = isolatedNpmEnv(work);
    const packDir = join(work, 'pack');
    mkdirSync(packDir);
    const packed = JSON.parse(await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: packageRoot, env, signal: overall }))[0];
    const tarballPath = join(packDir, packed.filename);
    const tgz = readFileSync(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    summary.tarball = { filename: packed.filename, bytes: tgz.length, sha256: sha256(tgz), integrity, entryCount: packed.entryCount };
    add('npm pack (scripts off) tarball matches npm-reported integrity', packed.integrity === integrity, `sha256 ${summary.tarball.sha256}`);

    const tarFiles = parseTarEntries(tgz);
    const bundledNames = [...(packed.bundled ?? [])].sort();
    summary.tarball.bundledCount = bundledNames.length;
    const shipped = checkShippedFileSet([...tarFiles.keys()], bundledNames);
    add('tarball ships no wallet-build, non-bundled node_modules, private or state files', shipped.ok, shipped.findings.slice(0, 10).join(', ') || `${tarFiles.size} files, ${bundledNames.length} npm-bundled packages`);
    compareWalletFiles({ sourceFiles, artifactFiles: tarFiles, label: 'tarball' }).forEach(record);
    summary.assets = walletAssetsFor(tarFiles).filter((p) => tarFiles.has(p)).map((p) => ({ path: p, bytes: tarFiles.get(p).length, sha256: sha256(tarFiles.get(p)), mime: expectedMime(p) }));

    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'dacs-ewpkg-install-check', version: '0.0.0', private: true }, null, 2)}\n`);
    const installEnv = { ...env, npm_config_cache: join(work, 'npm-install-cache') };
    const seed = await seedOfflineCache({ archiveDir: process.env[CANDIDATE_DIR_ENV], lock: JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8')), repoRoot: resolve(packageRoot, '..'), env: installEnv });
    add('cache seeded from the SDK candidate and the locked closure archives, registry closed', true, `${seed.entries.size} packages`);
    await installOffline(seed, ['install', tarballPath, '--omit=dev'], { cwd: project, signal: overall });
    const installedRoot = join(project, 'node_modules', '@dacs-agent-commerce', 'dacs-chatgpt-plugin');
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
    const lockEntry = lock.packages?.['node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin'];
    add('installed from this tarball (lockfile integrity equals tarball)', lockEntry?.integrity === integrity, lockEntry?.integrity ? '' : 'npm recorded no integrity');
    const lockIssues = lockProblems(seed, join(project, 'package-lock.json'), 'node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin');
    add('installed packages equal the candidate manifest and the frozen lockfile by integrity', lockIssues.length === 0, lockIssues.slice(0, 5).join('; '));
    const installedFiles = readSourceFiles(installedRoot);
    compareWalletFiles({ sourceFiles: tarFiles, artifactFiles: installedFiles, label: 'installed' }).forEach(record);
    add('installed package has no wallet-build directory', !existsSync(join(installedRoot, 'wallet-build')));

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const pkg = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    const bin = join(installedRoot, typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]);
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bin], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DACS_PUBLIC_ORIGIN: origin,
        DACS_ALLOW_INSECURE_LOCALHOST: '1',
        DACS_DATA_DIR: join(work, 'data'),
        DACS_OAUTH_COOKIE_KEYS: cookieKeys.join(','),
        DACS_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    child.once('exit', () => activeChildren.delete(child));
    const collect = (d) => {
      if (output.length < 256 * 1024) output += d;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

    let up = false;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && !up && child.exitCode === null && !overall.aborted;) {
      await delay(200);
      up = await fetch(`${origin}/health`, { signal: boundedSignal(2000, overall) }).then((r) => r.ok).catch(() => false);
    }
    add('installed bin boots on 127.0.0.1 within 30s', up, up ? origin : `exit ${child.exitCode}`);
    if (up) await checkRunningServer({ origin, expectedFiles: tarFiles, add, label: 'installed server', signal: overall });

    child.kill('SIGTERM');
    const stop = await Promise.race([exited, delay(15_000).then(() => null)]);
    add('SIGTERM shutdown exits 0 within 15s', stop?.code === 0, JSON.stringify(stop));
    if (stop) child = null;
    add('server output contains no cookie key', !cookieKeys.some((k) => output.includes(k)));
  } catch (error) {
    add('package/install/boot', false, String(error?.message ?? error).slice(0, 500));
  } finally {
    if (child) {
      child.kill('SIGKILL');
      await delay(200);
    }
    if (!keep) {
      rmSync(work, { recursive: true, force: true });
      add('task work directory removed', !existsSync(work));
    }
  }
  add(`run finished within the ${overallTimeoutMs}ms overall deadline`, !overall.aborted);
  return { status: results.every((r) => r.ok) ? 'pass' : 'fail', results, summary };
}

// Last resort if the run itself stops making progress: stop server children,
// print a final JSON with status "timeout" and exit 1.
export function startBackstop(ms, finalJson) {
  const timer = setTimeout(() => {
    for (const c of activeChildren) c.kill('SIGKILL');
    process.stdout.write(`${JSON.stringify({ ...finalJson(), status: 'timeout', detail: `no result within ${ms}ms; run abandoned` }, null, 2)}\n`);
    process.exit(1);
  }, ms);
  timer.unref();
  return timer;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parsePackageArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-embedded-wallet-package: ${error.message}\n`);
    process.exit(2);
  }
  const seen = [];
  const backstop = startBackstop(args.overallTimeoutMs + 30_000, () => ({ passed: seen.filter((r) => r.ok).length, total: seen.length, overallTimeoutMs: args.overallTimeoutMs }));
  const { status, results, summary } = await runPackageCheck({
    ...args,
    onResult: (r) => {
      seen.push(r);
      process.stdout.write(formatResult(r));
    },
  });
  clearTimeout(backstop);
  process.stdout.write(`${JSON.stringify({ status, passed: results.filter((r) => r.ok).length, total: results.length, ...summary }, null, 2)}\n`);
  process.stdout.write(`${results.filter((r) => r.ok).length}/${results.length} embedded-wallet package checks passed\n`);
  process.exitCode = status === 'pass' ? 0 : 1;
  // Idle keep-alive sockets or a stuck handle must not hold the process open.
  setTimeout(() => process.exit(process.exitCode), 5_000).unref();
}
