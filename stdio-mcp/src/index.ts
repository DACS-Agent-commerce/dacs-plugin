#!/usr/bin/env node
/**
 * demos-mcp entry point.
 *   demos-mcp                       run the MCP server on stdio
 *   demos-mcp keystore create --out <file> [--generate]
 *                                   encrypt a mnemonic (read from stdin) or a fresh one
 *   demos-mcp --version | --help
 */
import { readFileSync, statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listenKeyless } from './http_transport.js';
import { loadConfig, writeBlocker } from './config.js';
import { SecretGuard } from './secrets.js';
import { installConsoleGuard, log } from './log.js';
import { DemosChain } from './chain.js';
import { ConfirmationGate, buildChannels } from './confirm.js';
import { SpendLedger } from './spend.js';
import { encryptMnemonic, writeKeystore } from './keystore.js';
import { createServer, VERSION } from './server.js';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { ApprovalServer } from './approval.js';
import { createLegacyWalletOpener } from './wallet-policy.js';
import { dailyAnchor } from './receipts.js';

const HELP = `demos-mcp ${VERSION} — MCP server for the Demos Network

Usage:
  demos-mcp                                   run the MCP server (stdio, full local mode)
  demos-mcp --transport stdio|http            stdio is full; http is keyless on 127.0.0.1
  demos-mcp keystore create --out FILE        encrypt a mnemonic read from stdin
  demos-mcp keystore create --out FILE --generate   create a new wallet keystore
  demos-mcp receipts root [--date YYYY-MM-DD] daily Merkle root of receipts (anchor payload)
  demos-mcp --version

Keystore passphrase: DEMOS_KEYSTORE_PASSPHRASE or --passphrase-file FILE (chmod 600).
Server configuration: see README.md (DEMOS_* environment variables).`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function keystoreCreate(args: string[]): Promise<void> {
  const out = args[args.indexOf('--out') + 1];
  if (!args.includes('--out') || !out) throw new Error('--out FILE is required');
  const pfIdx = args.indexOf('--passphrase-file');
  if (pfIdx >= 0) {
    const st = statSync(args[pfIdx + 1]!);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error('passphrase file must be chmod 600');
  }
  const pass = pfIdx >= 0 ? readFileSync(args[pfIdx + 1]!, 'utf8').trim() : process.env.DEMOS_KEYSTORE_PASSPHRASE;
  if (!pass) throw new Error('set DEMOS_KEYSTORE_PASSPHRASE or pass --passphrase-file');
  const guard = processGuard;
  installConsoleGuard(guard, { quiet: true });
  const { Demos } = await import('@kynesyslabs/demosdk/websdk');
  const d = new Demos();
  const mnemonic = args.includes('--generate') ? d.newMnemonic(128) : (await readStdin()).trim().split(/\s+/).join(' ');
  guard.register(mnemonic);
  guard.register(pass);
  await d.connectWallet(mnemonic);
  const address = d.getAddress().toLowerCase();
  writeKeystore(out, encryptMnemonic(mnemonic, pass, { address }));
  process.stdout.write(`keystore written to ${out} (mode 600)\naddress: ${address}\n`);
  if (args.includes('--generate')) {
    // Show the new mnemonic ONCE, on the controlling terminal only (never stdout/stderr, which may be
    // captured or logged), so the human can write down an offline backup.
    let shown = false;
    try {
      const { openSync, writeSync, closeSync } = await import('node:fs');
      const fd = openSync('/dev/tty', 'w');
      writeSync(fd, `\r\nBACKUP — write these words down offline; they will not be shown again:\r\n\r\n  ${mnemonic}\r\n\r\n`);
      closeSync(fd);
      shown = true;
    } catch {
      shown = false;
    }
    process.stdout.write(
      shown
        ? 'The recovery phrase was shown on your terminal only. Keep it offline.\n'
        : 'No terminal available: the recovery phrase was NOT shown. The keystore + passphrase is the only copy (testnet use only).\n',
    );
  }
}

// one guard for the process, so fatal errors are redacted too
const processGuard = new SecretGuard();

const KEY_ENV = ['DEMOS_KEYSTORE', 'DEMOS_KEYSTORE_PASSPHRASE', 'DEMOS_KEYSTORE_PASSPHRASE_FILE', 'DEMOS_MNEMONIC_FILE'] as const;

async function serveHttp(): Promise<void> {
  const config = loadConfig();
  for (const key of KEY_ENV) delete process.env[key];
  config.keystorePath = undefined;
  config.keystorePassphrase = undefined;
  config.keystorePassphraseFile = undefined;
  config.mnemonicFile = undefined;
  const keylessConfig = {
    ...config,
    writesEnabled: false,
    keystorePath: undefined,
    keystorePassphrase: undefined,
    keystorePassphraseFile: undefined,
    mnemonicFile: undefined,
    approvalPage: false,
  };
  const guard = processGuard;
  installConsoleGuard(guard);
  const chain = new DemosChain(keylessConfig.rpcUrl, guard);
  const gate = new ConfirmationGate([], keylessConfig.confirmTtlMs, guard, Date.now, null, false);
  const ledger = new SpendLedger(keylessConfig.stateDir, keylessConfig.dailyCapOs);
  const rawPort = process.env.DEMOS_MCP_HTTP_PORT;
  const port = rawPort === undefined || rawPort.trim() === '' ? 7391 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DEMOS_MCP_HTTP_PORT must be a port number');
  const listening = await listenKeyless(
    {
      config: keylessConfig,
      guard,
      chain,
      gate,
      ledger,
      surface: 'keyless',
      openWallet: async () => {
        throw new Error('this transport does not hold keys');
      },
    },
    port,
  );
  log(`keyless http ${listening.url} holds_keys=false submit=off auth_file=${listening.authPath}`);
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const guard = processGuard;
  installConsoleGuard(guard);
  const chain = new DemosChain(config.rpcUrl, guard);
  const approval = config.approvalPage ? new ApprovalServer(config.approvalBind, config.approvalPort, config.approvalPublicUrl) : null;
  const gate = new ConfirmationGate(buildChannels(config.confirmChannels, config.confirmWebhookUrl), config.confirmTtlMs, guard, Date.now, approval, config.codeFallback);
  const ledger = new SpendLedger(config.stateDir, config.dailyCapOs);
  const server = createServer({
    config,
    guard,
    chain,
    gate,
    ledger,
    openWallet: createLegacyWalletOpener(config, guard, chain),
    walletFactory: {
      // generated locally by the Demos SDK; never leaves this process except on the local page
      newMnemonic: () => new Demos().newMnemonic(128),
      addressOf: async (m: string) => {
        const d = new Demos();
        await d.connectWallet(m);
        return d.getAddress();
      },
    },
  });
  const blocker = writeBlocker(config);
  log(`v${VERSION} network=${config.network} rpc=${config.rpcUrl} writes=${blocker ? 'off (' + blocker + ')' : 'ON, confirm via ' + config.confirmChannels.join('+')}`);
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (args[0] === 'keystore' && args[1] === 'create') return keystoreCreate(args.slice(2));
  if (args[0] === 'receipts' && args[1] === 'root') {
    // Daily anchor payload: Merkle root over the day's receipt digests. Anchor it to SR-2
    // (e.g. a storage program write) to make the receipts log tamper-evident.
    const i = args.indexOf('--date');
    const day = i >= 0 ? args[i + 1]! : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--date YYYY-MM-DD');
    const a = dailyAnchor(loadConfig().stateDir, day);
    process.stdout.write(JSON.stringify({ kind: 'demos-mcp/receipts-root@1', day: a.day, count: a.count, merkle_root: a.root }, null, 2) + '\n');
    return;
  }
  const transportAt = args.indexOf('--transport');
  if (transportAt >= 0) {
    const mode = args[transportAt + 1];
    const rest = args.filter((_, i) => i !== transportAt && i !== transportAt + 1);
    if (rest.length > 0) throw new Error(`unknown arguments: ${rest.join(' ')} (see --help)`);
    if (mode === 'stdio') return serve();
    if (mode === 'http') return serveHttp();
    throw new Error('--transport must be stdio or http');
  }
  if (args.length > 0) throw new Error(`unknown arguments: ${args.join(' ')} (see --help)`);
  return serve();
}

for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e: unknown) => {
    process.stderr.write(`demos-mcp: fatal ${ev}: ${processGuard.redact(e instanceof Error ? e.message : String(e))}\n`);
    process.exit(1);
  });
}

main().catch((e) => {
  process.stderr.write(`demos-mcp: ${processGuard.redact(e instanceof Error ? e.message : String(e))}\n`);
  process.exit(1);
});
