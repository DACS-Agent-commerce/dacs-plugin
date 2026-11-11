// Package portability checks: the documented Node floor and the documented
// installed-CLI cold start. Ordinary offline functional checks with no live
// services, wallets or directory/chain configuration. Not a security review,
// live execution or v0.1 acceptance.
//
//   node --disable-warning=ExperimentalWarning --test test/overnight-package.test.mjs
//
// The clean-install subtest needs the public npm registry (TLS verification
// on); without it, it fails with a "precondition: npm registry …" message.
//
// DACS_PACKAGE_RETAIN_DIR=<dir> keeps the exact tested tarball and its SHA-256
// there; otherwise the tarball is removed with the task directory and only its
// SHA-256 and npm integrity are reported (npm pack is reproducible, see below).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_NAME = '@dacs-agent-commerce/dacs-chatgpt-plugin';
// node:sqlite (src/store/database.mjs) is importable without
// --experimental-sqlite from Node 22.13.0; every other runtime API and
// dependency engine range admits older 22.x releases.
const DOCUMENTED_FLOOR = '22.13.0';
const EXPECTED_TOOLS = ['cancel_wallet_handoff', 'get_account_status', 'get_identities', 'get_listing', 'get_profile',
  'get_purchase_status', 'prepare_purchase', 'search_agents', 'start_identity_action', 'start_wallet_link',
  'verify_deal'];

const json = (rel) => JSON.parse(readFileSync(join(PACKAGE_ROOT, rel), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal semver range check for the forms used by the locked packages ----
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return m ? m.slice(1).map(Number) : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
// True/false for `version` against a range of comparator sets joined by ||.
// Throws on any form it does not understand, so nothing passes by default.
export function admits(range, version) {
  const v = parseVersion(version);
  if (!v) throw new Error(`bad version ${version}`);
  // Parse every token before evaluating any, so an unsupported token always throws.
  const sets = range.split('||').map((alternative) => {
    const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error(`empty comparator set in "${range}"`);
    return tokens.map((token) => {
      if (token === '*') return null;
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(token);
      if (!m) throw new Error(`unsupported range token "${token}" in "${range}"`);
      // An x/* part is the same as an omitted one.
      return m.map((part) => (/^[xX*]$/.test(part ?? '') ? undefined : part));
    });
  });
  return sets.some((comparators) => {
    return comparators.every((comparator) => {
      if (comparator === null) return true;
      const [, op = '', major, minor, patch] = comparator;
      const base = [Number(major), Number(minor ?? 0), Number(patch ?? 0)];
      const c = cmp(v, base);
      switch (op) {
        case '>=': return c >= 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '<': return c < 0;
        case '^': return c >= 0 && (base[0] > 0 ? v[0] === base[0] : v[0] === 0 && v[1] === base[1]);
        case '~': return c >= 0 && v[0] === base[0] && v[1] === base[1];
        default:
          if (minor === undefined) return v[0] === base[0];
          if (patch === undefined) return v[0] === base[0] && v[1] === base[1];
          return c === 0;
      }
    });
  });
}

test('range check: accepting and refusing controls for the forms in the lockfile', () => {
  assert.equal(admits('>=22.13.0', '22.13.0'), true);
  assert.equal(admits('>=22.13.0', '22.12.9'), false);
  assert.equal(admits('^20.19.0 || >=22.12.0', '22.13.0'), true);
  assert.equal(admits('^20.19.0 || >=22.12.0', '21.7.0'), false);
  assert.equal(admits('>= 0.6', '22.13.0'), true);
  assert.equal(admits('>=20', '19.9.9'), false);
  assert.equal(admits('>=22.14.0', DOCUMENTED_FLOOR), false);
  assert.equal(admits('>=0.6.x', '22.13.0'), true);
  assert.equal(admits('22.x', '22.13.0'), true);
  assert.equal(admits('21.x', '22.13.0'), false);
  assert.equal(admits('*', '22.13.0'), true);
  assert.equal(admits('*', '1.0.0'), true);
  assert.throws(() => admits('1.2.3 - 2.0.0', '22.13.0'), /unsupported range token/);
  assert.throws(() => admits('latest', '22.13.0'), /unsupported range token/);
});

test('the documented Node floor is the same in package.json, the lockfile root, the image and the tester docs', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  assert.equal(pkg.engines?.node, `>=${DOCUMENTED_FLOOR}`);
  assert.equal(lock.packages?.['']?.engines?.node, pkg.engines.node, 'package-lock.json root engines');
  for (const [file, re] of [['Dockerfile', /^FROM\s+node:(\d+\.\d+\.\d+)-/m]]) {
    const version = re.exec(readFileSync(join(PACKAGE_ROOT, file), 'utf8'))?.[1];
    assert.ok(version, `${file} names a node:<x.y.z> base image`);
    assert.equal(version.split('.')[0], '22', `${file} stays on Node 22`);
    assert.ok(admits(pkg.engines.node, version), `${file} base ${version} satisfies ${pkg.engines.node}`);
  }
  const quickstart = readFileSync(join(PACKAGE_ROOT, 'docs/TESTER-QUICKSTART.md'), 'utf8');
  assert.match(quickstart, /Node\.js 22\.13 or later \(`engines\.node` is `>=22\.13\.0`\)/);
});

// Locked packages that need Node ^22.22.2 or newer, above the documented floor. All of them come in through
// @kynesyslabs/demosdk -> sigstore; any other package is still refused.
const ABOVE_FLOOR = new Set([
  '@npmcli/agent', '@npmcli/fs', '@npmcli/redact', '@sigstore/bundle', '@sigstore/core', '@sigstore/sign', '@sigstore/tuf', '@sigstore/verify',
  '@tufjs/models', 'cacache', 'make-fetch-happen', 'minipass-fetch', 'proc-log', 'sigstore', 'ssri', 'tuf-js',
].map((name) => `node_modules/${name}`));

test('every locked runtime dependency admits the documented floor', () => {
  const lock = json('package-lock.json');
  const checked = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || entry.dev || entry.optional || ABOVE_FLOOR.has(key) || !entry.engines?.node) continue;
    checked.push(key);
    assert.ok(admits(entry.engines.node, DOCUMENTED_FLOOR), `${key} engines.node "${entry.engines.node}" refuses ${DOCUMENTED_FLOOR}`);
  }
  assert.ok(checked.includes('node_modules/@kynesyslabs/dacs'), 'the DACS SDK declares an engine range');
  assert.ok(checked.length >= 10, `${checked.length} locked runtime packages declare engines`);
});

// Node APIs added after 22.13 (release lines in which they first appeared).
// Shipped runtime code must not use them; source-only checkers may.
const NEWER_APIS = [
  ['module.registerHooks (22.15)', /\bregisterHooks\b/],
  ['module.findPackageJSON (22.14)', /\bfindPackageJSON\b/],
  ['zlib zstd (22.15)', /\bcreateZstd(Compress|Decompress)\b|\bzstd(Compress|Decompress)(Sync)?\b/],
  ['util.diff (22.15)', /\butil\.diff\(|\bimport\s*\{[^}]*\bdiff\b[^}]*\}\s*from\s*['"]node:util['"]/],
  ['process.execve (22.15)', /\bprocess\.execve\(/],
];
function shippedRuntimeFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(PACKAGE_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(m?js|cjs)$/.test(entry.name)) out.push(child);
    }
  };
  for (const dir of ['bin', 'src']) walk(dir);
  return out;
}

test('shipped server code uses no Node API newer than the documented floor', () => {
  const files = shippedRuntimeFiles();
  assert.ok(files.includes('bin/dacs-chatgpt-plugin.mjs') && files.includes('src/store/database.mjs'));
  const hits = [];
  for (const rel of files) {
    const text = readFileSync(join(PACKAGE_ROOT, rel), 'utf8');
    for (const [name, re] of NEWER_APIS) if (re.test(text)) hits.push(`${rel}: ${name}`);
  }
  assert.deepEqual(hits, []);
  // Refusing control: the source-only checker is allowed to (and does) use one.
  assert.match(readFileSync(join(PACKAGE_ROOT, 'scripts/check-offline-tester-package.mjs'), 'utf8'), NEWER_APIS[0][1]);
  // The floor's reason is still present: node:sqlite in the shipped store.
  assert.match(readFileSync(join(PACKAGE_ROOT, 'src/store/database.mjs'), 'utf8'), /from 'node:sqlite'/);
});

test('this runtime imports node:sqlite with no experimental flag (observed only on this Node)', async (t) => {
  t.diagnostic(`runtime Node ${process.versions.node}; Node ${DOCUMENTED_FLOOR} itself is not installed here and is not executed`);
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', "const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close(); console.log('sqlite-ok')"],
      { env: { PATH: process.env.PATH ?? '' }, timeout: 20_000 }, (error, stdout) => resolve({ code: error ? (error.code ?? 1) : 0, stdout }));
  });
  assert.deepEqual(result, { code: 0, stdout: 'sqlite-ok\n' });
});

// ---- installed documented CLI ---------------------------------------------------
const owned = [];
after(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

function npmCli(name) {
  const cli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', `${name}-cli.js`);
  assert.ok(existsSync(cli), `${name}-cli.js is installed next to this Node (${cli})`);
  return cli;
}
// Fresh empty npm configs and cache, lifecycle scripts off, TLS verification on.
function npmEnv(work) {
  const userconfig = join(work, 'npm-userconfig');
  const globalconfig = join(work, 'npm-globalconfig');
  writeFileSync(userconfig, '');
  writeFileSync(globalconfig, '');
  const keep = ['HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  return {
    ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    // The shebang `#!/usr/bin/env node` of an installed bin resolves this Node.
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_strict_ssl: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
}
// Runner preconditions, reported apart from candidate defects: the clean
// install fetches the locked dependencies from the public npm registry with
// TLS verification on, so an offline runner or a TLS-intercepting proxy fails
// here without saying anything about the package.
const REGISTRY_UNREACHABLE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network request to https:\/\/registry\.npmjs\.org\/\S* failed/;
const REGISTRY_TLS = /\b(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID)\b/;
export function registryPrecondition(stderr) {
  if (REGISTRY_TLS.test(stderr)) return 'precondition: npm registry TLS verification failed on this runner (not a product defect; verification stays on)';
  if (REGISTRY_UNREACHABLE.test(stderr)) return 'precondition: npm registry unreachable (not a product defect)';
  return null;
}

test('registry precondition classifier: network and TLS failures vs other npm errors', () => {
  assert.match(registryPrecondition('npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/zod failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'), /^precondition: npm registry unreachable/);
  assert.match(registryPrecondition('npm error code EAI_AGAIN'), /^precondition: npm registry unreachable/);
  assert.match(registryPrecondition('npm error code SELF_SIGNED_CERT_IN_CHAIN'), /^precondition: npm registry TLS verification failed/);
  assert.equal(registryPrecondition('npm error code EINTEGRITY\nnpm error sha512-... integrity checksum failed'), null);
  assert.equal(registryPrecondition('npm error code ETARGET\nnpm error notarget No matching version found for zod@9.9.9'), null);
});

function run(file, args, { cwd, env, timeout = 300_000 }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = String(stderr || error.message);
      const precondition = registryPrecondition(detail);
      reject(new Error(`${precondition ? `${precondition}: ` : ''}${args.slice(1, 3).join(' ')} failed: ${detail.slice(0, 400)}`));
    });
  });
}
async function pack(work, env, label) {
  const dir = join(work, label);
  mkdirSync(dir);
  const [packed] = JSON.parse(await run(process.execPath, [npmCli('npm'), 'pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: PACKAGE_ROOT, env }));
  const bytes = readFileSync(join(dir, packed.filename));
  return { path: join(dir, packed.filename), filename: packed.filename, bytes, sha256: sha256(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, npmIntegrity: packed.integrity };
}
function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
function refused(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(false));
    socket.once('connect', () => done(false));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
  });
}

// Starts the installed server in its own process group, waits for /health,
// runs `during`, then stops it:
// - `npx` runs the documented interactive `npx dacs-chatgpt-plugin` and stops
//   it as a terminal Ctrl-C does: SIGINT to the whole foreground group.
//   (SIGTERM to the npx process alone ends npx but leaves the server running;
//   observed with npm 10 on Node 22.22.0, so supervisors must run the bin directly.)
// - `shim` executes the npm-created node_modules/.bin/dacs-chatgpt-plugin
//   directly and SIGTERMs it, so the exit status is the server's own.
async function installedStart({ via, project, env, port, dataDir, cookieKeys, during }) {
  const [file, args] = via === 'npx'
    ? [process.execPath, [npmCli('npx'), 'dacs-chatgpt-plugin']]
    : [join(project, 'node_modules', '.bin', 'dacs-chatgpt-plugin'), []];
  const child = spawn(file, args, {
    cwd: project,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, npm_config_offline: 'true', PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: dataDir, DACS_OAUTH_COOKIE_KEYS: cookieKeys, DACS_LOG_LEVEL: 'info' },
  });
  let output = '';
  child.stdout.on('data', (c) => { if (output.length < 65536) output += c; });
  child.stderr.on('data', (c) => { if (output.length < 65536) output += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const started = Date.now();
  try {
    let health = null;
    while (!health && Date.now() - started < 60_000 && child.exitCode === null) {
      await delay(250);
      health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
    }
    const value = health ? await during(health) : null;
    if (via === 'npx') process.kill(-child.pid, 'SIGINT');
    else child.kill('SIGTERM');
    const stop = await Promise.race([exited, delay(15_000).then(() => null)]);
    return { health, value, startupMs: Date.now() - started, stop, portRefused: await refused(port), output };
  } finally {
    // Whatever the outcome, nothing from this start keeps running.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
}

test('source -> reproducible npm tarball -> clean install -> documented `npx dacs-chatgpt-plugin` cold start, HTTP + MCP, Ctrl-C; bin-shim restart, SIGTERM', { timeout: 600_000 }, async (t) => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-ovpkg-')));
  owned.push(work);
  const env = npmEnv(work);

  const first = await pack(work, env, 'pack-a');
  const second = await pack(work, env, 'pack-b');
  assert.equal(first.npmIntegrity, first.integrity, 'npm-reported integrity equals the file');
  assert.equal(second.sha256, first.sha256, 'two packs of the same source are byte-identical');
  t.diagnostic(`tarball ${first.filename} ${first.bytes.length} bytes sha256 ${first.sha256} ${first.integrity}`);
  const retain = process.env.DACS_PACKAGE_RETAIN_DIR;
  if (retain) {
    mkdirSync(retain, { recursive: true });
    copyFileSync(first.path, join(retain, first.filename));
    writeFileSync(join(retain, `${first.filename}.sha256`), `${first.sha256}  ${first.filename}\n`);
    assert.equal(sha256(readFileSync(join(retain, first.filename))), first.sha256);
    t.diagnostic(`retained ${join(retain, first.filename)}`);
  } else {
    t.diagnostic('DACS_PACKAGE_RETAIN_DIR not set: tarball removed with the task directory');
  }

  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'dacs-tester', version: '1.0.0', private: true }, null, 2)}\n`);
  await run(process.execPath, [npmCli('npm'), 'install', first.path, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], { cwd: project, env });
  const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity, first.integrity, 'installed from exactly this tarball');
  assert.ok(!existsSync(join(project, 'node_modules', 'playwright-core')), 'no dev dependency installed');
  const shim = join(project, 'node_modules', '.bin', 'dacs-chatgpt-plugin');
  assert.ok(existsSync(shim) && (statSync(shim).mode & 0o111) !== 0, 'npm created an executable dacs-chatgpt-plugin bin shim');

  const port = await freePort();
  const dataDir = join(project, 'data');
  const cookieKeys = randomBytes(32).toString('hex');
  const cold = await installedStart({
    via: 'npx', project, env, port, dataDir, cookieKeys,
    during: async () => {
      const client = new Client({ name: 'overnight-package', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      try {
        const { tools } = await client.listTools();
        const search = await client.callTool({ name: 'search_agents', arguments: {} });
        return { tools: tools.map((x) => x.name).sort(), searchError: search.isError === true && /not configured/.test(search.content?.[0]?.text ?? '') };
      } finally {
        await client.close();
      }
    },
  });
  const shutdownLogged = (output, signal) => output.split('\n').some((line) => /"event":"shutdown"/.test(line) && line.includes(`"signal":"${signal}"`));
  t.diagnostic(`[installed cold start via npx] ready in ${cold.startupMs}ms; npx stop after group SIGINT ${JSON.stringify(cold.stop)}; port refused after stop: ${cold.portRefused}`);
  t.diagnostic(`[installed cold start via npx] output events: ${cold.output.split('\n').map((l) => /"event":"([^"]+)"/.exec(l)?.[1] ?? (l.trim() ? `text(${l.trim().slice(0, 80)})` : '')).filter(Boolean).join(', ')}`);
  assert.equal(cold.health?.status, 'ok', `installed cold start answers /health: ${cold.output.slice(0, 300)}`);
  assert.equal(cold.health.dependencies?.directory?.configured, false);
  assert.equal(cold.health.dependencies?.chain?.configured, false);
  assert.deepEqual(cold.value.tools, EXPECTED_TOOLS, 'MCP initialize + tools/list over Streamable HTTP');
  assert.equal(cold.value.searchError, true, 'unconfigured directory fails safely, no fixture fallback');
  // npx's own status reflects npm's signal handling, not the server's exit
  // code, so the server's graceful path is observed directly: its shutdown
  // event and the closed port. The shim restart below checks the exit code.
  assert.ok(cold.stop, 'the npx process ended within 15s of Ctrl-C (group SIGINT)');
  assert.ok(shutdownLogged(cold.output, 'SIGINT'), 'the server received Ctrl-C and ran its graceful shutdown');
  assert.equal(cold.portRefused, true, 'the server stopped with npx (no orphaned listener)');
  assert.ok(!cold.output.includes(cookieKeys), 'cookie key not echoed');
  assert.ok(existsSync(join(dataDir, 'dacs-chatgpt.sqlite')), 'state database created in DACS_DATA_DIR');

  // Restart: same installed package and data directory, new process started
  // through the installed bin shim (not a same-process reopen).
  const restart = await installedStart({ via: 'shim', project, env, port, dataDir, cookieKeys, during: async () => true });
  t.diagnostic(`[installed restart via bin shim, same data dir] ready in ${restart.startupMs}ms; stop ${JSON.stringify(restart.stop)}`);
  assert.equal(restart.health?.status, 'ok', `restart on the existing state answers /health: ${restart.output.slice(0, 300)}`);
  assert.deepEqual(restart.stop, { code: 0, signal: null }, 'the server itself exits 0 on SIGTERM');
  assert.ok(shutdownLogged(restart.output, 'SIGTERM'));
  assert.equal(restart.portRefused, true);
  assert.ok(!restart.output.includes(cookieKeys), 'cookie key not echoed');
});
