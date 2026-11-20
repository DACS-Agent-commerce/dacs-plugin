// The per-wallet actor fence (K0 EB5) for the embedded browser wallet. Every tab of one wallet takes the same Web
// Locks lock, so two signing or sending sections never interleave. Acquiring it is bounded (`tp1_fence_timeout`, the
// abort reason kept as the cause), a grant that arrives after the timeout is released at once and grants nothing, and
// only the owner's capability can release it or run a nested step under it. `connectionGeneration` changes only
// when a `replaceConnection` finishes; a nested one runs under its section's hold, and the section's release waits
// for it. The Web Locks manager and the clock are injected; nothing here touches `navigator`, a network or
// storage. No page loads this yet.

/** Time allowed to acquire the wallet fence before `tp1_fence_timeout`. */
export const FENCE_TIMEOUT_MS = 10_000;

// The largest delay `setTimeout` keeps; a longer one fires after 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const FENCE_LOCK_PREFIX = 'dacs-wallet-effects:';
const CONNECTION_REPLACEMENT_OPERATION = 'connection-replacement';

/**
 * The real clock: `now()` is `performance.now()` in ms; `setTimer(callback, ms)` returns the function that cancels it.
 * Tests and callers inject a controllable one with the same shape.
 */
export const SYSTEM_CLOCK = Object.freeze({
  now: () => performance.now(),
  setTimer(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
});

/** A K0 refusal: `code` is the K0 code and `cause` the underlying error or value when there is one. */
export class EffectBoundaryRefusal extends Error {
  constructor(code, options) {
    super(`effect boundary refused: ${code}`, options);
    this.name = 'EffectBoundaryRefusal';
    this.code = code;
  }
}

/** Returns an `EffectBoundaryRefusal` for `code`, with `cause` attached only when it is not `undefined`. */
export const refuse = (code, cause) => new EffectBoundaryRefusal(code, cause === undefined ? undefined : { cause });

/** Throws a `TypeError` naming the first of `names` that `value` does not have as a function; `what` labels `value`. */
export const requireFunctions = (what, value, names) => {
  for (const name of names) if (typeof value?.[name] !== 'function') throw new TypeError(`${what}.${name} must be a function`);
};

// Resolves with the function that releases the lock. A grant after the timeout returns at once and grants nothing; a
// timer that is delivered late does not extend the wait, because a grant is also checked against the clock itself.
function requestLock(locks, name, clock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    let startedAt;
    let cancelTimer;
    let phase = 'waiting';
    const expire = () => {
      phase = 'timed-out';
      abort.abort(new Error(`fence not granted within ${timeoutMs} ms`));
      reject(refuse('tp1_fence_timeout', abort.signal.reason));
    };
    const fail = (cause) => {
      if (phase !== 'waiting') return;
      phase = 'failed';
      // Cleanup is best effort: a broken canceller must not hide the original failure or leave this promise pending.
      try { cancelTimer?.(); } catch { /* The original failure remains the refusal's cause. */ }
      reject(refuse('eb_fence_failed', cause));
    };
    try {
      startedAt = clock.now();
      cancelTimer = clock.setTimer(() => {
        if (phase === 'waiting') expire();
      }, timeoutMs);
      if (typeof cancelTimer !== 'function') {
        fail(new TypeError('clock.setTimer must return a function that cancels the timer'));
        return;
      }
    } catch (cause) {
      fail(cause);
      return;
    }
    if (phase !== 'waiting') return;
    try {
      locks.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
        if (phase !== 'waiting') return undefined;
        if (clock.now() - startedAt >= timeoutMs) {
          cancelTimer();
          expire();
          return undefined;
        }
        cancelTimer();
        phase = 'granted';
        return new Promise((releaseLock) => resolve(releaseLock));
      }).catch(fail);
    } catch (cause) {
      fail(cause);
    }
  });
}

/**
 * The actor fence for one wallet, shared by every tab through Web Locks.
 * `run(operationId, work, capability?)` runs `work(capability)` holding the fence and releases it on every path;
 * with a capability it is a nested step: the capability must be the live one for the same operation (else
 * `tp1_fence_not_owned`) and nothing is acquired. `release(capability, operationId)` ends the hold and returns
 * whether it did; only the owner's own capability can. `owns(capability, operationId)` says whether the capability
 * is the live one. `replaceConnection(replace, capability?)` runs `replace` under the fence and bumps
 * `connectionGeneration` when `replace` finishes, which nothing else changes; it throws a `TypeError` at once when
 * `replace` is not a function. Code already inside a fenced section must pass the section's capability to
 * `replaceConnection` and to any nested `run`: without it they ask for the lock the section holds and wait until
 * `tp1_fence_timeout`. A nested `replaceConnection` that the section has not awaited is waited for before the lock is
 * released, so the next section sees the new generation. A nested `run` holds nothing of its own, so the section must
 * await it before the section ends; one still running then overlaps the next section. A
 * capability that is not the live one is refused `tp1_fence_not_owned`. `run` and `replaceConnection` throw
 * `tp1_fence_timeout` (cause kept) after `timeoutMs`
 * and `eb_fence_failed` (cause kept) when the lock request or acquisition clock calls fail, including timer
 * cancellation, or `clock.setTimer` does not return a function. `createWalletFence` throws a `TypeError` for a
 * `locks` without `request`, a `clock` without `now` and `setTimer`, a `timeoutMs` that is not an integer from 1 to 2^31-1, or a `walletId` that is not a non-empty string.
 */
export function createWalletFence({ locks, walletId, clock = SYSTEM_CLOCK, timeoutMs = FENCE_TIMEOUT_MS }) {
  requireFunctions('locks', locks, ['request']);
  requireFunctions('clock', clock, ['now', 'setTimer']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (typeof walletId !== 'string' || walletId === '') throw new TypeError('walletId must be a non-empty string');
  const lockName = `${FENCE_LOCK_PREFIX}${walletId}`;
  let holder = null;
  let connectionGeneration = 0;

  const owns = (capability, operationId) => holder !== null && holder.capability === capability && capability.operationId === operationId;

  // Owner-only: the lock ends with its callback, so only the holder's own capability can end it.
  function release(capability, operationId) {
    if (!owns(capability, operationId)) return false;
    const { releaseLock } = holder;
    holder = null;
    releaseLock();
    return true;
  }

  async function run(operationId, work, capability) {
    if (capability !== undefined) {
      if (!owns(capability, operationId)) throw refuse('tp1_fence_not_owned');
      return work(capability);
    }
    const releaseLock = await requestLock(locks, lockName, clock, timeoutMs);
    const own = Object.freeze({ operationId });
    const mine = { capability: own, releaseLock, replacements: new Set() };
    holder = mine;
    try {
      return await work(own);
    } finally {
      while (mine.replacements.size > 0) await Promise.allSettled([...mine.replacements]);
      release(own, operationId);
    }
  }

  function replaceConnection(replace, capability) {
    if (typeof replace !== 'function') throw new TypeError('replace must be a function');
    // Nested under a capability, the step belongs to the operation that holds it; otherwise it is its own operation.
    const operationId = capability === undefined ? CONNECTION_REPLACEMENT_OPERATION : capability?.operationId;
    const step = run(operationId, async () => {
      try {
        return await replace();
      } finally {
        connectionGeneration += 1;
      }
    }, capability);
    if (capability !== undefined && holder?.capability === capability) {
      const { replacements } = holder;
      replacements.add(step);
      const done = () => replacements.delete(step);
      step.then(done, done);
    }
    return step;
  }

  return { run, release, owns, replaceConnection, get connectionGeneration() { return connectionGeneration; } };
}
