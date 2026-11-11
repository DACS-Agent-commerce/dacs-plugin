#!/usr/bin/env node
// Package and installation smoke check (offline-capable, no deployment):
//  1. plugin.json / mcp.json shape (Agent Plugins portable layout + OpenAI extension)
//  2. .env.example contains placeholders only
//  3. `npm pack` file list: required files present, no tests/private/state files
//  4. install the packed tarball into a temp project offline, from a fresh npm cache
//     seeded with the SDK candidate and the locked closure (lifecycle scripts disabled),
//     start the installed binary, check /health and MCP initialize + tools/list,
//     then SIGTERM and require a clean exit.
// The archive directory (MANIFEST.json and the archives) is named by DACS_SDK_CANDIDATE_DIR.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CANDIDATE_DIR_ENV, installOffline, isolatedNpmEnv, lockProblems, seedOfflineCache } from './candidate-archives.mjs';
import { forbiddenPackagePaths } from './package-paths.mjs';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  if (!ok) process.exitCode = 1;
};
const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

// 1. manifests
const pkg = json('package.json');
const plugin = json('plugin.json');
const mcp = json('mcp.json');
check('plugin.json schema', plugin.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
check('plugin.json kebab-case name', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.name));
check('plugin.json version matches the v2 package', plugin.version === pkg.version && pkg.version === '1.0.0', `${plugin.version} / ${pkg.version}`);
check('plugin.json OpenAI extension', typeof plugin.extensions?.['com.openai']?.interface?.displayName === 'string');
check('mcp.json schema', mcp.$schema === 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
const servers = Object.values(mcp.mcpServers ?? {});
check('mcp.json streamable-http server', servers.length === 1 && servers[0].type === 'streamable-http' && /^https:\/\/[^/]+\/mcp$/.test(servers[0].url), servers[0]?.url);
check('mcp.json URL is an explicit placeholder until deployment', servers[0]?.url.includes('.invalid'));
check('skill present', readFileSync(join(root, 'skills/dacs-testnet-commerce/SKILL.md'), 'utf8').startsWith('---\nname: dacs-testnet-commerce\n'));

// 2. env template
const envLines = readFileSync(join(root, '.env.example'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
const suspicious = envLines.filter((l) => {
  const value = l.slice(l.indexOf('=') + 1);
  return /[A-Za-z0-9+/_-]{40,}/.test(value);
});
check('.env.example has placeholders only', suspicious.length === 0, suspicious.join(', '));
check('.env.example origins are .invalid placeholders', envLines.filter((l) => /_ORIGIN=|_URL=/.test(l) && !/chatgpt\.com/.test(l)).every((l) => l.includes('.invalid')));

// 3. pack file list
const { stdout: packJson } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const files = JSON.parse(packJson)[0].files.map((f) => f.path);
const forbidden = forbiddenPackagePaths(files);
check('packed files exclude tests, references and private/state files', forbidden.length === 0, forbidden.slice(0, 10).join(', '));
for (const required of ['bin/dacs-chatgpt-plugin.mjs', 'src/app.mjs', 'public/portal/index.html', 'plugin.json', 'mcp.json', '.env.example', 'skills/dacs-testnet-commerce/SKILL.md', 'docs/TESTER-QUICKSTART.md', 'docs/TESTING.md']) {
  check(`packed: ${required}`, files.includes(required));
}

// 4. install + boot smoke test
const work = mkdtempSync(join(tmpdir(), 'dacs-pack-smoke-'));
const repoRoot = join(root, '..');
const frozenLock = json('package-lock.json');
let seed;
let child;
try {
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', work, '--json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const tarball = join(work, JSON.parse(stdout)[0].filename);
  const project = join(work, 'project');
  await run('npm', ['init', '-y'], { cwd: work }).catch(() => {});
  await run('mkdir', ['-p', project]);
  await run('npm', ['init', '-y'], { cwd: project });
  seed = await seedOfflineCache({ archiveDir: process.env[CANDIDATE_DIR_ENV], lock: frozenLock, repoRoot, env: isolatedNpmEnv(work) });
  await installOffline(seed, ['install', tarball, '--omit=dev'], { cwd: project });
  check('installed packed tarball offline from the seeded cache with lifecycle scripts disabled', true);
  const installed = lockProblems(seed, join(project, 'package-lock.json'), `node_modules/${pkg.name}`);
  check('installed packages equal the candidate manifest and the frozen lockfile by integrity', installed.length === 0, installed.slice(0, 5).join('; '));

  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const bin = join(project, 'node_modules', '@dacs-agent-commerce', 'dacs-chatgpt-plugin', 'bin', 'dacs-chatgpt-plugin.mjs');
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bin], {
    cwd: project,
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: join(work, 'data'), DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let health = null;
  for (let i = 0; i < 50 && !health; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    health = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
  }
  check('installed server answers /health', health?.status === 'ok', stderr.slice(0, 300));
  check('health reports unconfigured live dependencies explicitly', health?.dependencies?.directory?.configured === false && health?.dependencies?.chain?.configured === false);
  const client = new Client({ name: 'pack-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  const { tools } = await client.listTools();
  // The v2 buyer surface plus the identity tools; publication is retired.
  const expectedTools = ['search_agents', 'get_listing', 'get_profile', 'get_account_status', 'start_wallet_link', 'prepare_purchase', 'get_purchase_status', 'verify_deal', 'cancel_wallet_handoff', 'get_identities', 'start_identity_action'].sort();
  const listedTools = tools.map((t) => t.name).sort();
  check('installed server: MCP initialize + tools/list over Streamable HTTP lists exactly the named v2 tools', JSON.stringify(listedTools) === JSON.stringify(expectedTools), listedTools.join(','));
  const search = await client.callTool({ name: 'search_agents', arguments: {} });
  check('unconfigured directory fails safely (no fixture fallback)', search.isError === true && /not configured/.test(search.content[0].text));
  await client.close();
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const exit = await exited;
  check('graceful SIGTERM shutdown exits 0', exit.code === 0, JSON.stringify(exit));
  child = null;
} catch (error) {
  check('install/boot smoke test', false, error.message.slice(0, 500));
} finally {
  child?.kill('SIGKILL');
}

// 5. Replay the Dockerfile's install/run steps (same copied file set, lockfile
// `npm ci --omit=dev --ignore-scripts`) without the base image, offline from the
// cache step 4 seeded; the image build itself needs a running Docker daemon and is
// reported separately.
const replay = mkdtempSync(join(tmpdir(), 'dacs-docker-replay-'));
try {
  for (const entry of ['package.json', 'package-lock.json', 'bin', 'src', 'public', 'skills', 'plugin.json', 'mcp.json']) {
    await run('cp', ['-R', join(root, entry), join(replay, entry)]);
  }
  if (!seed) throw new Error('step 4 seeded no cache');
  await installOffline(seed, ['ci', '--omit=dev'], { cwd: replay });
  check('Dockerfile steps: npm ci --omit=dev --ignore-scripts offline from lockfile', true);
  const { stdout: dev } = await run('npm', ['ls', 'playwright-core', '--json'], { cwd: replay }).catch((e) => ({ stdout: e.stdout ?? '{}' }));
  check('production install excludes dev-only browser tooling', !JSON.parse(dev).dependencies?.['playwright-core']);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/dacs-chatgpt-plugin.mjs'], {
    cwd: replay,
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: join(replay, 'data'), DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  let ok = false;
  for (let i = 0; i < 50 && !ok; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
  }
  check('Dockerfile CMD boots and HEALTHCHECK target answers', ok);
  proc.kill('SIGTERM');
  check('Dockerfile STOPSIGNAL SIGTERM exits cleanly', (await exited) === 0);
} catch (error) {
  check('Dockerfile replay', false, error.message.slice(0, 300));
} finally {
  rmSync(replay, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`);
process.stdout.write(`${results.filter((r) => r.ok).length}/${results.length} package checks passed\n`);
