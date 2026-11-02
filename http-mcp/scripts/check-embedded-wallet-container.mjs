#!/usr/bin/env node
// Loopback-only HTTP checks against an operator-started container of the DACS
// plugin image. This script never calls Docker: the operator (or the supplied
// test helper) builds, runs, restarts and removes the container.
//
//   node scripts/check-embedded-wallet-container.mjs --origin http://127.0.0.1:<port>
//        --package-root <checkout>/chatgpt [--restart-cycle] [--startup-timeout-ms N]
//        [--overall-timeout-ms N]
//
// Checks: bounded startup wait for /health, health reports every live
// dependency unconfigured, MCP initialize + tools/list over Streamable HTTP,
// and each embedded-wallet asset over HTTP (status, MIME, nosniff, bytes equal
// to the --package-root source the image was built from), including every file
// of the generated SDK module graph that runtime-manifest.json declares (lazily
// loaded chunks too), whose downloaded closure is then checked. --restart-cycle labels
// the run as the post-restart phase; cold start and restart are reported as
// separate phases, never merged. Anonymous requests only: no accounts, tokens,
// wallet actions or live endpoints. Asset checks are packaging evidence only,
// not proof that the wallet works.
//
// Every request has its own timeout and the whole run an overall deadline
// (default 240 s, at least startup + 30 s). Result lines are printed as they
// are known; the final JSON is printed on completion or deadline.
//
// Exit 0 all checks pass, 1 any check fails or the deadline passes, 2 usage error.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_OVERALL_MS, boundedSignal, checkRunningServer, checkRuntimeGraphFiles, formatResult, readSourceFiles, sha256, startBackstop, walletAssetsFor } from './check-embedded-wallet-package.mjs';

const DEFAULT_STARTUP_MS = 60_000;
const MAX_STARTUP_MS = 180_000;
const DEFAULT_CONTAINER_OVERALL_MS = 240_000;

export class UsageError extends Error {}

// Only an explicit http://127.0.0.1:<port> origin is accepted: the container
// must be published on host loopback and nothing else is contacted.
export function parseContainerArgs(argv) {
  const args = { origin: null, packageRoot: null, restartCycle: false, startupTimeoutMs: DEFAULT_STARTUP_MS, overallTimeoutMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--origin') args.origin = argv[++i];
    else if (arg === '--package-root') args.packageRoot = argv[++i];
    else if (arg === '--restart-cycle') args.restartCycle = true;
    else if (arg === '--startup-timeout-ms') args.startupTimeoutMs = Number(argv[++i]);
    else if (arg === '--overall-timeout-ms') args.overallTimeoutMs = Number(argv[++i]);
    else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!args.origin) throw new UsageError('--origin http://127.0.0.1:<port> is required');
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(args.origin);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new UsageError('--origin must be exactly http://127.0.0.1:<port>');
  if (!args.packageRoot) throw new UsageError('--package-root is required');
  args.packageRoot = resolve(args.packageRoot);
  if (!Number.isInteger(args.startupTimeoutMs) || args.startupTimeoutMs < 1000 || args.startupTimeoutMs > MAX_STARTUP_MS) {
    throw new UsageError(`--startup-timeout-ms must be an integer in [1000, ${MAX_STARTUP_MS}]`);
  }
  args.overallTimeoutMs ??= Math.max(DEFAULT_CONTAINER_OVERALL_MS, args.startupTimeoutMs + 60_000);
  if (!Number.isInteger(args.overallTimeoutMs) || args.overallTimeoutMs < args.startupTimeoutMs + 30_000 || args.overallTimeoutMs > MAX_OVERALL_MS) {
    throw new UsageError(`--overall-timeout-ms must be an integer in [startup + 30000, ${MAX_OVERALL_MS}]`);
  }
  return args;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForHealth(origin, timeoutMs, { fetchImpl = fetch, intervalMs = 500, signal } = {}) {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < timeoutMs && !signal?.aborted) {
    try {
      const res = await fetchImpl(`${origin}/health`, { signal: boundedSignal(3000, signal) });
      if (res.ok) return { ok: true, waitedMs: Date.now() - started };
      last = `status ${res.status}`;
    } catch (error) {
      last = String(error?.cause?.code ?? error?.message ?? error);
    }
    await delay(intervalMs);
  }
  return { ok: false, waitedMs: Date.now() - started, detail: last };
}

export async function runContainerCheck({ origin, packageRoot, restartCycle = false, startupTimeoutMs = DEFAULT_STARTUP_MS, overallTimeoutMs = DEFAULT_CONTAINER_OVERALL_MS, onResult }) {
  const phase = restartCycle ? 'restart' : 'cold-start';
  const results = [];
  const add = (name, ok, detail) => {
    const r = { name: `[${phase}] ${name}`, ok: Boolean(ok), ...(detail ? { detail } : {}) };
    results.push(r);
    onResult?.(r);
  };
  const overall = AbortSignal.timeout(overallTimeoutMs);

  const sourceFiles = existsSync(join(packageRoot, 'package.json')) ? readSourceFiles(packageRoot) : new Map();
  const runtimeProblems = checkRuntimeGraphFiles(sourceFiles);
  const missing = walletAssetsFor(sourceFiles).filter((p) => !sourceFiles.has(p));
  add('package-root source has every wallet asset and a complete, closed runtime module graph', missing.length === 0 && runtimeProblems.length === 0,
    [...missing.map((p) => `missing ${p}`), ...runtimeProblems].slice(0, 10).join('; '));

  const health = await waitForHealth(origin, startupTimeoutMs, { signal: overall });
  add(`container answers /health within ${startupTimeoutMs}ms`, health.ok, health.ok ? `${health.waitedMs}ms` : health.detail);
  if (health.ok) await checkRunningServer({ origin, expectedFiles: sourceFiles, add, label: 'container', signal: overall });
  add(`run finished within the ${overallTimeoutMs}ms overall deadline`, !overall.aborted);

  return {
    phase,
    status: results.every((r) => r.ok) ? 'pass' : 'fail',
    startupWaitMs: health.waitedMs,
    results,
    expectedAssets: walletAssetsFor(sourceFiles).filter((p) => sourceFiles.has(p)).map((p) => ({ path: p, bytes: sourceFiles.get(p).length, sha256: sha256(sourceFiles.get(p)) })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseContainerArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-embedded-wallet-container: ${error.message}\n`);
    process.exit(2);
  }
  const seen = [];
  const phase = args.restartCycle ? 'restart' : 'cold-start';
  const backstop = startBackstop(args.overallTimeoutMs + 30_000, () => ({ phase, passed: seen.filter((r) => r.ok).length, total: seen.length, origin: args.origin, overallTimeoutMs: args.overallTimeoutMs }));
  const report = await runContainerCheck({
    ...args,
    onResult: (r) => {
      seen.push(r);
      process.stdout.write(formatResult(r));
    },
  });
  clearTimeout(backstop);
  const passed = report.results.filter((r) => r.ok).length;
  process.stdout.write(`${JSON.stringify({ phase: report.phase, status: report.status, passed, total: report.results.length, startupWaitMs: report.startupWaitMs, origin: args.origin, overallTimeoutMs: args.overallTimeoutMs, expectedAssets: report.expectedAssets }, null, 2)}\n`);
  process.stdout.write(`${report.phase}: ${passed}/${report.results.length} embedded-wallet container checks passed\n`);
  process.exitCode = report.status === 'pass' ? 0 : 1;
  // Keep-alive sockets to the still-running container must not hold the process open.
  setTimeout(() => process.exit(process.exitCode), 5_000).unref();
}
