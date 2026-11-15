/**
 * Daily spend cap (amount + fee, in OS), enforced BEFORE signing (on the
 * requested amount plus a fee allowance) and re-checked with the node-confirmed
 * fee immediately before broadcast. The ledger is persisted so a restart does
 * not reset the cap; an unreadable ledger blocks writes (fail closed).
 * Days are UTC.
 *
 * Each day has a debit total. Every open reservation is also a record of its own
 * (price, network fee and storage fee) charged to the day it was made, so a release
 * frees only that record's parts, whenever and in whichever process it runs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { osToDem } from './amount.js';

/** The parts of one reservation, in OS. Together they are the approved maximum. */
export interface ReservationParts {
  priceOs: bigint;
  networkFeeOs: bigint;
  storageFeeOs: bigint;
}

const PART_KEYS = ['priceOs', 'networkFeeOs', 'storageFeeOs'] as const;
const DECIMAL = /^[0-9]+$/;
const UTC_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** An open reservation as stored: its parts are decimal strings. */
interface ReservationRecord {
  id: string;
  day: string;
  priceOs: string;
  networkFeeOs: string;
  storageFeeOs: string;
}

interface LedgerFile {
  version: 1;
  days: Record<string, string>;
  reservations?: ReservationRecord[];
}

const partsOf = (r: ReservationRecord): ReservationParts => ({ priceOs: BigInt(r.priceOs), networkFeeOs: BigInt(r.networkFeeOs), storageFeeOs: BigInt(r.storageFeeOs) });
const totalOs = (p: ReservationParts): bigint => p.priceOs + p.networkFeeOs + p.storageFeeOs;
const clampOs = (v: bigint, max: bigint): bigint => (v < 0n ? 0n : v > max ? max : v);

const isDecimal = (v: unknown): boolean => typeof v === 'string' && DECIMAL.test(v);

function isReservationRecord(r: unknown): r is ReservationRecord {
  if (typeof r !== 'object' || r === null) return false;
  const id: unknown = Reflect.get(r, 'id');
  const day: unknown = Reflect.get(r, 'day');
  return typeof id === 'string' && id !== '' && typeof day === 'string' && UTC_DAY.test(day) && PART_KEYS.every((k) => isDecimal(Reflect.get(r, k)));
}

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendCapError';
  }
}

export class SpendLedger {
  private readonly path: string;
  constructor(stateDir: string, private readonly configCapOs: bigint, private readonly now: () => Date = () => new Date()) {
    this.path = join(stateDir, 'spend-ledger.json');
    this.limitPath = join(stateDir, 'limits.json');
  }
  private readonly limitPath: string;

  /**
   * Effective daily cap: the configured cap, lowered by the human's own spending limit
   * (set on the approval page during onboarding). The limit can never raise the cap.
   */
  get capOs(): bigint {
    const l = this.userLimitOs();
    return l !== null && l < this.configCapOs ? l : this.configCapOs;
  }

  get configuredCapOs(): bigint {
    return this.configCapOs;
  }

  userLimitOs(): bigint | null {
    if (!existsSync(this.limitPath)) return null;
    try {
      const j = JSON.parse(readFileSync(this.limitPath, 'utf8')) as { dailyCapOs?: string };
      if (typeof j.dailyCapOs === 'string' && /^[0-9]+$/.test(j.dailyCapOs)) return BigInt(j.dailyCapOs);
    } catch {
      /* fall through */
    }
    return 0n; // unreadable limit file: fail closed (no spending)
  }

  setUserLimit(os: bigint): void {
    if (os < 0n) throw new SpendCapError('limit must be >= 0');
    mkdirSync(dirname(this.limitPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.limitPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, dailyCapOs: os.toString(), setAt: this.now().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(tmp, this.limitPath);
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private read(): LedgerFile {
    if (!existsSync(this.path)) return { version: 1, days: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new SpendCapError(`spend ledger ${this.path} is unreadable; writes are blocked until it is fixed or removed by the human`);
    }
    const f = parsed as LedgerFile;
    if (f?.version !== 1 || typeof f.days !== 'object' || f.days === null) {
      throw new SpendCapError(`spend ledger ${this.path} has an unknown format; writes are blocked`);
    }
    for (const v of Object.values(f.days)) {
      if (!isDecimal(v)) throw new SpendCapError('spend ledger is corrupted; writes are blocked');
    }
    this.checkReservations(f);
    return f;
  }

  /**
   * Every reservation record must be well formed with a unique id, and the open
   * reservations charged to a day must not add up to more than that day's total.
   * A total above their sum is older debit and stays charged. Nothing is rewritten.
   */
  private checkReservations(f: LedgerFile): void {
    const records: unknown = f.reservations === undefined ? [] : f.reservations;
    if (!Array.isArray(records)) throw new SpendCapError('spend ledger is corrupted; writes are blocked');
    const ids = new Set<string>();
    const openOsByDay = new Map<string, bigint>();
    for (const r of records) {
      if (!isReservationRecord(r) || ids.has(r.id)) throw new SpendCapError('spend ledger is corrupted; writes are blocked');
      ids.add(r.id);
      openOsByDay.set(r.day, (openOsByDay.get(r.day) ?? 0n) + totalOs(partsOf(r)));
    }
    for (const [day, openOs] of openOsByDay) {
      if (openOs > BigInt(f.days[day] ?? '0')) {
        throw new SpendCapError(`spend ledger: the open reservations charged to ${day} add up to more than that day's total; ${day} needs reconciliation by the human; writes are blocked`);
      }
    }
  }

  spentToday(): bigint {
    return BigInt(this.read().days[this.day()] ?? '0');
  }

  remainingToday(): bigint {
    const r = this.capOs - this.spentToday();
    return r > 0n ? r : 0n;
  }

  /** Throws SpendCapError if spending `os` now would exceed today's cap. */
  check(os: bigint, what: string): void {
    if (os < 0n) throw new SpendCapError('negative spend');
    const spent = this.spentToday();
    if (spent + os > this.capOs) {
      throw new SpendCapError(
        `${what} needs ${osToDem(os)} DEM but only ${osToDem(this.capOs - spent > 0n ? this.capOs - spent : 0n)} DEM of today's ${osToDem(this.capOs)} DEM cap remains (DEMOS_DAILY_CAP_DEM)`,
      );
    }
  }

  /**
   * Exclusive lock across processes sharing the state dir (O_EXCL lock file). A held lock is
   * never removed because of its age; one left behind by a crashed process is removed by the human.
   */
  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const until = Date.now() + 5_000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch {
        if (Date.now() > until) {
          throw new SpendCapError(`spend ledger is locked by another process (lock file ${lock}); if it stays locked, remove it if no other process is running`);
        }
        const t = Date.now() + 25;
        while (Date.now() < t) {
          /* short spin; reserve is rare and quick */
        }
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Check the cap and record the reservation atomically, under the cross-process lock
   * (call immediately before broadcast). Returns the reservation's id for `release`.
   * Throws SpendCapError when the cap is exceeded or the ledger is unreadable or inconsistent.
   */
  reserve(parts: ReservationParts, what: string): string {
    return this.withLock(() => this.reserveLocked(parts, what));
  }

  /**
   * Close a reservation and free its parts except `kept`: the debit that stays charged,
   * each part limited to what that reservation holds. Frees only this reservation's own
   * remaining parts from the day it was made on. An id that is not open frees nothing.
   */
  release(id: string, kept: Partial<ReservationParts> = {}): void {
    this.withLock(() => {
      const f = this.read();
      const open = f.reservations ?? [];
      const record = open.find((r) => r.id === id);
      if (!record) return;
      const held = partsOf(record);
      const keptOs = PART_KEYS.reduce((sum, k) => sum + clampOs(kept[k] ?? 0n, held[k]), 0n);
      f.days[record.day] = (BigInt(f.days[record.day] ?? '0') - (totalOs(held) - keptOs)).toString();
      f.reservations = open.filter((r) => r !== record);
      this.write(f);
    });
  }

  /** Persist the ledger, retaining yesterday for small backward clock steps across UTC midnight. */
  private write(f: LedgerFile): void {
    const yesterday = new Date(`${this.day()}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const oldestSettledDay = yesterday.toISOString().slice(0, 10);
    const openDays = new Set((f.reservations ?? []).map((r) => r.day));
    for (const d of Object.keys(f.days)) if (d < oldestSettledDay && !openDays.has(d)) delete f.days[d];
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private reserveLocked(parts: ReservationParts, what: string): string {
    if (PART_KEYS.some((k) => parts[k] < 0n)) throw new SpendCapError('negative spend');
    this.check(totalOs(parts), what);
    const f = this.read();
    const day = this.day();
    f.days[day] = (BigInt(f.days[day] ?? '0') + totalOs(parts)).toString();
    const id = randomUUID();
    f.reservations = [...(f.reservations ?? []), { id, day, priceOs: parts.priceOs.toString(), networkFeeOs: parts.networkFeeOs.toString(), storageFeeOs: parts.storageFeeOs.toString() }];
    this.write(f);
    return id;
  }
}
