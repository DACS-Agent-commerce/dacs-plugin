/**
 * Daily spend cap (amount + fee, in OS), enforced BEFORE signing (on the
 * requested amount plus a fee allowance) and re-checked with the node-confirmed
 * fee immediately before broadcast. The ledger is persisted so a restart does
 * not reset the cap; an unreadable ledger blocks writes (fail closed).
 * Days are UTC.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { osToDem } from './amount.js';

interface LedgerFile {
  version: 1;
  days: Record<string, string>;
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
      if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) throw new SpendCapError('spend ledger is corrupted; writes are blocked');
    }
    return f;
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

  /** Exclusive lock across processes sharing the state dir (O_EXCL lock file, stale after 30 s). */
  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const until = Date.now() + 5_000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
        } catch {
          /* raced with another holder */
        }
        if (Date.now() > until) throw new SpendCapError('spend ledger is locked by another process; try again');
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

  /** Check and record atomically, under the cross-process lock (call immediately before broadcast). */
  reserve(os: bigint, what: string): void {
    this.withLock(() => this.reserveLocked(os, what));
  }

  /** Return an unused reservation (a write that failed before broadcast, or a fee below its quote). */
  release(os: bigint): void {
    if (os <= 0n) return;
    this.withLock(() => {
      const f = this.read();
      const d = this.day();
      const cur = BigInt(f.days[d] ?? '0');
      f.days[d] = (cur > os ? cur - os : 0n).toString();
      this.write(f);
    });
  }

  private write(f: LedgerFile): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private reserveLocked(os: bigint, what: string): void {
    this.check(os, what);
    const f = this.read();
    const d = this.day();
    f.days[d] = (BigInt(f.days[d] ?? '0') + os).toString();
    // keep 31 days
    const keys = Object.keys(f.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 31))) delete f.days[k];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
