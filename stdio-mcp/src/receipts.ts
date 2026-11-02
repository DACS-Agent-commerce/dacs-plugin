/**
 * Write receipts (demos-mcp/receipt@2).
 *
 * Every confirmed write returns one; it is also appended to <stateDir>/receipts.jsonl.
 *  - `receipt_digest` = sha256(JCS(receipt minus receipt_digest and signature)).
 *  - `signature` = ed25519 by this install's RECEIPT key (not the wallet key) over
 *    "dacs-x-demos-mcp-receipt:v1:" || receipt_digest (CORE §B.7 SIG-4 extension form, SIG-6 value).
 *  - `approval` records HOW the action was allowed (out-of-band code, local approval
 *    page, or a mandate, with its hash).
 *  - `evidence` labels what each part proves: "replay-verifiable" fields can be re-checked
 *    on chain by anyone; "asserted" fields are only this issuer's word.
 * A receipt without an on-chain tx hash carries no replay-verifiable evidence and is
 * rejected by the verifier.
 * Daily anchor: `merkleRoot()` over a day's receipt digests (anchor it to SR-2 to make
 * the log tamper-evident; see README).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { randomBytes } from 'node:crypto';
import { canonicalBytes, sha256Hex } from './dacs/jcs.js';
import { encodeSig6 } from './dacs/sig.js';
import { toJsonSafe } from './json.js';
import type { SecretGuard } from './secrets.js';

export const RECEIPT_KIND = 'demos-mcp/receipt@2';
export const RECEIPT_SEP = 'dacs-x-demos-mcp-receipt:v1:';

export type ApprovalMethod = 'out-of-band-code' | 'local-approval-page' | 'mandate';

export interface ReceiptInput {
  action: string;
  network: string;
  rpcUrl: string;
  preparedAt: number;
  confirmedAt: number;
  actionDigest: string;
  alignment?: Record<string, unknown>;
  approval: { method: ApprovalMethod; channels: string[]; mandate_hash?: string | null };
  spendOs: bigint;
  chain?: {
    tx_hash: string;
    state: string;
    block_number?: number;
    from: string;
    to: string;
    amount_os: bigint;
    fee_os: bigint;
    detail?: string;
  };
  dacs?: Record<string, unknown>;
}

export const EVIDENCE_LABELS = {
  'chain.tx_hash': 'replay-verifiable (look up on chain)',
  'chain.from': 'replay-verifiable (on-chain content)',
  'chain.to': 'replay-verifiable (on-chain content)',
  'chain.amount_os': 'replay-verifiable (on-chain content)',
  'chain.state': 'asserted at issue time; re-check on chain',
  'chain.fee_os': 'asserted',
  action_digest: 'asserted (binds the approved summary; not reproducible without the prepare inputs)',
  approval: 'asserted by the issuer',
  spend_os: 'asserted (daily-cap accounting)',
  dacs: 'asserted; verify the returned signed DACS artifact itself',
  issuer: 'proved by signature; trust only if you pin this issuer key',
} as const;

/** Per-install receipt signing key (ed25519 seed, chmod 600). Never the wallet key. */
export class ReceiptSigner {
  private seed: Uint8Array | null = null;
  constructor(private readonly stateDir: string, private readonly guard: SecretGuard) {}

  private load(): Uint8Array {
    if (this.seed) return this.seed;
    const p = join(this.stateDir, 'receipt-key.json');
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { seed?: string };
      if (!j.seed || !/^[0-9a-f]{64}$/.test(j.seed)) throw new Error('receipt key file is malformed');
      this.seed = Uint8Array.from(Buffer.from(j.seed, 'hex'));
    } else {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      this.seed = randomBytes(32);
      writeFileSync(p, JSON.stringify({ seed: Buffer.from(this.seed).toString('hex') }) + '\n', { mode: 0o600, flag: 'wx' });
    }
    this.guard.registerBytes(this.seed);
    return this.seed;
  }

  issuerClaim(): string {
    return 'key:' + Buffer.from(ed.getPublicKey(this.load())).toString('hex');
  }

  sign(message: string): string {
    return encodeSig6(ed.sign(new TextEncoder().encode(message), this.load()));
  }
}

export function receiptDigest(receipt: Record<string, unknown>): string {
  const { receipt_digest: _d, signature: _s, ...body } = receipt;
  return sha256Hex(canonicalBytes(body));
}

export function buildReceipt(r: ReceiptInput, signer: ReceiptSigner): Record<string, unknown> {
  const body = toJsonSafe({
    kind: RECEIPT_KIND,
    action: r.action,
    network: r.network,
    rpc_url: r.rpcUrl,
    prepared_at: new Date(r.preparedAt).toISOString(),
    confirmed_at: new Date(r.confirmedAt).toISOString(),
    action_digest: r.actionDigest,
    ...(r.alignment ? {alignment: r.alignment} : {}),
    approval: { method: r.approval.method, channels: r.approval.channels, mandate_hash: r.approval.mandate_hash ?? null },
    spend_os: r.spendOs,
    ...(r.chain ? { chain: r.chain } : {}),
    ...(r.dacs ? { dacs: r.dacs } : {}),
    evidence: EVIDENCE_LABELS,
    issuer: signer.issuerClaim(),
  }) as Record<string, unknown>;
  const digest = receiptDigest(body);
  return {
    ...body,
    receipt_digest: digest,
    signature: { algorithm: 'ed25519', signer: body.issuer, value: signer.sign(RECEIPT_SEP + digest) },
  };
}

export function appendReceipt(stateDir: string, receipt: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(stateDir, 'receipts.jsonl'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
}

/** Binary Merkle root (sha256, duplicate-last on odd levels) over hex leaf digests. */
export function merkleRoot(leavesHex: string[]): string | null {
  if (leavesHex.length === 0) return null;
  let level: Buffer[] = leavesHex.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(Buffer.from(sha256Hex(Buffer.concat([a, b])), 'hex'));
    }
    level = next;
  }
  return level[0]!.toString('hex');
}

/** Daily anchor payload for receipts confirmed on `day` (YYYY-MM-DD, UTC). */
export function dailyAnchor(stateDir: string, day: string): { day: string; count: number; root: string | null; leaves: string[] } {
  const p = join(stateDir, 'receipts.jsonl');
  const leaves: string[] = [];
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { confirmed_at?: string; receipt_digest?: string };
        if (r.confirmed_at?.startsWith(day) && typeof r.receipt_digest === 'string') leaves.push(r.receipt_digest);
      } catch {
        /* skip malformed lines */
      }
    }
  }
  return { day, count: leaves.length, root: merkleRoot(leaves), leaves };
}
