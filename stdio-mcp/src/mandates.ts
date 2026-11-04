/**
 * Mandates — pre-approved spend classes (DESIGN + EVALUATOR; not yet wired to
 * replace human approval). See docs/MANDATES.md.
 *
 * A mandate is an owner-issued scope: which recipients, max per transaction,
 * a total allowance, a per-day cap, an expiry and a network. Its identity is
 * sha256(JCS(mandate)). Allowance is CONSERVED: the ledger keeps
 * spent + reserved per mandate hash and the evaluator refuses anything that
 * would make spent + reserved + amount exceed the allowance. Editing a mandate
 * changes its hash, so it cannot inherit another mandate's ledger, and a child
 * mandate (delegation) must fit inside its parent's remaining allowance.
 *
 * The kill file (<stateDir>/KILL) is wired now: while it exists, every write
 * and every mandate is refused.
 */
import { join } from 'node:path';
import { markerPresent } from './config.js';
import { canonicalBytes, sha256Hex } from './dacs/jcs.js';

export interface Mandate {
  mandateVersion: '1';
  network: 'testnet' | 'mainnet';
  /** Allowed recipients (0x addresses). Empty = none allowed. */
  recipients: string[];
  maxPerTxOs: string;
  allowanceOs: string;
  perDayOs: string;
  /** unix ms */
  expiresAt: number;
  /** Hash of the parent mandate when this is a delegation. */
  parent?: string | null;
  purpose?: string;
}

export interface MandateUsage {
  spentOs: bigint;
  reservedOs: bigint;
  spentTodayOs: bigint;
}

export interface MandateDecision {
  allow: boolean;
  mandateHash: string;
  trace: Array<{ rule: string; pass: boolean; observed: string }>;
}

export function mandateHash(m: Mandate): string {
  return sha256Hex(canonicalBytes(m));
}

export function killSwitchEngaged(stateDir: string): boolean {
  return markerPresent(join(stateDir, 'KILL'));
}

const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * Deterministic evaluation; every rule is evaluated (no short-circuit) so the
 * trace is complete. Fail closed on any malformed field.
 */
export function evaluateMandate(
  m: Mandate,
  action: { network: string; to: string; amountOs: bigint; feeOs: bigint; now: number },
  usage: MandateUsage,
  opts: { stateDir: string; parentRemainingOs?: bigint | null },
): MandateDecision {
  const trace: MandateDecision['trace'] = [];
  const rule = (name: string, pass: boolean, observed: string) => trace.push({ rule: name, pass, observed });
  const wellFormed =
    m?.mandateVersion === '1' &&
    Array.isArray(m.recipients) &&
    [m.maxPerTxOs, m.allowanceOs, m.perDayOs].every((v) => typeof v === 'string' && DIGITS.test(v)) &&
    Number.isInteger(m.expiresAt);
  rule('well-formed', wellFormed, wellFormed ? 'ok' : 'malformed mandate');
  const total = action.amountOs + action.feeOs;
  rule('kill-switch-off', !killSwitchEngaged(opts.stateDir), killSwitchEngaged(opts.stateDir) ? 'KILL file present' : 'absent');
  rule('network', wellFormed && m.network === action.network, `${action.network}`);
  rule('not-expired', wellFormed && action.now < m.expiresAt, new Date(action.now).toISOString());
  rule('recipient', wellFormed && m.recipients.map((r) => r.toLowerCase()).includes(action.to.toLowerCase()), action.to);
  rule('max-per-tx', wellFormed && total <= BigInt(m.maxPerTxOs), `${total} OS`);
  rule('allowance-conserved', wellFormed && usage.spentOs + usage.reservedOs + total <= BigInt(m.allowanceOs), `${usage.spentOs}+${usage.reservedOs}+${total} OS`);
  rule('per-day', wellFormed && usage.spentTodayOs + total <= BigInt(m.perDayOs), `${usage.spentTodayOs}+${total} OS`);
  if (m?.parent) {
    rule('fits-parent', opts.parentRemainingOs !== undefined && opts.parentRemainingOs !== null && wellFormed && BigInt(m.allowanceOs) <= opts.parentRemainingOs, `parent remaining ${opts.parentRemainingOs ?? 'unknown'}`);
  }
  return { allow: trace.every((t) => t.pass), mandateHash: wellFormed ? mandateHash(m) : '', trace };
}
