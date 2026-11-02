#!/usr/bin/env node
// Offline human-tester launcher. Starts SIMULATED loopback fixtures (Demos
// RPC, directory, public proofs) and the normal plugin server with fresh
// synthetic state, prints only public local origins, and stops cleanly on
// Ctrl-C / SIGTERM. Not Demos testnet, not funded, not security reviewed.
//
//   node <installed-package>/bin/dacs-chatgpt-offline-test.mjs [--port N] [--redirect-origin URL]... [--keep-state] [--no-dashboard] [--json] [--verbose]
//
// By default it also serves the guided tester dashboard on the plugin origin
// (/tester/, see docs/TESTER-DASHBOARD.md). The production binary never does.
//
// Programmatic use: import { startOfflineTester } from this file (or
// ./offline-fixtures/operator.mjs) and call stop() on the returned handle.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startOfflineTester, DEFAULT_REDIRECT_ORIGIN, NOTICE } from './offline-fixtures/operator.mjs';

export { startOfflineTester, NOTICE };

const USAGE = `Usage: dacs-chatgpt-offline-test [options]

${NOTICE}

Options:
  --port <n>              plugin port on 127.0.0.1 (default: a free port)
  --redirect-origin <url> loopback OAuth client origin allowed to link accounts
                          (repeatable; default ${DEFAULT_REDIRECT_ORIGIN}, MCP Inspector)
  --keep-state            keep the temporary state directory after stop (for inspection only;
                          it is never reused: every run starts fresh)
  --no-dashboard          do not serve the guided tester dashboard (/tester/)
  --json                 print the public start information as one JSON line
  --verbose               plugin access logs (method/path/status only) on stderr
  -h, --help              show this help
`;

export function parseArgs(argv) {
  const options = { redirectOrigins: [], keepState: false, json: false, verbose: false, help: false, port: 0, dashboard: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--keep-state') options.keepState = true;
    else if (arg === '--no-dashboard') options.dashboard = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port must be an integer in [0, 65535]');
      options.port = n;
    } else if (arg === '--redirect-origin') options.redirectOrigins.push(value());
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.redirectOrigins.length === 0) options.redirectOrigins.push(DEFAULT_REDIRECT_ORIGIN);
  return options;
}

export function publicSummary(handle) {
  return {
    notice: handle.notice,
    status: 'running',
    plugin: handle.origin,
    mcp: handle.mcpUrl,
    embeddedWallet: handle.embeddedWalletUrl,
    ...(handle.dashboardUrl ? { dashboard: handle.dashboardUrl } : {}),
    health: `${handle.origin}/health`,
    fixtures: handle.fixtures,
    proofPublisher: `${handle.fixtures.proofs}/`,
    listing: handle.listing,
    redirectOrigins: handle.redirectOrigins,
    coreProfile: handle.coreProfile,
    state: handle.keepState ? { kept: true, dir: handle.stateDir } : { kept: false },
    stop: 'Press Ctrl-C (SIGINT) or send SIGTERM to this process.',
  };
}

function banner(s) {
  return [
    '',
    '==================================================================',
    ' DACS ChatGPT plugin: OFFLINE TESTER (SIMULATED FIXTURES ONLY)',
    ' NOT Demos testnet. NOT funded. NOT ChatGPT. NOT security reviewed.',
    ' Fixture acceptance of a payment or identity change is NOT settlement.',
    '==================================================================',
    ...(s.dashboard ? [`Tester dashboard:    ${s.dashboard}   (START HERE: guided steps in your browser)`] : []),
    `Plugin (MCP):        ${s.mcp}`,
    `Embedded wallet:     ${s.embeddedWallet}   (EXPERIMENTAL; keys stay in your browser)`,
    'Portal pages:        opened from the approval links the MCP tools return',
    `Health:              ${s.health}`,
    `Fixture chain RPC:   ${s.fixtures.chain}   (SIMULATED)`,
    `Fixture directory:   ${s.fixtures.directory}   (SIMULATED)`,
    `Proof publisher:     ${s.proofPublisher}   (SIMULATED GitHub/X stand-in)`,
    `OAuth client origin: ${s.redirectOrigins.join(', ')}`,
    `Fixture listing:     ${s.listing.label}`,
    `  listingId ${s.listing.listingId} v${s.listing.version}, ${s.listing.price.amount} ${s.listing.price.currency} (fixture DEM)`,
    `  seller ${s.listing.seller}`,
    `State:               ${s.state.kept ? `kept after stop at ${s.state.dir}` : 'fresh temporary state, removed on stop'}`,
    '',
    s.stop,
    '',
  ].join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  let handle;
  try {
    handle = await startOfflineTester({
      port: options.port,
      redirectOrigins: options.redirectOrigins,
      keepState: options.keepState,
      dashboard: options.dashboard,
      logLevel: options.verbose ? 'info' : 'warn',
    });
  } catch (error) {
    process.stderr.write(`offline tester failed to start: ${error.message}\n`);
    process.exit(1);
  }
  const summary = publicSummary(handle);
  process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : banner(summary));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`offline tester: ${signal} received, stopping owned services\n`);
    const force = setTimeout(() => {
      process.stderr.write('offline tester: stop timed out\n');
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      await handle.stop();
      process.stderr.write('offline tester: stopped\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(`offline tester: stop failed: ${error.message}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
