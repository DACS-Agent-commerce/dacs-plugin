#!/usr/bin/env node
// Installed-artifact check for the offline tester launcher. SIMULATED loopback
// fixtures only: not Demos testnet, not funded, not ChatGPT, not security review.
//
//  1. `npm pack` the current source (lifecycle scripts off) into a fresh task
//     directory. Record the tarball path, SHA-256 and npm integrity, and that
//     the launcher files ship with source bytes.
//  2. Cold-install the tarball into a new task-only project with production
//     dependencies (scripts off, two fresh empty npm configs, TLS verification
//     on). Check installed bytes and that no dev dependency was installed.
//  3. Import the INSTALLED bin/dacs-chatgpt-offline-test.mjs and start it. A
//     module resolve hook records every import made from installed files: each
//     one must resolve to `node:` or inside the install project. Nothing may
//     resolve from the source checkout, test/, wallet-build/ or dev dependencies.
//  4. Real Chromium (DACS_TEST_CHROME, playwright-core from the source dev
//     dependencies as the DRIVER only) against the installed services:
//     - OAuth sign-in with a freshly created embedded wallet;
//     - verifying the shipped fixed-price listing;
//     - approving the exact payment terms, with exactly one accepted broadcast
//       and the server's independent settlement receipt (buyer, seller, amount,
//       nonce), cross-checked by the driver's own chain read;
//     - GitHub identity add through the shipped proof publisher, then remove,
//       read back through get_identities and the chain;
//     - encrypted backup restore in a fresh browser context.
//     Every browser request must go to the launched loopback origins, with no
//     console errors and no secret in requests, console, URLs or operator logs.
//  5. stop(): every advertised listener refuses connections and the fresh state
//     is removed. A second start is fresh: a new seller and buyer nonce 0.
//  6. The installed CLI with --json: public start information, a working
//     /health, SIGTERM exit 0, and every advertised service closed.
//
//   node scripts/check-offline-tester-package.mjs [--keep] [--overall-timeout-ms N]
//
// --keep leaves the task directory (tarball, install project, npm logs) in
// place and prints its path for inspection; otherwise it is removed at the end.
// Exit 0 when every clause passes, 1 on any failure (a missing browser fails).
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
// Namespace import: registerHooks is absent before Node 22.15, and a named
// import would fail at link time with an opaque error (see toolingPreflight).
import * as nodeModule from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTarEntries } from './check-embedded-wallet-package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = realpathSync(resolve(here, '..'));
export const PACKAGE_NAME = '@dacs-agent-commerce/dacs-chatgpt-plugin';
export const LAUNCHER_FILES = [
  'bin/dacs-chatgpt-offline-test.mjs',
  'bin/offline-fixtures/chain.mjs',
  'bin/offline-fixtures/directory.mjs',
  'bin/offline-fixtures/http.mjs',
  'bin/offline-fixtures/operator.mjs',
  'bin/offline-fixtures/proofs.mjs',
  'bin/offline-fixtures/seller.mjs',
  'docs/OFFLINE-TESTER.md',
];
export const DEFAULT_OVERALL_MS = 540_000;
const SCOPE = 'dacs.account.read dacs.purchases.write dacs.identities.write';
const GITHUB_HANDLE = 'offline-tester';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const strip0x = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Problems with one module resolution made FROM an installed file (pure).
// `packageRoot` is the installed plugin; only ITS test/ and wallet-build/ are
// source-only (dependencies may legitimately have e.g. a `test` module).
export function importFindings({ url, projectRoot, packageRoot, sourceRoot }) {
  if (url.startsWith('node:')) return [];
  if (!url.startsWith('file:')) return [`non-file import ${url.slice(0, 120)}`];
  const path = fileURLToPath(url);
  const out = [];
  if (!inside(projectRoot, path)) out.push(`outside the install project: ${path}`);
  if (inside(sourceRoot, path)) out.push(`resolves into the source checkout: ${path}`);
  if (inside(join(packageRoot, 'test'), path) || inside(join(packageRoot, 'wallet-build'), path)) out.push(`plugin test or wallet-build module: ${path}`);
  if (/[\\/]node_modules[\\/]playwright(-core)?[\\/]/.test(path)) out.push(`dev dependency module: ${path}`);
  return out;
}

export function parseArgs(argv) {
  const args = { keep: false, overallTimeoutMs: DEFAULT_OVERALL_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--overall-timeout-ms') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 60_000 || n > 900_000) throw new Error('--overall-timeout-ms must be an integer in [60000, 900000]');
      args.overallTimeoutMs = n;
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

// PUBLIC wallet UI state for diagnostics: page visibility/focus, aria-busy,
// the view heading, the wallet's fixed error line, control presence/enabled
// state and whether an approval dialog is open. Never input or textarea
// values, the DOM, the vault, keys, the phrase, the password or the backup.
export function walletUiState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('embedded-wallet');
    const buttons = [...(root?.querySelectorAll('button') ?? [])];
    const button = (label) => {
      const b = buttons.find((x) => x.textContent.trim() === label);
      return b ? { disabled: b.disabled } : null;
    };
    const error = root?.querySelector('.ew-error');
    const backupText = root?.querySelector('textarea.ew-backup-text');
    return {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      walletRoot: Boolean(root),
      ariaBusy: root?.getAttribute('aria-busy') ?? null,
      heading: root?.querySelector('h2')?.textContent.trim().slice(0, 60) ?? null,
      errorText: error && !error.hidden ? error.textContent.trim().slice(0, 160) : null,
      exportButton: button('Export encrypted backup'),
      // `hidden` attribute (the product's "shown" signal), whether CSS actually
      // renders the element, and only whether it has a value (never the value).
      backupTextShown: backupText ? !backupText.hidden : null,
      backupTextRendered: backupText ? getComputedStyle(backupText).display !== 'none' : null,
      backupTextHasValue: backupText ? backupText.value.length > 0 : null,
      restoreButton: button('Restore backup'),
      unlockButton: button('Unlock'),
      dialogOpen: Boolean(document.querySelector('dialog[open]')),
    };
  });
}

// Export finished, from public UI state only: the handler un-hid the backup
// text, it has a value, and the wallet is no longer busy. Visibility alone is
// NOT enough: an earlier CSS rule rendered the still-`hidden` textarea,
// so a visibility wait resolved before export and read an empty value.
// Retain this completion check as well as the real-browser hidden-state
// assertions below; neither presentation nor handler completion alone proves
// that the exported backup is ready for recovery.
export function backupExportComplete(state) {
  return state?.backupTextShown === true && state?.backupTextHasValue === true && state?.ariaBusy === 'false';
}

// Problems with an exported backup text, without echoing any of it.
export function backupTextProblems(text, address) {
  if (typeof text !== 'string' || !text.trim()) return ['backup text is empty'];
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return ['backup text is not JSON'];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['backup text is not a JSON object'];
  if (typeof value.address !== 'string' || value.address.toLowerCase() !== String(address).toLowerCase()) return ['backup does not name the wallet address'];
  return [];
}

// Polls public UI state until `predicate` holds or `timeoutMs` passes
// (bounded; returns the last state either way).
export async function waitForWalletState(page, predicate, { timeoutMs = 10000, intervalMs = 100, read = walletUiState } = {}) {
  const end = Date.now() + timeoutMs;
  let state = await read(page);
  while (!predicate(state) && Date.now() < end) {
    await delay(intervalMs);
    state = await read(page);
  }
  return { ok: predicate(state), state };
}

// Source tooling floor: this checker uses node:module.registerHooks (Node
// 22.15+; tested on 22.22.0). The INSTALLED package itself supports the
// documented runtime ^22.22.2 || ^24.15.0; this floor applies to the source checker only.
export const SOURCE_CHECKER_MIN_NODE = '22.15.0';
export function compareNodeVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}
// Explicitly passed values win, including `registerHooks: undefined` (a
// destructuring default would silently substitute the real one).
export function toolingPreflight(options = {}) {
  const version = Object.hasOwn(options, 'version') ? options.version : process.versions.node;
  const registerHooks = Object.hasOwn(options, 'registerHooks') ? options.registerHooks : nodeModule.registerHooks;
  const problems = [];
  if (compareNodeVersions(version, SOURCE_CHECKER_MIN_NODE) < 0) {
    problems.push(`the source package checker needs Node >= ${SOURCE_CHECKER_MIN_NODE} (tested on 22.22.0); this is Node ${version}. The installed launcher requires Node ^22.22.2 || ^24.15.0.`);
  }
  if (typeof registerHooks !== 'function') {
    problems.push('node:module.registerHooks is not available in this Node runtime; the source package checker needs it to verify installed imports');
  }
  return problems;
}

export const formatResult = (r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`;

// ---- npm (scripts off, TLS on, two fresh empty configs) ----------------------
function npmCommand() {
  const cli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? { file: process.execPath, pre: [cli] } : { file: 'npm', pre: [] };
}

function npmEnv(work) {
  const userconfig = join(work, 'npm-userconfig');
  const globalconfig = join(work, 'npm-globalconfig');
  writeFileSync(userconfig, '');
  writeFileSync(globalconfig, '');
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  return {
    ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
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

function runNpm(args, { cwd, env, timeout = 300_000, log }) {
  const { file, pre } = npmCommand();
  const started = Date.now();
  return new Promise((resolveRun, reject) => {
    execFile(file, [...pre, ...args], { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      log.push({ command: `npm ${args.join(' ')}`, cwd, exit: error ? (error.code ?? 'killed') : 0, ms: Date.now() - started, stderrTail: String(stderr).slice(-400) });
      if (error) reject(new Error(`npm ${args[0]} failed: ${String(stderr || error.message).slice(0, 400)}`));
      else resolveRun(stdout);
    });
  });
}

// ---- small driver helpers -----------------------------------------------------
function withTimeout(promise, ms, what) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// A fresh TCP connect (not fetch, whose pooled keep-alive sockets can report a
// reset instead). Resolves 'refused' when nothing listens, else the outcome.
export function probePort(origin, timeoutMs = 3000) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolveProbe) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const done = (outcome) => {
      socket.destroy();
      resolveProbe(outcome);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('accepting'));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED' ? 'refused' : `error ${error.code}`));
  });
}
async function stillOpen(origins) {
  const open = [];
  for (const o of origins) {
    const outcome = await probePort(o);
    if (outcome !== 'refused') open.push(`${o} ${outcome}`);
  }
  return open;
}

async function rpc(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: res.status, simulated: res.headers.get('x-dacs-simulation'), body: await res.json() };
}
const nodeCall = (url, message, data) => rpc(url, { method: 'nodeCall', params: [{ message, data }] });
const gcrIdentities = (url, address) => rpc(url, { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [address] }] });

class DriverOAuthProvider {
  constructor(redirectUrl, scope) {
    this._redirect = redirectUrl;
    this._scope = scope;
    this.authorizationUrl = null;
  }
  get redirectUrl() { return this._redirect; }
  get clientMetadata() {
    return { client_name: 'DACS offline tester package check', redirect_uris: [this._redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: this._scope };
  }
  clientInformation() { return this._client; }
  saveClientInformation(info) { this._client = info; }
  tokens() { return this._tokens; }
  saveTokens(tokens) { this._tokens = tokens; }
  redirectToAuthorization(url) { this.authorizationUrl = new URL(url); }
  saveCodeVerifier(v) { this._verifier = v; }
  codeVerifier() { return this._verifier; }
  saveDiscoveryState(s) { this._discovery = s; }
  discoveryState() { return this._discovery; }
}

function secretForms(secret) {
  return [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex')];
}
// Returns labels of haystacks containing a secret form; never the secret itself.
export function secretHits(haystacks, secrets) {
  const hits = [];
  haystacks.forEach((item, index) => {
    const text = typeof item === 'string' ? item : JSON.stringify(item);
    secrets.forEach((secret, which) => {
      if (secretForms(secret).some((f) => text.includes(f))) hits.push(`secret #${which} in item #${index}`);
    });
  });
  return hits;
}

// ---- the check ------------------------------------------------------------------
export async function runCheck({ keep = false, overallTimeoutMs = DEFAULT_OVERALL_MS, onResult } = {}) {
  const results = [];
  const add = (name, ok, detail) => {
    const r = { name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 600) } : {}) };
    results.push(r);
    onResult?.(r);
    return r.ok;
  };
  const deadline = Date.now() + overallTimeoutMs;
  const summary = { label: 'installed offline tester launcher (SIMULATED loopback fixtures)', overallTimeoutMs, node: process.versions.node, tarball: null, workDir: null, npm: [], installed: {} };
  const preflight = toolingPreflight();
  if (!add(`source checker tooling preflight (Node >= ${SOURCE_CHECKER_MIN_NODE} with node:module.registerHooks)`, preflight.length === 0, preflight.join('; ') || `Node ${process.versions.node}`)) {
    return { status: 'fail', results, summary };
  }
  const cleanups = [];
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-otpkg-')));
  summary.workDir = work;
  add('task directory is outside the source package', !inside(PACKAGE_ROOT, work), work);

  // Records resolutions made from installed files for the whole run.
  const installedImports = [];
  let projectRoot = null;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (projectRoot && context.parentURL?.startsWith('file:') && inside(projectRoot, fileURLToPath(context.parentURL))) {
        installedImports.push({ parent: context.parentURL, url: resolved.url });
      }
      return resolved;
    },
  });

  let handle = null;
  try {
    // 1. pack
    const env = npmEnv(work);
    const packDir = join(work, 'pack');
    mkdirSync(packDir);
    const packed = JSON.parse(await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: PACKAGE_ROOT, env, log: summary.npm }))[0];
    const tarballPath = join(packDir, packed.filename);
    const tgz = readFileSync(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    summary.tarball = { path: tarballPath, bytes: tgz.length, sha256: sha256(tgz), integrity, entryCount: packed.entryCount };
    add('npm pack (scripts off) tarball matches npm-reported integrity', packed.integrity === integrity, `sha256 ${summary.tarball.sha256}`);
    const tarFiles = parseTarEntries(tgz);
    for (const rel of LAUNCHER_FILES) {
      const src = readFileSync(join(PACKAGE_ROOT, rel));
      const art = tarFiles.get(rel);
      add(`tarball ships ${rel} with source bytes`, art && sha256(art) === sha256(src), art ? `${art.length} bytes sha256 ${sha256(art)}` : 'absent');
    }
    const devOnly = [...tarFiles.keys()].filter((p) => /^(test|wallet-build|scripts)\//.test(p));
    add('tarball ships no test/, wallet-build/ or scripts/ files', devOnly.length === 0, devOnly.slice(0, 5).join(', '));

    // 2. cold install, production dependencies only
    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'dacs-offline-tester-install-check', version: '0.0.0', private: true }, null, 2)}\n`);
    await runNpm(['install', tarballPath, '--omit=optional', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: project, env, log: summary.npm });
    projectRoot = realpathSync(project);
    const installedRoot = join(projectRoot, 'node_modules', ...PACKAGE_NAME.split('/'));
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
    add('installed from this tarball (lockfile integrity equals tarball)', lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity === integrity);
    for (const rel of LAUNCHER_FILES) {
      const path = join(installedRoot, rel);
      const bytes = existsSync(path) ? readFileSync(path) : null;
      summary.installed[rel] = bytes ? sha256(bytes) : null;
      add(`installed ${rel} equals the tarball`, bytes && sha256(bytes) === sha256(tarFiles.get(rel) ?? Buffer.alloc(0)));
    }
    add('no dev dependency (playwright-core) or wallet-build in the install', !existsSync(join(projectRoot, 'node_modules', 'playwright-core')) && !existsSync(join(installedRoot, 'wallet-build')) && !existsSync(join(installedRoot, 'test')));

    // 3. import and start the INSTALLED launcher
    const binPath = join(installedRoot, 'bin', 'dacs-chatgpt-offline-test.mjs');
    const installed = await import(pathToFileURL(binPath).href);
    add('installed bin exports startOfflineTester', typeof installed.startOfflineTester === 'function');

    const callbackHits = [];
    const callback = http.createServer((req, res) => {
      callbackHits.push(new URL(req.url, 'http://cb').pathname);
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end('<!doctype html><title>callback</title><p>OAuth client callback (check driver)</p>');
    });
    await new Promise((r) => callback.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => { callback.close(() => r()); callback.closeAllConnections(); }));
    const callbackOrigin = `http://127.0.0.1:${callback.address().port}`;

    const operatorLogs = [];
    handle = await installed.startOfflineTester({ redirectOrigins: [callbackOrigin], logLevel: 'info', logSink: (line) => operatorLogs.push(line) });
    const advertised = [handle.origin, handle.fixtures.chain, handle.fixtures.directory, handle.fixtures.proofs];
    add('installed operator starts on loopback only', advertised.every((o) => /^http:\/\/127\.0\.0\.1:\d+$/.test(o)), advertised.join(' '));
    const profile = await (await fetch(`${handle.origin}/portal/api/embedded-wallet/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    add('installed app enables the simulated-loopback embedded-wallet profile with GitHub lookup', profile.writes === 'simulated-loopback' && profile.githubLookup === true && profile.evidenceMode === 'simulated-fixture', JSON.stringify({ writes: profile.writes, githubLookup: profile.githubLookup }));

    // 4. real browser workflow
    await browserWorkflow({ handle, add, callbackOrigin, callbackHits, operatorLogs, deadline });

    // 5. stop and reset
    const stateDir = handle.stateDir;
    await withTimeout(handle.stop(), 15_000, 'operator stop');
    handle = null;
    const open = await stillOpen(advertised);
    add('stop(): every advertised service refuses new TCP connections', open.length === 0, open.join(' '));
    add('stop(): fresh state directory removed', !existsSync(stateDir));
    const again = await installed.startOfflineTester({ logLevel: 'silent' });
    try {
      add('restart is fresh: a new synthetic seller', again.listing.seller !== summary.firstSeller, again.listing.seller.slice(0, 32));
      const nonce = summary.buyer ? (await nodeCall(again.fixtures.chain, 'getAddressNonce', { address: summary.buyer })).body.response : null;
      add('restart is fresh: the previous buyer nonce is 0 on the new fixture chain', nonce === 0, `nonce ${nonce}`);
    } finally {
      await withTimeout(again.stop(), 15_000, 'second operator stop');
    }

    // 3b. installed import graph
    const findings = installedImports.flatMap((i) => importFindings({ url: i.url, projectRoot, packageRoot: installedRoot, sourceRoot: PACKAGE_ROOT }));
    const loadedOwn = installedImports.some((i) => i.url.endsWith('/bin/offline-fixtures/operator.mjs')) && installedImports.some((i) => i.url.endsWith('/src/app.mjs'));
    add('every import made by installed code resolves inside the install project (no source, test, wallet-build or dev modules)', loadedOwn && findings.length === 0, findings.slice(0, 5).join('; ') || `${installedImports.length} resolutions`);

    // 6. installed CLI
    await cliCheck({ binPath, cwd: projectRoot, add });
  } catch (error) {
    add('offline tester package check', false, String(error?.stack ?? error).slice(0, 600));
  } finally {
    if (handle) await withTimeout(handle.stop(), 15_000, 'operator stop (cleanup)').catch((e) => add('operator stop during cleanup', false, e.message));
    while (cleanups.length) await cleanups.pop()().catch((e) => add('cleanup step', false, e.message));
    if (keep) {
      add('task directory kept for inspection (--keep)', existsSync(work), work);
    } else {
      rmSync(work, { recursive: true, force: true });
      add('task directory removed', !existsSync(work));
    }
  }
  add(`run finished within the ${overallTimeoutMs}ms overall deadline`, Date.now() <= deadline);
  return { status: results.every((r) => r.ok) ? 'pass' : 'fail', results, summary };

  // ---- browser workflow (driver: source playwright-core + MCP client) -------
  async function browserWorkflow({ handle: h, add: check, callbackOrigin, callbackHits, operatorLogs }) {
    const chrome = process.env.DACS_TEST_CHROME;
    if (!chrome || !existsSync(chrome)) {
      check('real Chromium available (DACS_TEST_CHROME)', false, chrome ? `not found at ${chrome}` : 'DACS_TEST_CHROME is not set');
      return;
    }
    const { chromium } = await import('playwright-core');
    const { Client, StreamableHTTPClientTransport, auth } = await import('@modelcontextprotocol/client');
    const browserServer = await chromium.launchServer({ executablePath: chrome, headless: true });
    const proc = browserServer.process();
    cleanups.push(async () => {
      await withTimeout(browserServer.close(), 8000, 'browser close').catch(() => browserServer.kill());
      if (proc.exitCode === null && proc.signalCode === null) throw new Error('launched browser is still running');
    });
    const browser = await chromium.connect(browserServer.wsEndpoint());
    cleanups.push(() => browser.close());
    check('real Chromium launched', true, browser.version());

    const allowed = [h.origin, h.fixtures.proofs, callbackOrigin];
    const pages = [];
    async function open(context) {
      const page = await context.newPage();
      const rec = { page, requests: [], consoleErrors: [], consoleAll: [] };
      page.on('request', (r) => rec.requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' }));
      page.on('console', (m) => {
        rec.consoleAll.push(m.text());
        if (m.type() === 'error') rec.consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => rec.consoleErrors.push(e.message));
      pages.push(rec);
      return rec;
    }
    const walletOf = (p) => p.page.locator('#embedded-wallet');
    const dialogOf = (p) => p.page.locator('dialog');
    async function useEmbedded(p) {
      await p.page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
      await walletOf(p).getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 20000 });
    }
    async function shownAddress(scope) {
      await scope.getByRole('heading', { name: /^wallet unlocked$/i }).waitFor({ timeout: 30000 });
      const text = await scope.locator('dt', { hasText: /^Address$/ }).locator('xpath=following-sibling::dd[1]').innerText();
      if (!/^0x[0-9a-f]{64}$/.test(text.trim())) throw new Error('unlocked view shows no Demos address');
      return text.trim();
    }
    // `scope` is a Page or a Locator; the `has` locator must be page-rooted.
    const formWith = (scope, name) => scope.locator('form').filter({ has: (typeof scope.page === 'function' ? scope.page() : scope).getByRole('button', { name }) });
    async function unlock(scope, password) {
      const form = formWith(scope, /^unlock$/i);
      await form.locator('input[type="password"]').fill(password);
      await form.getByRole('button', { name: /^unlock$/i }).click();
      return shownAddress(scope);
    }
    async function connect(p, address) {
      await p.page.getByRole('button', { name: 'Connect wallet' }).click();
      await p.page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 10000 });
    }
    async function approve(p, expect = []) {
      const dialog = dialogOf(p);
      await dialog.waitFor({ timeout: 20000 });
      const content = await dialog.innerText();
      const missing = expect.filter((t) => !content.includes(t));
      if (missing.length) throw new Error(`approval dialog does not show ${missing.join(', ')}`);
      await dialog.getByRole('button', { name: /^approve$/i }).click();
      await dialog.waitFor({ state: 'detached', timeout: 20000 });
      return content;
    }
    async function step(p, label, fn) {
      try {
        await fn();
        return check(label, true);
      } catch (error) {
        const log = await p.page.locator('#log').innerText({ timeout: 2000 }).catch(() => '');
        check(label, false, `${error.message.split('\n')[0]}${log ? ` | portal log: ${log.replace(/\s+/g, ' ').slice(-300)}` : ''}`);
        return false;
      }
    }
    async function tool(provider, name, args = {}) {
      const client = new Client({ name: 'offline-tester-package-check', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), provider ? { authProvider: provider } : {}));
      try {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text?.slice(0, 300)}`);
        return result.structuredContent;
      } finally {
        await client.close();
      }
    }

    const context = await browser.newContext();
    cleanups.push(() => context.close());
    const password = `pw-${randomBytes(18).toString('base64url')}`;
    let phrase = null;
    let address = null;

    // A. OAuth sign-in with a freshly created embedded wallet.
    const provider = new DriverOAuthProvider(`${callbackOrigin}/oauth/callback`, SCOPE);
    const first = await auth(provider, { serverUrl: h.mcpUrl, scope: SCOPE });
    check('OAuth discovery + dynamic client registration redirect to the portal', first === 'REDIRECT', first);
    const login = await open(context);
    const signedIn = await step(login, 'OAuth sign-in: create embedded wallet, connect, approve account-login, return to the client', async () => {
      await login.page.goto(provider.authorizationUrl.href);
      await login.page.getByText('Link your DACS account').waitFor({ timeout: 15000 });
      await useEmbedded(login);
      const form = formWith(walletOf(login), /^create wallet$/i);
      const fields = form.locator('input[type="password"]');
      for (let i = 0; i < await fields.count(); i += 1) await fields.nth(i).fill(password);
      await form.getByRole('button', { name: /^create wallet$/i }).click();
      address = await shownAddress(walletOf(login));
      const region = walletOf(login).getByRole('region', { name: 'Recovery phrase' });
      await region.waitFor({ timeout: 10000 });
      phrase = (await region.locator('li').allInnerTexts()).map((w) => w.trim()).join(' ');
      await connect(login, address);
      await login.page.getByRole('button', { name: 'Sign in and allow' }).click();
      await approve(login, ['purpose: account-login', address]);
      await login.page.waitForURL(`${callbackOrigin}/**`, { timeout: 20000 });
    });
    if (!signedIn) return;
    const cb = new URL(login.page.url());
    const second = await auth(provider, { serverUrl: h.mcpUrl, authorizationCode: cb.searchParams.get('code'), iss: cb.searchParams.get('iss'), scope: SCOPE });
    check('OAuth token exchange (PKCE, iss) authorizes the MCP client', second === 'AUTHORIZED', second);
    summary.buyer = address;
    summary.firstSeller = h.listing.seller;
    const account = await tool(provider, 'get_account_status');
    check('server linked the embedded wallet address after verifying its signature', account.wallets?.some((w) => w.address === address));

    // B. Shipped fixed-price listing.
    const found = await tool(null, 'search_agents', { query: 'offline fixture' });
    check('search_agents lists the shipped fixture listing (simulated-fixture)', found.evidenceMode === 'simulated-fixture' && found.results.some((r) => r.listingId === h.listing.listingId && r.seller === h.listing.seller));
    const listing = await tool(null, 'get_listing', { listingId: h.listing.listingId, version: 1, seller: h.listing.seller });
    check('get_listing verifies the shipped listing: transactable, 1.5 DEM, chain readback simulated-fixture', listing.transactable === true && listing.disposition === 'verified' && listing.price?.amountOs === '1500000000' && listing.evidence?.chainMode === 'simulated-fixture', JSON.stringify({ t: listing.transactable, d: listing.disposition, p: listing.price }));

    // C. Payment: exact terms, one broadcast, independent receipt.
    const prepared = await tool(provider, 'prepare_purchase', { listingId: h.listing.listingId, version: 1, seller: h.listing.seller, idempotencyKey: `otpkg-buy-${Date.now()}`, walletAddress: address });
    check('prepare_purchase awaits approval with the listing terms', prepared.status === 'awaiting_approval' && prepared.terms.amountOs === '1500000000' && prepared.terms.payee === h.listing.sellerAddress, prepared.status);
    const before = h.chainStats();
    const pay = await open(context);
    const paid = await step(pay, 'portal purchase: unlock, approve exact terms, approve the transaction, simulated receipt shown', async () => {
      await pay.page.goto(prepared.approvalUrl);
      await useEmbedded(pay);
      if ((await unlock(walletOf(pay), password)) !== address) throw new Error('unlock restored a different address');
      await connect(pay, address);
      await pay.page.getByText('Approve DEM testnet purchase').waitFor({ timeout: 15000 });
      await pay.page.getByRole('button', { name: 'Approve exact terms' }).click();
      await approve(pay, ['approve-purchase', h.listing.sellerAddress]);
      const tx = await approve(pay, [h.listing.sellerAddress, '1500000000', address, 'SIMULATED']);
      if (!/nonce/i.test(tx)) throw new Error('transaction approval does not show the nonce');
      await pay.page.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
    });
    const after = h.chainStats();
    check('exactly one accepted confirm and one accepted broadcast for the purchase', after.confirmAccepted - before.confirmAccepted === 1 && after.broadcastAccepted - before.broadcastAccepted === 1 && after.broadcastRejected === before.broadcastRejected, JSON.stringify({ confirm: after.confirmAccepted - before.confirmAccepted, broadcast: after.broadcastAccepted - before.broadcastAccepted }));
    if (paid) {
      const status = await tool(provider, 'get_purchase_status', { operationId: prepared.operationId });
      const s = status.settlement ?? {};
      const o = s.observation ?? {};
      check('server observation: settled_verified from the server\'s own read of the one simulated-fixture RPC (tuple-only; not finality or a purchase-specific receipt)', status.status === 'settled_verified' && s.chainMode === 'simulated-fixture' && o.status === 'included', JSON.stringify({ status: status.status, mode: s.chainMode }));
      check('server observation: exact buyer, seller, amount and nonce', strip0x(o.payer) === strip0x(address) && strip0x(o.payee) === strip0x(h.listing.sellerAddress) && o.amountOs === '1500000000' && s.txNonce === 1 && status.expectedNonce === 1, JSON.stringify({ amountOs: o.amountOs, txNonce: s.txNonce, expected: status.expectedNonce }));
      const chainTx = await nodeCall(h.fixtures.chain, 'getTxByHash', { hash: s.txHash });
      const c = chainTx.body.response?.content ?? {};
      check('driver chain readback: the same transaction from buyer to seller, 1500000000 OS, nonce 1', chainTx.simulated === 'fixture' && strip0x(c.from) === strip0x(address) && strip0x(c.to) === strip0x(h.listing.sellerAddress) && String(c.amount) === '1500000000' && c.nonce === 1);
      check('receipt page shows the transaction hash', await pay.page.getByText(strip0x(s.txHash)).first().isVisible().catch(() => false) || await pay.page.getByText(`0x${strip0x(s.txHash)}`).first().isVisible().catch(() => false));
    }

    // D. GitHub identity add through the shipped proof publisher.
    const add1 = await tool(provider, 'start_identity_action', { idempotencyKey: `otpkg-add-${Date.now()}`, action: 'add', kind: 'github', walletAddress: address });
    const idPage = await open(context);
    let proofUrl = null;
    const beforeAdd = h.chainStats();
    const added = await step(idPage, 'identity add: proof text from the wallet, published on the shipped proof form, approved, association observed', async () => {
      await idPage.page.goto(add1.portalUrl);
      await useEmbedded(idPage);
      await unlock(walletOf(idPage), password);
      await connect(idPage, address);
      await idPage.page.getByRole('button', { name: 'Use my connected wallet' }).click();
      await idPage.page.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
      await approve(idPage);
      const proofText = (await idPage.page.locator('#proof-text').innerText({ timeout: 10000 })).trim();
      if (!/^demos:dw2p:ed25519:/.test(proofText)) throw new Error('wallet proof text has an unexpected form');
      const pub = await open(context);
      await pub.page.goto(`${h.fixtures.proofs}/`);
      await pub.page.selectOption('select[name=kind]', 'github');
      await pub.page.fill('input[name=username]', GITHUB_HANDLE);
      await pub.page.fill('input[name=proof]', proofText);
      await Promise.all([pub.page.waitForNavigation(), pub.page.click('button[type=submit]')]);
      proofUrl = (await pub.page.locator('#proof-url').innerText({ timeout: 10000 })).trim();
      await pub.page.close();
      await idPage.page.locator('#proof-url').fill(proofUrl);
      await idPage.page.getByRole('button', { name: 'Use this proof URL' }).click();
      await idPage.page.getByRole('button', { name: 'Approve in my wallet' }).click();
      await approve(idPage, ['addGithubIdentity', proofUrl, GITHUB_HANDLE, address]);
      await idPage.page.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
    });
    const afterAdd = h.chainStats();
    check('identity add: exactly one accepted broadcast', afterAdd.broadcastAccepted - beforeAdd.broadcastAccepted === 1);
    check('proof URL is a fixture-only gist URL for the handle', /^https:\/\/gist\.github\.com\/offline-tester\/[0-9a-f]{20}$/.test(proofUrl ?? ''), proofUrl);
    const handlesOf = (ids) => {
      const w = ids.wallets?.find((x) => x.address === address);
      const raw = w?.raw?.json ? JSON.parse(w.raw.json) : null;
      return { status: w?.status, mode: w?.evidence?.mode, web2: w?.counts?.web2, github: (raw?.response?.web2?.github ?? []).map((e) => e.username) };
    };
    if (added) {
      const ids = handlesOf(await tool(provider, 'get_identities', { walletAddress: address }));
      check('get_identities after add: observed, simulated-fixture, github handle present', ids.status === 'observed' && ids.mode === 'simulated-fixture' && ids.web2 === 1 && JSON.stringify(ids.github) === JSON.stringify([GITHUB_HANDLE]), JSON.stringify(ids));
      const direct = await gcrIdentities(h.fixtures.chain, address);
      check('driver chain readback after add: github handle associated', JSON.stringify((direct.body.response?.web2?.github ?? []).map((e) => e.username)) === JSON.stringify([GITHUB_HANDLE]));
    }

    // E. GitHub identity remove.
    const rm = await tool(provider, 'start_identity_action', { idempotencyKey: `otpkg-rm-${Date.now()}`, action: 'remove', kind: 'github', username: GITHUB_HANDLE, walletAddress: address });
    const rmPage = await open(context);
    const beforeRm = h.chainStats();
    const removed = await step(rmPage, 'identity remove: approved in the wallet, association no longer observed', async () => {
      await rmPage.page.goto(rm.portalUrl);
      await useEmbedded(rmPage);
      await unlock(walletOf(rmPage), password);
      await connect(rmPage, address);
      await rmPage.page.getByRole('button', { name: 'Use my connected wallet' }).click();
      await rmPage.page.getByRole('button', { name: 'Approve in my wallet' }).click();
      await approve(rmPage, ['removeWeb2Identity', GITHUB_HANDLE]);
      await rmPage.page.getByText('Association no longer observed on chain.').waitFor({ timeout: 30000 });
    });
    check('identity remove: exactly one accepted broadcast', h.chainStats().broadcastAccepted - beforeRm.broadcastAccepted === 1);
    if (removed) {
      const ids = handlesOf(await tool(provider, 'get_identities', { walletAddress: address }));
      check('get_identities after remove: observed, no github handle', ids.status === 'observed' && ids.web2 === 0 && ids.github.length === 0, JSON.stringify(ids));
      const nonce = await nodeCall(h.fixtures.chain, 'getAddressNonce', { address });
      check('buyer nonce is 3 after payment, add and remove', nonce.body.response === 3, `nonce ${nonce.body.response}`);
    }

    // F. Encrypted backup restore in a fresh context, in named substeps. Each
    // substep records only PUBLIC wallet UI state (walletUiState), so a
    // timeout names its exact stage instead of one combined wait.
    let backup = null;
    const stages = [];
    let stage = 'F0 not started';
    let restore = null;
    const snap = async (p, label) => {
      const s = await walletUiState(p.page).catch((e) => ({ unavailable: String(e?.message ?? e).split('\n')[0].slice(0, 120) }));
      stages.push({ stage: label, ...s });
      return s;
    };
    const backupOk = await (async () => {
      try {
        stage = 'F1 export button clicked on the unlocked portal wallet';
        const beforeExport = await snap(rmPage, 'F1 before export click');
        const concealedBeforeExport = beforeExport.backupTextShown === false && beforeExport.backupTextRendered === false
          && await walletOf(rmPage).getByRole('textbox', { name: /encrypted backup text/i }).count() === 0;
        check('backup textarea is hidden and absent from visible textbox roles before export', concealedBeforeExport);
        if (!concealedBeforeExport) throw new Error('backup textarea is incorrectly visible before export');
        await walletOf(rmPage).getByRole('button', { name: /^export encrypted backup$/i }).click({ timeout: 10000 });
        stage = 'F2 export finished: backup text shown with a value, wallet not busy';
        const done = await waitForWalletState(rmPage.page, backupExportComplete, { timeoutMs: 10000 });
        if (!done.ok) throw new Error('export did not finish within 10000ms');
        const text = walletOf(rmPage).getByRole('textbox', { name: /encrypted backup text/i });
        backup = (await text.inputValue({ timeout: 10000 })).trim();
        const afterExport = await snap(rmPage, 'F2 after export');
        const visibleAfterExport = backupExportComplete(afterExport) && afterExport.backupTextRendered === true && await text.isVisible();
        check('completed backup export shows a populated textbox while the wallet is idle', visibleAfterExport);
        if (!visibleAfterExport) throw new Error('completed backup export is not visible and populated');
        const problems = backupTextProblems(backup, address);
        if (problems.length) throw new Error(`exported backup precondition: ${problems.join('; ')}`);
        stage = 'F3 fresh context: setup view with the restore form';
        const fresh = await browser.newContext();
        cleanups.push(() => fresh.close());
        restore = await open(fresh);
        await restore.page.goto(h.embeddedWalletUrl);
        const form = formWith(restore.page, /^restore backup$/i);
        await form.getByLabel(/^or paste backup text$/i).waitFor({ timeout: 10000 });
        await snap(restore, 'F3 fresh setup view');
        stage = 'F4 restore submitted: locked view';
        await form.getByLabel(/^or paste backup text$/i).fill(backup);
        await form.getByRole('button', { name: /^restore backup$/i }).click({ timeout: 10000 });
        await restore.page.getByRole('heading', { name: /^wallet locked$/i }).waitFor({ timeout: 10000 });
        const afterRestore = await snap(restore, 'F4 after restore');
        const concealedAfterRestore = afterRestore.backupTextShown === false && afterRestore.backupTextRendered === false
          && await restore.page.getByRole('textbox', { name: /encrypted backup text/i }).count() === 0;
        check('locked restored wallet conceals its unexported backup textbox', concealedAfterRestore);
        if (!concealedAfterRestore) throw new Error('locked restored wallet exposes an unexported backup textbox');
        stage = 'F5 unlock restores the same address';
        if ((await unlock(restore.page, password)) !== address) throw new Error('restored wallet has a different address');
        return true;
      } catch (error) {
        await snap(stage.startsWith('F1') || stage.startsWith('F2') ? rmPage : restore ?? rmPage, `${stage.slice(0, 2)} at failure`);
        stages.push({ failedStage: stage, error: String(error?.message ?? error).split('\n')[0].slice(0, 200) });
        return false;
      }
    })();
    summary.backupDiagnostics = stages;
    check('encrypted backup restores the same address in a fresh browser context', backupOk, `${backupOk ? 'stages F1-F5 passed' : 'FAILED'}; ${JSON.stringify(stages).slice(0, 1400)}`);

    // G. Cross-cutting observations.
    const requests = pages.flatMap((p) => p.requests);
    const offOrigin = requests.filter((r) => !allowed.some((o) => r.url.startsWith(`${o}/`)));
    check('every browser request went to the launched loopback origins', offOrigin.length === 0, offOrigin.slice(0, 3).map((r) => new URL(r.url).origin).join(' '));
    check('OAuth callback reached the driver client once', callbackHits.filter((p) => p === '/oauth/callback').length === 1);
    const errors = pages.flatMap((p) => p.consoleErrors);
    check('no browser console errors (unfiltered)', errors.length === 0, errors.slice(0, 3).join(' | '));
    if (phrase && password) {
      const hits = secretHits([...requests, ...pages.flatMap((p) => p.consoleAll), ...pages.map((p) => p.page.url()), ...operatorLogs, ...(backup ? [backup] : [])], [phrase, password]);
      check('recovery phrase and password absent from requests, console, URLs, operator logs and the backup', hits.length === 0, hits.slice(0, 3).join('; '));
    } else {
      check('recovery phrase and password captured for the secret scan', false);
    }
  }
}

async function cliCheck({ binPath, cwd, add }) {
  const child = spawn(process.execPath, [binPath, '--json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir() } });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { if (out.length < 65536) out += c; });
  child.stderr.on('data', (c) => { if (err.length < 65536) err += c; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  try {
    for (const end = Date.now() + 30_000; !out.includes('\n') && Date.now() < end && child.exitCode === null;) await delay(100);
    let summary = null;
    try {
      summary = JSON.parse(out.split('\n')[0]);
    } catch {
      add('installed CLI --json prints one JSON start line', false, err.slice(0, 300));
      return;
    }
    add('installed CLI --json: running, SIMULATED notice, loopback MCP URL', summary.status === 'running' && /SIMULATED/.test(summary.notice) && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(summary.mcp));
    const health = await fetch(summary.health, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    add('installed CLI: /health ok with fixture chain and directory configured', health?.status === 'ok' && health?.dependencies?.chain?.configured === true && health?.dependencies?.directory?.configured === true);
    child.kill('SIGTERM');
    const stop = await Promise.race([exited, delay(15_000).then(() => null)]);
    add('installed CLI: SIGTERM exits 0 within 15s', stop?.code === 0, JSON.stringify(stop));
    const services = [summary.plugin, summary.fixtures.chain, summary.fixtures.directory, summary.fixtures.proofs];
    const open = await stillOpen(services);
    add('installed CLI: every advertised service refuses new TCP connections after SIGTERM', open.length === 0, open.join(' '));
    add('installed CLI output carries no cookie, secret, private key or mnemonic wording', !/cookie|secret|private|mnemonic/i.test(out + err));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-offline-tester-package: ${error.message}\n`);
    process.exit(2);
  }
  const backstop = setTimeout(() => {
    process.stdout.write('FAIL overall backstop: no result within the deadline; run abandoned\n');
    process.exit(1);
  }, args.overallTimeoutMs + 60_000);
  backstop.unref();
  const { status, results, summary } = await runCheck({ ...args, onResult: (r) => process.stdout.write(formatResult(r)) });
  clearTimeout(backstop);
  process.stdout.write(`${JSON.stringify({ status, passed: results.filter((r) => r.ok).length, total: results.length, ...summary, buyer: undefined, firstSeller: undefined }, null, 2)}\n`);
  process.stdout.write(`${results.filter((r) => r.ok).length}/${results.length} offline tester package checks passed\n`);
  process.exitCode = status === 'pass' ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 5_000).unref();
}
