#!/usr/bin/env node
// Installed-artifact check for the guided tester dashboard. SIMULATED loopback
// fixtures only: not Demos testnet, not funded, not ChatGPT, not a security review.
//
//  1. `npm pack` (scripts off) into a fresh task directory; the dashboard files
//     ship with source bytes and no test/, wallet-build/ or scripts/ file ships.
//  2. Cold-install with production dependencies (scripts off, fresh empty npm
//     configs, TLS on); installed dashboard bytes equal the tarball.
//  3. Import the INSTALLED launcher and start it with dashboard: true. Every
//     import made from installed files resolves inside the install project.
//  4. Real Chromium (DACS_TEST_CHROME; a missing browser FAILS) walks the
//     dashboard with ordinary UI only (test/helpers/tester-dashboard-driver.mjs):
//     throwaway wallet, OAuth sign-in, discovery vs verification, purchase with
//     portal approval and receipt, GitHub add/remove, cancel, checklist, export.
//  5. stop() closes every advertised listener.
//  6. Installed CLI prints "Tester dashboard: <url>" and serves it; --no-dashboard
//     does not; the installed production binary answers 404 for /tester/.
//
//   node scripts/check-tester-dashboard-package.mjs [--keep] [--screenshot-dir DIR]
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTarEntries } from './check-embedded-wallet-package.mjs';
import { PACKAGE_ROOT, PACKAGE_NAME, sha256, inside, importFindings, toolingPreflight, probePort, formatResult } from './check-offline-tester-package.mjs';

export const DASHBOARD_FILES = [
  'bin/dacs-chatgpt-offline-test.mjs',
  'bin/offline-fixtures/operator.mjs',
  'bin/offline-fixtures/tester-dashboard.mjs',
  'bin/offline-fixtures/tester-ui/index.html',
  'bin/offline-fixtures/tester-ui/dashboard.css',
  'bin/offline-fixtures/tester-ui/dashboard.js',
  'docs/TESTER-DASHBOARD.md',
];
const OVERALL_MS = 540_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const args = { keep: false, screenshotDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--screenshot-dir') {
      if (i + 1 >= argv.length) throw new Error('--screenshot-dir needs a value');
      args.screenshotDir = resolve(argv[++i]);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

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
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: join(work, 'npm-cache'),
    npm_config_ignore_scripts: 'true', npm_config_strict_ssl: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_loglevel: 'error',
  };
}
function runNpm(args, { cwd, env, log }) {
  const { file, pre } = npmCommand();
  return new Promise((ok, fail) => {
    execFile(file, [...pre, ...args], { cwd, env, timeout: 300_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      log.push({ command: `npm ${args.join(' ')}`, exit: error ? (error.code ?? 'killed') : 0, stderrTail: String(stderr).slice(-300) });
      if (error) fail(new Error(`npm ${args[0]} failed: ${String(stderr || error.message).slice(0, 300)}`));
      else ok(stdout);
    });
  });
}

// Starts a child, waits for `ready(out)`, then SIGTERMs it. Bounded.
async function runChild(file, args, { cwd, env, ready, during }) {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { if (out.length < 65536) out += c; });
  child.stderr.on('data', (c) => { if (err.length < 65536) err += c; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  try {
    for (const end = Date.now() + 30_000; !ready(out, err) && Date.now() < end && child.exitCode === null;) await delay(100);
    const value = await during(out, err);
    child.kill('SIGTERM');
    const stop = await Promise.race([exited, delay(15_000).then(() => null)]);
    return { value, stop, out, err };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

export async function runCheck({ keep = false, screenshotDir = null, onResult } = {}) {
  const results = [];
  const add = (name, ok, detail) => {
    const r = { name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 600) } : {}) };
    results.push(r);
    onResult?.(r);
    return r.ok;
  };
  const deadline = Date.now() + OVERALL_MS;
  const summary = { label: 'installed tester dashboard (SIMULATED loopback fixtures)', node: process.versions.node, tarball: null, npm: [], installed: {} };
  const preflight = toolingPreflight();
  if (!add('source checker tooling preflight', preflight.length === 0, preflight.join('; ') || `Node ${process.versions.node}`)) return { status: 'fail', results, summary };
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-tdpkg-')));
  add('task directory is outside the source package', !inside(PACKAGE_ROOT, work), work);
  const installedImports = [];
  let projectRoot = null;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (projectRoot && context.parentURL?.startsWith('file:') && inside(projectRoot, fileURLToPath(context.parentURL))) installedImports.push({ url: resolved.url });
      return resolved;
    },
  });
  const cleanups = [];
  let handle = null;
  try {
    const env = npmEnv(work);
    const packDir = join(work, 'pack');
    mkdirSync(packDir);
    const packed = JSON.parse(await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: PACKAGE_ROOT, env, log: summary.npm }))[0];
    const tarballPath = join(packDir, packed.filename);
    const tgz = readFileSync(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    summary.tarball = { file: packed.filename, bytes: tgz.length, sha256: sha256(tgz), integrity };
    add('npm pack tarball matches npm-reported integrity', packed.integrity === integrity, `sha256 ${summary.tarball.sha256}`);
    const tarFiles = parseTarEntries(tgz);
    for (const rel of DASHBOARD_FILES) {
      const art = tarFiles.get(rel);
      add(`tarball ships ${rel} with source bytes`, art && sha256(art) === sha256(readFileSync(join(PACKAGE_ROOT, rel))), art ? `sha256 ${sha256(art)}` : 'absent');
    }
    const devOnly = [...tarFiles.keys()].filter((p) => /^(test|wallet-build|scripts)\//.test(p));
    add('tarball ships no test/, wallet-build/ or scripts/ files', devOnly.length === 0, devOnly.slice(0, 5).join(', '));

    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'dacs-tester-dashboard-install-check', version: '0.0.0', private: true }, null, 2)}\n`);
    await runNpm(['install', tarballPath, '--omit=optional', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: project, env, log: summary.npm });
    projectRoot = realpathSync(project);
    const installedRoot = join(projectRoot, 'node_modules', ...PACKAGE_NAME.split('/'));
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
    add('installed from this tarball (lockfile integrity)', lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity === integrity);
    for (const rel of DASHBOARD_FILES) {
      const path = join(installedRoot, rel);
      summary.installed[rel] = existsSync(path) ? sha256(readFileSync(path)) : null;
      add(`installed ${rel} equals the tarball`, summary.installed[rel] && summary.installed[rel] === sha256(tarFiles.get(rel) ?? Buffer.alloc(0)));
    }
    add('no playwright-core, test/ or wallet-build/ in the install', !existsSync(join(projectRoot, 'node_modules', 'playwright-core')) && !existsSync(join(installedRoot, 'test')) && !existsSync(join(installedRoot, 'wallet-build')));

    const binPath = join(installedRoot, 'bin', 'dacs-chatgpt-offline-test.mjs');
    const installed = await import(pathToFileURL(binPath).href);
    const operatorLogs = [];
    handle = await installed.startOfflineTester({ dashboard: true, logLevel: 'info', logSink: (line) => operatorLogs.push(line) });
    const advertised = [handle.origin, handle.fixtures.chain, handle.fixtures.directory, handle.fixtures.proofs];
    add('installed launcher serves the dashboard on its loopback plugin origin', handle.dashboardUrl === `${handle.origin}/tester/` && /^http:\/\/127\.0\.0\.1:\d+$/.test(handle.origin), handle.dashboardUrl);

    const chrome = process.env.DACS_TEST_CHROME;
    if (!add('real Chromium available (DACS_TEST_CHROME)', chrome && existsSync(chrome), chrome ?? 'DACS_TEST_CHROME is not set')) throw new Error('no browser');
    const { chromium } = await import('playwright-core');
    const { runDashboardFlow } = await import('../test/helpers/tester-dashboard-driver.mjs');
    // Fresh owned download directory (DACS_TEST_DOWNLOAD_PARENT or the task
    // directory), so the browser and the Playwright server share one explicit
    // downloadsPath. Removed after the browser closes.
    const downloadParent = process.env.DACS_TEST_DOWNLOAD_PARENT || work;
    mkdirSync(downloadParent, { recursive: true });
    const downloads = mkdtempSync(join(downloadParent, 'tdpkg-'));
    cleanups.push(async () => {
      summary.downloadDir = { entriesAfterClose: readdirSync(downloads).length };
      rmSync(downloads, { recursive: true, force: true });
      add('owned download directory removed after browser close', !existsSync(downloads), downloads);
    });
    const browserServer = await chromium.launchServer({ executablePath: chrome, headless: true, downloadsPath: downloads });
    cleanups.push(() => browserServer.close().catch(() => browserServer.kill()));
    const browser = await chromium.connect(browserServer.wsEndpoint());
    cleanups.push(() => browser.close());
    add('real Chromium launched', true, browser.version());
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
    // The installed dashboard renders the seller wizard and the evidence
    // download control (separate fresh context; presence only, the flow
    // below drives the buyer path).
    const first = await browser.newContext();
    cleanups.push(() => first.close());
    const firstPage = await first.newPage();
    await firstPage.goto(handle.dashboardUrl);
    const seller = firstPage.locator('section#seller');
    await seller.getByRole('heading', { name: /seller wizard/i }).waitFor({ timeout: 15000 }).catch(() => {});
    add('installed dashboard renders the seller wizard (title, fixed DEM price and description fields)',
      await seller.getByRole('heading', { name: /seller wizard/i }).isVisible()
      && await seller.locator('form#seller-form input#seller-title').count() === 1
      && await seller.locator('form#seller-form input#seller-price').count() === 1
      && await seller.locator('form#seller-form textarea#seller-description').count() === 1);
    add('installed dashboard renders the evidence download control',
      await firstPage.locator('section#evidence').getByRole('button', { name: 'Download evidence file' }).isVisible());
    await first.close();
    await runDashboardFlow({ browser, h: handle, check: add, operatorLogs, screenshotPath: screenshotDir ? join(screenshotDir, `tester-dashboard-installed-${Date.now()}.png`) : null });

    await handle.stop();
    handle = null;
    const open = [];
    for (const o of advertised) if ((await probePort(o)) !== 'refused') open.push(o);
    add('stop(): every advertised service refuses new TCP connections', open.length === 0, open.join(' '));

    const findings = installedImports.flatMap((i) => importFindings({ url: i.url, projectRoot, packageRoot: installedRoot, sourceRoot: PACKAGE_ROOT }));
    const loaded = installedImports.some((i) => i.url.endsWith('/bin/offline-fixtures/tester-dashboard.mjs'));
    add('every import made by installed code resolves inside the install project', loaded && findings.length === 0, findings.slice(0, 5).join('; ') || `${installedImports.length} resolutions`);

    // Installed CLI: banner line and served page; --no-dashboard; production binary.
    const childEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir() };
    const cli = await runChild(process.execPath, [binPath], {
      cwd: projectRoot, env: childEnv, ready: (out) => out.includes('Press Ctrl-C'),
      during: async (out) => {
        const url = out.split('\n').find((l) => l.startsWith('Tester dashboard:'))?.split(/\s+/)[2] ?? null;
        const res = url ? await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null) : null;
        return { url, status: res?.status ?? null, banner: res ? /SIMULATED ONLY/.test(await res.text()) : false };
      },
    });
    add('installed CLI prints "Tester dashboard: <url>" and serves the SIMULATED dashboard there', /^http:\/\/127\.0\.0\.1:\d+\/tester\/$/.test(cli.value.url ?? '') && cli.value.status === 200 && cli.value.banner, JSON.stringify(cli.value));
    add('installed CLI: SIGTERM exits 0; no cookie/secret/private/mnemonic wording', cli.stop?.code === 0 && !/cookie|secret|private|mnemonic/i.test(cli.out + cli.err), JSON.stringify(cli.stop));
    const off = await runChild(process.execPath, [binPath, '--json', '--no-dashboard'], {
      cwd: projectRoot, env: childEnv, ready: (out) => out.includes('\n'),
      during: async (out) => {
        const s = JSON.parse(out.split('\n')[0]);
        return { dashboard: s.dashboard ?? null, status: (await fetch(`${s.plugin}/tester/`, { signal: AbortSignal.timeout(5000) })).status };
      },
    });
    add('installed CLI --no-dashboard: no dashboard advertised and /tester/ is 404', off.value.dashboard === null && off.value.status === 404 && off.stop?.code === 0, JSON.stringify(off.value));
    const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const origin = `http://127.0.0.1:${port}`;
    const prod = await runChild(process.execPath, ['--disable-warning=ExperimentalWarning', join(installedRoot, 'bin', 'dacs-chatgpt-plugin.mjs')], {
      cwd: work,
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: join(work, 'prod-data'), DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_LOG_LEVEL: 'warn' },
      ready: () => false,
      during: async () => {
        let health = null;
        for (let i = 0; i < 50 && !health; i += 1) {
          await delay(200);
          health = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
        }
        return { health: health?.status ?? null, tester: (await fetch(`${origin}/tester/`).catch(() => null))?.status ?? null };
      },
    });
    add('installed production binary does not serve the dashboard (/tester/ 404)', prod.value.health === 'ok' && prod.value.tester === 404, JSON.stringify(prod.value));
  } catch (error) {
    if (error?.message !== 'no browser') add('tester dashboard package check', false, String(error?.stack ?? error).slice(0, 600));
  } finally {
    if (handle) await handle.stop().catch((e) => add('operator stop during cleanup', false, e.message));
    while (cleanups.length) await cleanups.pop()().catch(() => {});
    if (keep) add('task directory kept (--keep)', existsSync(work), work);
    else {
      rmSync(work, { recursive: true, force: true });
      add('task directory removed', !existsSync(work));
    }
  }
  add(`run finished within the ${OVERALL_MS}ms overall deadline`, Date.now() <= deadline);
  return { status: results.every((r) => r.ok) ? 'pass' : 'fail', results, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-tester-dashboard-package: ${error.message}\n`);
    process.exit(2);
  }
  const backstop = setTimeout(() => {
    process.stdout.write('FAIL overall backstop: no result within the deadline\n');
    process.exit(1);
  }, OVERALL_MS + 60_000);
  backstop.unref();
  const { status, results, summary } = await runCheck({ ...args, onResult: (r) => process.stdout.write(formatResult(r)) });
  clearTimeout(backstop);
  process.stdout.write(`${JSON.stringify({ status, passed: results.filter((r) => r.ok).length, total: results.length, ...summary }, null, 2)}\n`);
  process.stdout.write(`${results.filter((r) => r.ok).length}/${results.length} tester dashboard package checks passed\n`);
  process.exitCode = status === 'pass' ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 5_000).unref();
}
