/**
 * Test harness: a mocked chain + wallet (real ed25519 keys, no network), a
 * capturing confirmation channel (stands in for the human's out-of-band
 * channel), and an in-memory MCP client wired to createServer().
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../src/config.js';
import { SecretGuard } from '../src/secrets.js';
import { ConfirmationGate, type ConfirmChannel, type ConfirmMessage } from '../src/confirm.js';
import { SpendLedger } from '../src/spend.js';
import { createServer } from '../src/server.js';
import { ApprovalServer } from '../src/approval.js';
import type { ProofFetcher, WalletFactory } from '../src/onboard.js';
import type { AddressInfo, AttestKind, BroadcastResult, ChainReader, NetworkInfo, PreparedTx, StorageRecord, TxInfo, Wallet } from '../src/chain.js';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const PASSPHRASE = 'correct horse battery staple 42';

export function keypair(seedByte: number) {
  const priv = new Uint8Array(32).fill(seedByte);
  const pub = ed.getPublicKey(priv);
  return { priv, pub, address: '0x' + Buffer.from(pub).toString('hex') };
}

export class CaptureChannel implements ConfirmChannel {
  readonly name = 'capture';
  messages: ConfirmMessage[] = [];
  enabled = true;
  async deliver(m: ConfirmMessage): Promise<boolean> {
    if (!this.enabled) return false;
    this.messages.push(m);
    return true;
  }
  last(): ConfirmMessage {
    const m = this.messages[this.messages.length - 1];
    if (!m) throw new Error('no confirmation message captured');
    return m;
  }
}

export class MockChain implements ChainReader {
  readonly rpcUrl = 'https://testnet-rpc.invalid';
  balances = new Map<string, bigint>();
  txs = new Map<string, TxInfo>();
  storage = new Map<string, StorageRecord>();
  idents = new Map<string, unknown>();
  calls: string[] = [];
  async networkInfo(): Promise<NetworkInfo> {
    this.calls.push('networkInfo');
    return { rpcUrl: this.rpcUrl, lastBlock: 1000, nodeVersion: 'mock@0', osDenominationActive: true, params: { networkFee: 1, rpcFee: 1, additionalFee: 0 } };
  }
  async addressInfo(address: string): Promise<AddressInfo> {
    const b = this.balances.get(address);
    return { address, exists: b !== undefined, balanceOs: b ?? 0n, nonce: 3 };
  }
  async getTx(hash: string): Promise<TxInfo> {
    return this.txs.get(hash) ?? { hash, found: false, state: 'not_found' };
  }
  async identities(address: string): Promise<unknown> {
    return this.idents.get(address) ?? { web2: {}, xm: {}, ud: [], pqc: {} };
  }
  async storageRead(a: string): Promise<StorageRecord | null> {
    return this.storage.get(a) ?? null;
  }
}

export class MockWallet implements Wallet {
  readonly address: string;
  broadcasts: PreparedTx[] = [];
  prepares = 0;
  signs = 0;
  feeOs = 2_000_000_000n;
  nextValid = true;
  /** When set, the wallet tries to smuggle this string out via messages/errors (leak fuzzing). */
  leak: string | null = null;
  private n = 0;
  constructor(private readonly kp = keypair(7)) {
    this.address = kp.address;
  }
  private mk(type: string, to: string, amountOs: bigint): PreparedTx {
    this.prepares++;
    const hash = Buffer.from(sha512(new TextEncoder().encode(`${type}${to}${amountOs}${this.n++}`))).toString('hex').slice(0, 64);
    return {
      hash,
      valid: this.nextValid,
      message: this.leak ? `validated ${this.leak}` : 'ok',
      feeOs: this.feeOs,
      referenceBlock: 999,
      content: { type, from: this.address, to, amountOs, nonce: String(4 + this.n) },
      opaque: { secret: this.leak ?? 'opaque-validity' },
    };
  }
  /** Mirrors DemosWallet: the local preflight refuses a fee above maxFeeOs BEFORE anything is transmitted. */
  async preparePay(to: string, amountOs: bigint, maxFeeOs: bigint): Promise<PreparedTx> {
    if (this.leak === 'throw') throw new Error(`rpc failed for mnemonic ${MNEMONIC}`);
    if (this.feeOs > maxFeeOs) throw new Error(`signed fee ${this.feeOs} OS exceeds the approved maximum ${maxFeeOs} OS; not transmitted`);
    return this.mk('native', to, amountOs);
  }
  async prepareAttest(_k: AttestKind, _p: string, maxFeeOs: bigint): Promise<PreparedTx> {
    if (this.feeOs > maxFeeOs) throw new Error('signed fee exceeds the approved maximum; not transmitted');
    return this.mk('identity', this.address, 0n);
  }
  async proofPayload(context: string, subject: string): Promise<string> {
    return `demos:dw2p:ed25519:proof-for-${context}-${subject}`;
  }
  async signUtf8(message: string): Promise<Uint8Array> {
    this.signs++;
    return ed.sign(new TextEncoder().encode(message), this.kp.priv);
  }
  async broadcast(p: PreparedTx): Promise<BroadcastResult> {
    this.broadcasts.push(p);
    return { txHash: p.hash, state: 'included', blockNumber: 1001 };
  }
}

export interface Harness {
  client: Client;
  chain: MockChain;
  wallet: MockWallet;
  channel: CaptureChannel;
  config: Config;
  guard: SecretGuard;
  ledger: SpendLedger;
  gate: ConfirmationGate;
  outputs: string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: any }>;
  setNow(ms: number): void;
  approval: ApprovalServer | null;
}

export async function harness(env: Record<string, string> = {}, opts: { beforeServer?: (stateDir: string, wallet: MockWallet) => void; wallet?: MockWallet; approval?: boolean; codeFallback?: boolean; walletFactory?: WalletFactory; proofFetcher?: ProofFetcher; fetchImpl?: typeof fetch } = {}): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'demos-mcp-test-'));
  const config = loadConfig({
    DEMOS_MCP_ENABLE_WRITES: '1',
    DEMOS_MNEMONIC_FILE: '/nonexistent/mock',
    DEMOS_STATE_DIR: stateDir,
    DEMOS_CONFIRM_CHANNELS: 'stderr',
    ...env,
  } as NodeJS.ProcessEnv);
  // Test double: the harness's own mock RPC counts as the known testnet. A test
  // that passes its own DEMOS_RPC_URL keeps the real guard result.
  if (env.DEMOS_RPC_URL === undefined) config.rpcIsKnownTestnet = true;
  const guard = new SecretGuard();
  guard.register(MNEMONIC);
  guard.register(PASSPHRASE);
  const chain = new MockChain();
  const wallet = opts.wallet ?? new MockWallet();
  guard.registerBytes(keypair(7).priv);
  const channel = new CaptureChannel();
  let nowMs = Date.parse('2026-10-05T12:00:00Z');
  const now = () => nowMs;
  const approval = opts.approval ? new ApprovalServer('127.0.0.1', 0) : null;
  const gate = new ConfirmationGate([channel], config.confirmTtlMs, guard, opts.approval ? Date.now : now, approval, opts.codeFallback ?? true);
  const ledger = new SpendLedger(stateDir, config.dailyCapOs, () => new Date(nowMs));
  opts.beforeServer?.(stateDir, wallet);
  const server = createServer({ config, guard, chain, gate, ledger, openWallet: async () => wallet, now, persistReceipts: true, walletFactory: opts.walletFactory, proofFetcher: opts.proofFetcher, fetchImpl: opts.fetchImpl });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const outputs: string[] = [];
  return {
    client,
    chain,
    wallet,
    channel,
    config,
    guard,
    ledger,
    gate,
    outputs,
    approval,
    setNow: (ms) => {
      nowMs = ms;
    },
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      const text = r.content.map((c) => c.text).join('\n');
      outputs.push(text);
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { text, isError: !!r.isError, json };
    },
  };
}

export const ADDR_B = keypair(9).address;
export const ADDR_C = keypair(11).address;
