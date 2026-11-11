/**
 * The chain boundary. Everything that touches @kynesyslabs/demosdk lives here,
 * behind two small interfaces so the tool layer can be unit-tested with a mock:
 *
 *   ChainReader — unauthenticated reads (no wallet).
 *   Wallet      — the only object that can sign. It is created lazily on the
 *                 first write, holds the key inside the SDK instance, and exposes
 *                 NO method that returns key material.
 */
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { Identities } from '@kynesyslabs/demosdk/abstraction';
import { StorageProgram } from '@kynesyslabs/demosdk/storage';
import { OS_PER_DEM } from './amount.js';
import { maybeParseJson } from './json.js';
import { denomination } from '@kynesyslabs/demosdk';
import { createHash } from 'node:crypto';
import { canonicalBytes } from './dacs/jcs.js';
import type { SecretGuard } from './secrets.js';

export interface NetworkInfo {
  rpcUrl: string;
  lastBlock: number;
  nodeVersion?: string;
  osDenominationActive: boolean;
  params?: Record<string, unknown> | null;
}

export interface AddressInfo {
  address: string;
  exists: boolean;
  balanceOs: bigint;
  nonce: number;
  identities?: unknown;
}

export interface TxInfo {
  hash: string;
  found: boolean;
  state: string; // included | failed | pending | not_found | unknown ("included" only once execution was read back)
  blockNumber?: number;
  /** True only when the stored transaction's execution was read back and matched this hash and its inclusion block. */
  executed?: boolean;
  /** Bounded cause when the node reports inclusion but execution is not established. */
  detail?: string;
  content?: {
    type?: string;
    from?: string;
    to?: string;
    amount?: string;
    nonce?: string;
    timestamp?: string;
    fee?: unknown;
    data?: unknown;
  };
}

export interface StorageRecord {
  storageAddress: string;
  owner?: string;
  data: unknown;
  sizeBytes?: number;
  createdByTx?: string;
  lastModifiedByTx?: string;
  createdAt?: string;
}

export interface ChainReader {
  readonly rpcUrl: string;
  networkInfo(): Promise<NetworkInfo>;
  addressInfo(address: string): Promise<AddressInfo>;
  getTx(hash: string): Promise<TxInfo>;
  identities(address: string): Promise<unknown>;
  storageRead(storageAddress: string): Promise<StorageRecord | null>;
}

/** A signed + node-confirmed but NOT broadcast transaction. */
export interface PreparedTx {
  hash: string;
  valid: boolean;
  message: string;
  feeOs: bigint;
  referenceBlock?: number;
  content: { type: string; from: string; to: string; amountOs: bigint; nonce: string; data?: unknown };
  /** Opaque SDK validity data; stays inside the server, never serialized to the model. */
  opaque: unknown;
}

export interface BroadcastResult {
  txHash: string;
  state: 'included' | 'failed' | 'pending';
  blockNumber?: number;
  detail?: string;
}

export type AttestKind = 'github' | 'twitter' | 'discord' | 'domain';

/**
 * A failure that happened AFTER signed bytes left this process (sent to the RPC's
 * confirm or broadcast). The transaction may still settle: callers must keep the cap
 * reservation and report the outcome as unknown, with the locally computed hash.
 */
export class TransmittedError extends Error {
  constructor(message: string, readonly txHash: string) {
    super(message);
    this.name = 'TransmittedError';
  }
}

export interface Wallet {
  readonly address: string;
  /**
   * Sign locally, check the SIGNED bytes against the approved action (type, sender,
   * recipient, amount, hash-covered fee <= maxFeeOs) and only then transmit them to the
   * RPC's confirm. Errors thrown after transmission are TransmittedError.
   */
  preparePay(to: string, amountOs: bigint, maxFeeOs: bigint): Promise<PreparedTx>;
  prepareAttest(kind: AttestKind, proof: string, maxFeeOs: bigint): Promise<PreparedTx>;
  proofPayload(context: 'github' | 'twitter' | 'discord' | 'domain', subject: string): Promise<string>;
  /** ed25519 signature over the UTF-8 bytes of `message` (64 bytes). Used for DACS artifacts only. */
  signUtf8(message: string): Promise<Uint8Array>;
  broadcast(p: PreparedTx): Promise<BroadcastResult>;
}

// ---------------------------------------------------------------------------

function osInteger(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  throw new Error('unparseable OS integer');
}

function feeFieldToOs(v: unknown, osActive: boolean): bigint {
  if (osActive) return osInteger(v);
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new Error('unparseable fee');
    // Pre-fork JSON numbers are DEM.
    return BigInt(Math.round(v * 1e9));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') throw new Error('unparseable fee');
    if (s.includes('.')) {
      const [i = '0', f = ''] = s.split('.');
      return BigInt(i) * OS_PER_DEM + BigInt(f.padEnd(9, '0').slice(0, 9) || '0');
    }
    if (!/^[0-9]+$/.test(s)) throw new Error('unparseable fee');
    return BigInt(s);
  }
  throw new Error('unparseable fee');
}

export function feeFromValidity(validity: unknown, osActive: boolean): bigint {
  const data = (validity as { response?: { data?: Record<string, any> } })?.response?.data;
  const fees = data?.gas_operation?.fees ?? data?.transaction?.content?.transaction_fee;
  // fail closed: a write whose fee the node did not state cannot be checked against the cap
  if (!fees || typeof fees !== 'object') throw new Error('node did not return a fee for this transaction; refusing');
  return (
    feeFieldToOs(fees.network_fee, osActive) +
    feeFieldToOs(fees.rpc_fee, osActive) +
    feeFieldToOs(fees.additional_fee, osActive)
  );
}

function amountToOs(v: unknown, osActive: boolean): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isFinite(v)) return osActive ? BigInt(Math.round(v)) : BigInt(Math.round(v * 1e9));
  return 0n;
}

function sanitizeError(e: unknown, guard: SecretGuard): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(guard.redact(msg).slice(0, 500));
}

// One deadline, byte cap and collection limit for a status read and the execution read that follows it.
const READ_DEADLINE_MS = 10_000;
const READ_MAX_BYTES = 1024 * 1024;
const READ_MAX_ITEMS = 256;

/**
 * One node read under the caller's absolute deadline. The SDK offers no streaming hook, so the byte cap applies
 * to the decoded answer: an oversized or unserializable answer is refused. The read only reads; it never sends.
 */
async function boundedRead(read: () => Promise<unknown>, deadlineAt: number): Promise<unknown> {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) throw new Error('read deadline reached');
  let timer: NodeJS.Timeout | undefined;
  try {
    const v = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('read timed out')), ms); })]);
    if (v !== undefined && (JSON.stringify(v) ?? '').length > READ_MAX_BYTES) throw new Error('read answer over the size cap');
    return v;
  } finally {
    clearTimeout(timer);
  }
}

type Execution = { state: 'executed' } | { state: 'failed' } | { state: 'unproven'; cause: string };

/**
 * Inclusion only says where to look. The stored transaction (getTxByHash: hash, blockNumber, status) is the execution
 * evidence: "confirmed" is executed, "failed" is failed, anything else is unproven. It must carry the requested hash
 * and the inclusion block, and, for a prepared operation, the approved type, sender, recipient, amount, nonce, data and fee.
 */
function judgeExecution(tx: any, hash: string, blockNumber: unknown, approved?: PreparedTx, osActive = false): Execution {
  const no = (cause: string): Execution => ({ state: 'unproven', cause });
  const bare = (h: string) => h.replace(/^0x/i, '').toLowerCase();
  if (!tx || typeof tx !== 'object') return no('execution not readable: no stored transaction');
  if (typeof tx.hash !== 'string' || bare(tx.hash) !== bare(hash)) return no('execution read answered a different transaction');
  if (typeof blockNumber !== 'number' || tx.blockNumber !== blockNumber) return no('stored block differs from the inclusion block');
  if (tx.status === 'failed') return { state: 'failed' };
  if (tx.status !== 'confirmed') return no(`stored status is ${typeof tx.status === 'string' ? tx.status.slice(0, 32) : 'absent'}, not confirmed`);
  if (!approved) return { state: 'executed' };
  const raw = tx.content;
  const c = typeof raw === 'string' ? (maybeParseJson(raw) as any) : raw;
  if (!c || typeof c !== 'object') return no('execution not readable: stored transaction has no content');
  if ((Array.isArray(c.gcr_edits) && c.gcr_edits.length > READ_MAX_ITEMS) || (Array.isArray(c.data) && c.data.length > READ_MAX_ITEMS)) return no('stored transaction content over the collection limit');
  const a = approved.content;
  const lc = (v: unknown) => String(v).toLowerCase();
  let amount = -1n;
  let nonce: string | null = null;
  try {
    amount = osActive ? osInteger(c.amount) : typeof c.amount === 'string' && /^[0-9]+$/.test(c.amount) ? BigInt(c.amount) : typeof c.amount === 'number' && Number.isFinite(c.amount) ? amountToOs(c.amount, false) : -1n;
  } catch {
    /* unreadable amount stays -1 and mismatches */
  }
  try {
    nonce = osActive ? osInteger(c.nonce).toString() : String(c.nonce);
  } catch {
    /* unreadable nonce stays null and mismatches */
  }
  let fee = -1n;
  try {
    const f = c.transaction_fee;
    if (f && typeof f === 'object') fee = feeFieldToOs(f.network_fee, osActive) + feeFieldToOs(f.rpc_fee, osActive) + feeFieldToOs(f.additional_fee, osActive);
  } catch {
    /* unreadable fee stays -1 and mismatches */
  }
  let dataOk = false;
  try {
    dataOk = Buffer.compare(canonicalBytes(c.data ?? null), canonicalBytes(a.data ?? null)) === 0;
  } catch {
    /* unserializable data mismatches */
  }
  const differs = [
    ['type', c.type === a.type],
    ['sender', lc(c.from) === lc(a.from)],
    ['recipient', lc(c.to) === lc(a.to)],
    ['amount', amount === a.amountOs],
    ['nonce', nonce === a.nonce],
    ['data', dataOk],
    ['fee', fee === approved.feeOs],
  ].filter(([, same]) => !same).map(([field]) => field);
  return differs.length ? no(`stored ${differs.join(', ')} differs from the approved transaction`) : { state: 'executed' };
}

export class DemosChain implements ChainReader {
  private demos: Demos | null = null;
  private osActive: boolean | null = null;

  constructor(readonly rpcUrl: string, private readonly guard: SecretGuard) {}

  private async client(): Promise<Demos> {
    if (!this.demos) {
      const d = new Demos();
      await d.connect(this.rpcUrl);
      this.demos = d;
    }
    return this.demos;
  }

  async osDenominationActive(): Promise<boolean> {
    if (this.osActive !== null) return this.osActive;
    const d = await this.client();
    const info = (await d.getNetworkInfo().catch(() => null)) as any;
    this.osActive = !!info?.forks?.osDenomination?.activated;
    return this.osActive;
  }

  async networkInfo(): Promise<NetworkInfo> {
    try {
      const d = await this.client();
      const [lastBlock, info, params] = await Promise.all([
        d.getLastBlockNumber(),
        d.getNetworkInfo().catch(() => null) as Promise<any>,
        d.getNetworkParameters().catch(() => null) as Promise<any>,
      ]);
      this.osActive = !!info?.forks?.osDenomination?.activated;
      return {
        rpcUrl: this.rpcUrl,
        lastBlock: Number(lastBlock),
        nodeVersion: info?.nodeVersion ? `${info.nodeVersion.name}@${info.nodeVersion.version} (${info.nodeVersion.commitShort ?? ''})` : undefined,
        osDenominationActive: this.osActive,
        params: params ?? null,
      };
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }

  async addressInfo(address: string): Promise<AddressInfo> {
    try {
      const d = await this.client();
      const info = (await d.getAddressInfo(address)) as any;
      if (!info) return { address, exists: false, balanceOs: 0n, nonce: 0 };
      const osActive = await this.osDenominationActive();
      return {
        address,
        exists: true,
        balanceOs: amountToOs(info.balance, osActive),
        nonce: Number(info.nonce ?? 0),
        identities: info.identities,
      };
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }

  async getTx(hash: string): Promise<TxInfo> {
    const d = await this.client().catch((e) => {
      throw sanitizeError(e, this.guard);
    });
    const deadlineAt = Date.now() + READ_DEADLINE_MS; // shared by the status read and the execution read
    let status: any = null;
    let statusErr: unknown = null;
    try {
      status = await boundedRead(() => d.nodeCall('getTransactionStatus', { hash }), deadlineAt);
    } catch (e) {
      statusErr = e;
    }
    let tx: any = null;
    let txReadErr: unknown = null;
    try {
      tx = await boundedRead(() => d.getTxByHash(hash), deadlineAt);
    } catch (e) {
      tx = null;
      txReadErr = e;
    }
    // The SDK's call() never throws: an error reply comes back as a {result, response, require_reply} envelope.
    // For an HTTP error status that envelope is {result: 500, response: TransportError}, and the node's real
    // status and body are on the error's cause (the axios error's response).
    const isEnvelope = (x: any) => x && typeof x === 'object' && typeof x.result === 'number' && x.result >= 400 && 'require_reply' in x;
    const replyOf = (x: any): { status: number; body: any } => {
      const httpReply = x.response instanceof Error ? (x.response as any).cause?.response : undefined;
      if (httpReply && typeof httpReply.status === 'number') {
        const data = httpReply.data;
        return { status: httpReply.status, body: data && typeof data === 'object' && 'response' in data ? data.response : data };
      }
      return { status: x.result, body: x.response };
    };
    // Only a 404 whose body says what the node searched is "no such transaction": getTransactionStatus answers
    // {state: "unknown", checkedThroughBlock}, getTxByHash {checkedThroughBlock}. Any other error reply (a transport
    // failure, a 500 lookup_failed, a 404 "Unknown message" for a missing handler) says nothing about the hash.
    const searchedAbsent = (x: any) => {
      const { status, body } = replyOf(x);
      if (status !== 404 || !body || typeof body !== 'object' || body instanceof Error) return false;
      return typeof body.checkedThroughBlock === 'number' || body.state === 'unknown' || body.state === 'not_found';
    };
    const envelopeError = (x: any) => (x.response instanceof Error ? x.response : new Error(`node returned result ${x.result}`));
    let txErr: unknown = null;
    if (isEnvelope(status)) {
      if (!searchedAbsent(status)) statusErr = envelopeError(status);
      status = null;
    }
    if (isEnvelope(tx)) {
      if (!searchedAbsent(tx)) txErr = envelopeError(tx);
      tx = null;
    }
    const contentRaw = tx?.content;
    const content = typeof contentRaw === 'string' ? (maybeParseJson(contentRaw) as any) : contentRaw;
    // The node reports "unknown" (as well as "not_found") for a hash it has never seen, so neither state is evidence
    // that the transaction exists; only transaction content or a known state is.
    const found = !!content || (status && typeof status === 'object' && typeof status.state === 'string' && status.state !== 'not_found' && status.state !== 'unknown');
    // An error on either read is surfaced unless the other read shows the transaction.
    if (!found && (statusErr || txErr)) throw sanitizeError(statusErr ?? txErr, this.guard);
    let state: string = typeof status?.state === 'string' ? status.state : found ? 'unknown' : 'not_found';
    let executed = false;
    let detail: string | undefined;
    if (state === 'included') {
      // inclusion is a location hint: success needs the execution read back for this hash and block
      const ex: Execution = txReadErr
        ? { state: 'unproven', cause: `execution read failed: ${sanitizeError(txReadErr, this.guard).message.slice(0, 120)}` }
        : judgeExecution(tx, hash, status.blockNumber);
      if (ex.state === 'executed') executed = true;
      else {
        state = ex.state === 'failed' ? 'failed' : 'pending';
        detail = ex.state === 'failed' ? 'included, but its execution failed' : `included; execution not established (${ex.cause})`;
      }
    }
    return {
      hash,
      found: !!found,
      state,
      executed,
      ...(detail ? { detail } : {}),
      blockNumber: typeof status?.blockNumber === 'number' ? status.blockNumber : tx?.blockNumber,
      content: content
        ? {
            type: content.type,
            from: content.from,
            to: content.to,
            amount: content.amount !== undefined ? String(content.amount) : undefined,
            nonce: content.nonce !== undefined ? String(content.nonce) : undefined,
            timestamp: content.timestamp !== undefined ? String(content.timestamp) : undefined,
            fee: content.transaction_fee,
            data: content.data,
          }
        : undefined,
    };
  }

  async identities(address: string): Promise<unknown> {
    try {
      const d = await this.client();
      const res = (await new Identities().getIdentities(d, 'getIdentities', address)) as any;
      if (res?.result !== 200) throw new Error(`node returned result ${res?.result}`);
      return res.response;
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }

  async storageRead(storageAddress: string): Promise<StorageRecord | null> {
    try {
      // nodeCall (not getByAddress) so "private / access denied" is distinguishable from "not found"
      const res = (await (StorageProgram as any).nodeCall(this.rpcUrl, 'getStorageProgram', { storageAddress })) as any;
      if (res?.result === 403) throw new Error('access denied: this storage program is not publicly readable');
      if (res?.result !== 200) throw new Error(`node returned result ${String(res?.result)}`);
      const r = res.response;
      if (!r) return null;
      return {
        storageAddress: r.storageAddress ?? storageAddress,
        owner: r.owner,
        data: r.data ?? null,
        sizeBytes: r.sizeBytes,
        createdByTx: r.createdByTx,
        lastModifiedByTx: r.lastModifiedByTx,
        createdAt: r.createdAt,
      };
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }

  /**
   * Create the signing wallet. Called only after a write is requested and policy allows it.
   * `beforeKeyLoad` runs after the node connection and immediately before the SDK loads the key;
   * if it throws, no key is loaded and the error is rethrown.
   */
  async openWallet(mnemonic: string, beforeKeyLoad?: () => void): Promise<Wallet> {
    try {
      const d = new Demos();
      await d.connect(this.rpcUrl);
      beforeKeyLoad?.();
      await d.connectWallet(mnemonic);
      // register derived key material so it can never leave through an output (required, not best effort)
      const kp = (await (d as any).crypto?.getIdentity?.('ed25519').catch(() => null)) as { privateKey?: Uint8Array } | null;
      if (!kp?.privateKey || kp.privateKey.length < 32) throw new Error('could not register the derived signing key with the output guard; refusing to open the wallet');
      this.guard.registerEd25519PrivateKey(kp.privateKey);
      return new DemosWallet(d, await this.osDenominationActive(), this.guard);
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }
}

class DemosWallet implements Wallet {
  readonly address: string;
  /** Per-operation check run on the signed tx BEFORE it is transmitted to the RPC. */
  private preflight: ((tx: any) => void) | null = null;
  private transmittedHash: string | null = null;

  constructor(private readonly d: Demos, private readonly osActive: boolean, private readonly guard: SecretGuard) {
    this.address = d.getAddress().toLowerCase();
    // Every SDK path that sends a signed tx to the node goes through demos.confirm(signedTx)
    // (programmatic runner, Identities builders). Interpose: nothing signed leaves this
    // process unless the current operation's preflight accepted the exact signed bytes.
    const original = (d as any).confirm.bind(d);
    (d as any).confirm = async (tx: any) => {
      const check = this.preflight;
      if (!check) throw new Error('refusing to transmit a signed transaction outside an approved operation');
      check(tx);
      this.transmittedHash = String(tx?.hash ?? '');
      return original(tx);
    };
  }

  /** Hash-covered fee of a signed tx (content.transaction_fee), in OS. */
  private contentFeeOs(c: any): bigint {
    const f = c?.transaction_fee;
    if (!f || typeof f !== 'object') throw new Error('signed transaction carries no fee; refusing');
    return feeFieldToOs(f.network_fee, this.osActive) + feeFieldToOs(f.rpc_fee, this.osActive) + feeFieldToOs(f.additional_fee, this.osActive);
  }

  private makePreflight(expected: { type: string; to: string; amountOs: bigint; maxFeeOs: bigint }) {
    return (tx: any) => {
      const c = tx?.content;
      if (!c || typeof tx?.hash !== 'string') throw new Error('signed transaction is malformed; not transmitted');
      if (c.type !== expected.type) throw new Error(`signed type ${String(c.type)} != approved ${expected.type}; not transmitted`);
      if (String(c.from).toLowerCase() !== this.address) throw new Error('signed sender is not this wallet; not transmitted');
      if (String(c.to).toLowerCase() !== expected.to) throw new Error('signed recipient differs from the approved one; not transmitted');
      const amt = typeof c.amount === 'string' && /^[0-9]+$/.test(c.amount) ? BigInt(c.amount) : typeof c.amount === 'bigint' ? c.amount : -1n;
      if (amt !== expected.amountOs) throw new Error('signed amount differs from the approved one; not transmitted');
      const fee = this.contentFeeOs(c);
      if (fee > expected.maxFeeOs) throw new Error(`signed fee ${fee} OS exceeds the approved maximum ${expected.maxFeeOs} OS; not transmitted`);
      const recomputed = createHash('sha256').update(denomination.serializeTransactionContent(c, this.osActive), 'utf8').digest('hex');
      if (recomputed !== tx.hash) throw new Error('signed hash does not match its content; not transmitted');
    };
  }

  /** Run an SDK operation under a preflight; classify failures as before/after transmission. */
  private async guarded(expected: { type: string; to: string; amountOs: bigint; maxFeeOs: bigint }, op: () => Promise<any>): Promise<PreparedTx> {
    // one operation at a time per wallet: preflight/transmission state is a single slot
    if (this.preflight !== null) throw new Error('another wallet operation is in progress; try again');
    this.preflight = this.makePreflight(expected);
    this.transmittedHash = null;
    let r: any;
    try {
      r = await op();
    } catch (e) {
      const sent = this.transmittedHash;
      if (sent) throw new TransmittedError(`after the signed tx was sent to the RPC: ${sanitizeError(e, this.guard).message}`, sent);
      throw sanitizeError(e, this.guard);
    } finally {
      this.preflight = null;
    }
    const sent = this.transmittedHash;
    // the invariant: nothing reaches broadcast unless the preflight accepted its signed bytes
    if (!sent) throw new Error('operation completed without a preflighted transmission; refusing');
    try {
      const p = this.toPrepared(r, expected.type);
      if (p.content.to !== expected.to || p.content.amountOs !== expected.amountOs) throw new Error('confirmed transaction differs from the approved action');
      if (sent && p.hash !== sent) throw new Error('node confirmed a different transaction than the one sent');
      if (p.feeOs > expected.maxFeeOs) throw new Error('confirmed fee exceeds the approved maximum');
      return p;
    } catch (e) {
      if (sent) throw new TransmittedError(`after the signed tx was sent to the RPC: ${sanitizeError(e, this.guard).message}`, sent);
      throw e;
    }
  }

  /**
   * Build a PreparedTx from what the node actually confirmed, never from the request:
   * every displayed field is read from the signed content, the content hash is
   * recomputed with the SDK's own serializer and must equal the signed hash, the
   * sender must be this wallet, and the SDK's fee must equal ours.
   */
  private toPrepared(r: any, expectedType: string): PreparedTx {
    const validity = r?.validityData;
    const data = validity?.response?.data;
    const tx = data?.transaction;
    const c = tx?.content;
    if (!c || typeof tx?.hash !== 'string') throw new Error('node confirm response carried no transaction; refusing');
    if (c.type !== expectedType) throw new Error(`signed transaction type ${String(c.type)} != expected ${expectedType}; refusing`);
    if (typeof c.from !== 'string' || c.from.toLowerCase() !== this.address) throw new Error('signed transaction sender is not this wallet; refusing');
    if (typeof c.to !== 'string' || !/^0x[0-9a-f]{64}$/i.test(c.to)) throw new Error('signed transaction has no valid recipient; refusing');
    if (typeof c.amount !== 'string' || !/^[0-9]+$/.test(c.amount)) throw new Error('signed transaction amount is not an OS integer string; refusing');
    const recomputed = createHash('sha256').update(denomination.serializeTransactionContent(c, this.osActive), 'utf8').digest('hex');
    if (recomputed !== tx.hash || (r?.hash !== undefined && r.hash !== tx.hash)) throw new Error('transaction hash does not match its signed content; refusing');
    // the hash-covered content fee is authoritative; any separately reported gas_operation fee must equal it
    const feeOs = this.contentFeeOs(c);
    const gas = data?.gas_operation?.fees;
    if (gas && typeof gas === 'object') {
      const g = feeFieldToOs(gas.network_fee, this.osActive) + feeFieldToOs(gas.rpc_fee, this.osActive) + feeFieldToOs(gas.additional_fee, this.osActive);
      if (g !== feeOs) throw new Error('node-reported fee differs from the signed fee; refusing');
    }
    if (typeof r?.feeOs === 'bigint' && r.feeOs !== feeOs && !gas) throw new Error('fee disagreement between SDK and server; refusing');
    return {
      hash: tx.hash,
      valid: data?.valid === true,
      message: String(data?.message ?? ''),
      feeOs,
      referenceBlock: typeof data?.reference_block === 'number' ? data.reference_block : undefined,
      content: { type: c.type, from: c.from.toLowerCase(), to: c.to.toLowerCase(), amountOs: BigInt(c.amount), nonce: String(c.nonce ?? ''), data: c.data },
      opaque: validity,
    };
  }

  async preparePay(to: string, amountOs: bigint, maxFeeOs: bigint): Promise<PreparedTx> {
    return this.guarded({ type: 'native', to: to.toLowerCase(), amountOs, maxFeeOs }, () =>
      (this.d as any).run.pay(to, amountOs, { confirm: 'manual', maxFee: null }),
    );
  }

  async prepareAttest(kind: AttestKind, proof: string, maxFeeOs: bigint): Promise<PreparedTx> {
    return this.guarded({ type: 'identity', to: this.address, amountOs: 0n, maxFeeOs }, () =>
      (this.d as any).run.attest[kind](proof, undefined, { confirm: 'manual', maxFee: null }),
    );
  }

  async proofPayload(context: 'github' | 'twitter' | 'discord' | 'domain', subject: string): Promise<string> {
    try {
      const ids = new Identities();
      if (context === 'domain') return await ids.createDomainProofPayload(this.d, subject);
      return await ids.createWeb2ProofPayload(this.d, { context, username: subject });
    } catch (e) {
      throw sanitizeError(e, this.guard);
    }
  }

  async signUtf8(message: string): Promise<Uint8Array> {
    const s = await this.d.signMessage(message, { algorithm: 'ed25519' });
    const hex = String(s.data).replace(/^0x/, '');
    const sig = Uint8Array.from(Buffer.from(hex, 'hex'));
    if (sig.length !== 64) throw new Error('unexpected signature length from wallet');
    return sig;
  }

  async broadcast(p: PreparedTx): Promise<BroadcastResult> {
    // The SDK transport may retry a broadcast on 5xx / connection errors. Re-sending the SAME
    // signed tx (same hash, same nonce) cannot spend twice; the node dedupes by hash/nonce. What
    // we must never do is report an ambiguous outcome as "failed": we poll the same hash instead.
    let res: any = null;
    let sendError: string | null = null;
    try {
      res = await this.d.broadcast(p.opaque as any);
    } catch (e) {
      sendError = sanitizeError(e, this.guard).message;
    }
    const accepted = res?.result === 200;
    const rejectDetail = !accepted
      ? sendError ??
        this.guard
          .redact(
            String(
              typeof res?.response === 'string'
                ? res.response
                : res?.response instanceof Error
                  ? res.response.message
                  : JSON.stringify(res?.response ?? res?.extra ?? null),
            ),
          )
          .slice(0, 300)
      : undefined;
    const deadline = Date.now() + (accepted ? 60_000 : 20_000);
    let notExecuted = ''; // why an included transaction is not yet success
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      let st: any = null;
      try {
        st = await boundedRead(() => this.d.nodeCall('getTransactionStatus', { hash: p.hash }), deadline);
      } catch {
        continue;
      }
      if (st?.state === 'failed') return { txHash: p.hash, state: 'failed', detail: 'node reported failed' };
      if (st?.state !== 'included') continue;
      // inclusion is only a location hint: read the same hash back (never resend) under the same deadline
      let ex: Execution;
      try {
        ex = judgeExecution(await boundedRead(() => this.d.getTxByHash(p.hash), deadline), p.hash, st.blockNumber, p, this.osActive);
      } catch (e) {
        ex = { state: 'unproven', cause: `execution read failed: ${sanitizeError(e, this.guard).message.slice(0, 120)}` };
      }
      if (ex.state === 'executed') return { txHash: p.hash, state: 'included', blockNumber: st.blockNumber };
      if (ex.state === 'failed') return { txHash: p.hash, state: 'failed', blockNumber: st.blockNumber, detail: 'included, but its execution failed' };
      notExecuted = ex.cause;
    }
    return {
      txHash: p.hash,
      state: 'pending',
      detail: notExecuted
        ? `included, but execution not established (${notExecuted}) — check with demos_tx_get, do not resubmit`
        : accepted
          ? 'accepted for propagation; inclusion not observed within 60s — check with demos_tx_get, do not resubmit'
          : `broadcast outcome unknown (${rejectDetail}); not observed on chain within 20s — check with demos_tx_get before trying again; do not resubmit blindly`,
    };
  }
}
