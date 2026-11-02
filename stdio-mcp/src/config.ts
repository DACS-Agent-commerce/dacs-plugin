/**
 * Configuration — environment only (the Claude Code plugin maps its userConfig
 * options onto these variables). Defaults are the safe ones: testnet, writes
 * off, a small daily cap.
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { demToOs } from './amount.js';

export type ConfirmChannelName = 'tty' | 'desktop' | 'stderr' | 'webhook';

export interface Config {
  /** DEMOS_WALLET_MODE=purchase-only: the legacy tools may not open the wallet or sign. */
  purchaseOnly?: boolean;
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  /** True when the RPC host is on the built-in testnet list. */
  rpcIsKnownTestnet: boolean;
  allowMainnet: boolean;
  writesEnabled: boolean;
  /** Explicit DEMOS_KEYSTORE, or the onboarding default <stateDir>/wallet.keystore.json. */
  keystorePath?: string;
  /** True when keystorePath is the onboarding default (may not exist yet). */
  keystoreIsDefault: boolean;
  keystorePassphrase?: string;
  keystorePassphraseFile?: string;
  mnemonicFile?: string;
  dailyCapOs: bigint;
  recipientAllowlist: string[] | null;
  confirmChannels: ConfirmChannelName[];
  confirmWebhookUrl?: string;
  confirmTtlMs: number;
  stateDir: string;
  faucetApiUrl: string;
  faucetPageUrl: string;
  faucetAmountDem: number;
  /** Serve a local approval page (approval off the chat channel). */
  approvalPage: boolean;
  approvalBind: string;
  approvalPort: number;
  /** Public base URL for the approval page (e.g. a tailnet https URL), if not the bind address. */
  approvalPublicUrl?: string;
  /** Also accept the typed out-of-band code (fallback). */
  codeFallback: boolean;
}

/** Reserved placeholder: there is no built-in RPC. Read-only use takes DEMOS_RPC_URL. */
export const DEFAULT_TESTNET_RPC = 'https://testnet-rpc.invalid';
/** Testnet RPC hosts that may take writes. Empty in this release: testnet writes are refused. */
export const KNOWN_TESTNET_HOSTS = new Set<string>();

function env(e: NodeJS.ProcessEnv, k: string): string | undefined {
  const v = e[k];
  if (v === undefined) return undefined;
  const t = v.trim();
  // an unset Claude Code plugin option can arrive as an empty string or an unsubstituted reference
  if (t === '' || t.startsWith('${')) return undefined;
  return t;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const ADDRESS_RE = /^0x[0-9a-f]{64}$/;

export function normalizeAddress(a: string): string {
  const s = a.trim().toLowerCase();
  const withPrefix = s.startsWith('0x') ? s : `0x${s}`;
  if (!ADDRESS_RE.test(withPrefix)) throw new Error(`invalid Demos address "${a}": expected 0x + 64 hex chars`);
  return withPrefix;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const networkRaw = (env(e, 'DEMOS_NETWORK') ?? 'testnet').toLowerCase();
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    throw new Error(`DEMOS_NETWORK must be "testnet" or "mainnet" (got "${networkRaw}")`);
  }
  const network = networkRaw as 'testnet' | 'mainnet';
  const allowMainnet = truthy(env(e, 'DEMOS_ALLOW_MAINNET'));
  if (network === 'mainnet' && !allowMainnet) {
    throw new Error('DEMOS_NETWORK=mainnet requires DEMOS_ALLOW_MAINNET=1 (explicit opt-in for real value)');
  }
  const rpcUrl = env(e, 'DEMOS_RPC_URL') ?? (network === 'testnet' ? DEFAULT_TESTNET_RPC : undefined);
  if (!rpcUrl) throw new Error('DEMOS_NETWORK=mainnet requires an explicit DEMOS_RPC_URL');
  let host: string;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(u.hostname))) {
      throw new Error('RPC must be https (http allowed only for localhost)');
    }
    host = u.hostname;
  } catch (err) {
    throw new Error(`DEMOS_RPC_URL is not a valid URL: ${(err as Error).message}`);
  }
  const rpcIsKnownTestnet = KNOWN_TESTNET_HOSTS.has(host);

  const capDem = env(e, 'DEMOS_DAILY_CAP_DEM') ?? '10';
  const dailyCapOs = demToOs(capDem);

  const allowRaw = env(e, 'DEMOS_RECIPIENT_ALLOWLIST');
  const recipientAllowlist = allowRaw
    ? allowRaw.split(/[\s,]+/).filter(Boolean).map(normalizeAddress)
    : null;

  const channelsRaw = env(e, 'DEMOS_CONFIRM_CHANNELS') ?? 'tty,desktop';
  const confirmChannels = channelsRaw.split(/[\s,]+/).filter(Boolean).map((c) => {
    if (!['tty', 'desktop', 'stderr', 'webhook'].includes(c)) {
      throw new Error(`unknown confirmation channel "${c}" (use tty, desktop, stderr, webhook)`);
    }
    return c as ConfirmChannelName;
  });
  const confirmWebhookUrl = env(e, 'DEMOS_CONFIRM_WEBHOOK_URL');
  if (confirmChannels.includes('webhook')) {
    if (!confirmWebhookUrl || !confirmWebhookUrl.startsWith('https://')) {
      throw new Error('confirmation channel "webhook" requires an https DEMOS_CONFIRM_WEBHOOK_URL');
    }
  }
  const ttlSec = Number(env(e, 'DEMOS_CONFIRM_TTL_SEC') ?? '300');
  if (!Number.isFinite(ttlSec) || ttlSec < 30 || ttlSec > 3600) {
    throw new Error('DEMOS_CONFIRM_TTL_SEC must be between 30 and 3600');
  }

  // Not CLAUDE_PLUGIN_DATA: that directory is deleted on plugin uninstall, which would reset the
  // daily cap and lose the receipts log.
  const stateDir = env(e, 'DEMOS_STATE_DIR') ?? join(homedir(), '.demos-mcp');
  const faucetAmount = Number(env(e, 'DEMOS_FAUCET_AMOUNT_DEM') ?? '100');
  if (!Number.isInteger(faucetAmount) || faucetAmount < 1 || faucetAmount > 10_000) throw new Error('DEMOS_FAUCET_AMOUNT_DEM must be an integer 1-10000');
  const approvalBind = env(e, 'DEMOS_APPROVAL_BIND') ?? '127.0.0.1';
  const approvalPort = Number(env(e, 'DEMOS_APPROVAL_PORT') ?? '0');
  if (!Number.isInteger(approvalPort) || approvalPort < 0 || approvalPort > 65535) throw new Error('DEMOS_APPROVAL_PORT must be 0-65535');
  const approvalPublicUrl = env(e, 'DEMOS_APPROVAL_PUBLIC_URL');
  if (approvalPublicUrl && !/^https?:\/\//.test(approvalPublicUrl)) throw new Error('DEMOS_APPROVAL_PUBLIC_URL must be an http(s) URL');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(approvalBind);
  if (!loopback && !(approvalPublicUrl && approvalPublicUrl.startsWith('https://'))) {
    throw new Error('a non-loopback DEMOS_APPROVAL_BIND needs an https DEMOS_APPROVAL_PUBLIC_URL (approval links carry a bearer token)');
  }
  const approvalPage = env(e, 'DEMOS_APPROVAL_PAGE') === undefined ? true : truthy(env(e, 'DEMOS_APPROVAL_PAGE'));
  const codeFallback = env(e, 'DEMOS_CODE_FALLBACK') === undefined ? true : truthy(env(e, 'DEMOS_CODE_FALLBACK'));
  if (!approvalPage && !codeFallback) throw new Error('at least one of DEMOS_APPROVAL_PAGE / DEMOS_CODE_FALLBACK must be on');

  const walletMode = env(e, 'DEMOS_WALLET_MODE');
  // never echo the value: it is operator input of any length
  if (walletMode !== undefined && walletMode !== 'purchase-only') throw new Error('DEMOS_WALLET_MODE must be unset or purchase-only');

  return {
    purchaseOnly: walletMode === 'purchase-only',
    network,
    rpcUrl,
    rpcIsKnownTestnet,
    allowMainnet,
    writesEnabled: truthy(env(e, 'DEMOS_MCP_ENABLE_WRITES')),
    keystorePath: env(e, 'DEMOS_KEYSTORE') ?? (env(e, 'DEMOS_MNEMONIC_FILE') ? undefined : join(stateDir, 'wallet.keystore.json')),
    keystoreIsDefault: !env(e, 'DEMOS_KEYSTORE') && !env(e, 'DEMOS_MNEMONIC_FILE'),
    keystorePassphrase: env(e, 'DEMOS_KEYSTORE_PASSPHRASE'),
    keystorePassphraseFile: env(e, 'DEMOS_KEYSTORE_PASSPHRASE_FILE') ?? (env(e, 'DEMOS_KEYSTORE') ? undefined : join(stateDir, 'wallet.passphrase')),
    mnemonicFile: env(e, 'DEMOS_MNEMONIC_FILE'),
    dailyCapOs,
    recipientAllowlist,
    confirmChannels,
    confirmWebhookUrl,
    confirmTtlMs: ttlSec * 1000,
    stateDir,
    faucetApiUrl: env(e, 'DEMOS_FAUCET_API_URL') ?? 'https://faucet-api.invalid/api/request',
    faucetPageUrl: env(e, 'DEMOS_FAUCET_PAGE_URL') ?? 'https://faucet.invalid',
    faucetAmountDem: faucetAmount,
    approvalPage,
    approvalBind,
    approvalPort,
    approvalPublicUrl,
    codeFallback,
  };
}

/**
 * A `.purchase-only` marker beside the keystore fences it: beside the configured
 * path and, when that path is a symlink, beside its target too.
 */
function purchaseOnlyMarkerPaths(keystorePath: string): string[] {
  const paths = [`${keystorePath}.purchase-only`];
  try {
    const real = realpathSync(keystorePath);
    if (real !== keystorePath) paths.push(`${real}.purchase-only`);
  } catch {
    // missing or dangling keystore: the marker beside the configured path still counts
  }
  return paths;
}

/**
 * Why writes may NOT run with this config, or null if they may.
 * Writes need: the explicit enable flag, a key source, and either a known
 * testnet RPC or, on mainnet only, the explicit mainnet opt-in (an unlisted
 * RPC could be mainnet).
 */
export function writeBlocker(c: Config): string | null {
  if (c.purchaseOnly) return 'purchase-only wallet: legacy signing is disabled';
  if (c.keystorePath && purchaseOnlyMarkerPaths(c.keystorePath).some((p) => existsSync(p))) return 'purchase-only wallet: legacy signing is disabled';
  if (!c.writesEnabled) return 'writes are disabled (set DEMOS_MCP_ENABLE_WRITES=1)';
  // The mainnet opt-in never opens testnet writes on an unlisted RPC.
  if (!c.rpcIsKnownTestnet && (c.network === 'testnet' || !c.allowMainnet)) {
    return `RPC ${new URL(c.rpcUrl).hostname} is not a known testnet host; testnet writes are refused in this release`;
  }
  if (c.confirmChannels.length === 0) return 'no confirmation channel configured';
  return null;
}
