// The effect boundary (K0) for the embedded browser wallet. Every effect-producing signature and every egress
// runs as one pass, in this order:
//   EB1-EB4  pre-checks: admission, stop, approval binding, authority. They refuse early and authorize nothing
//            after the fence wait.
//   EB5      the per-wallet actor fence (Web Locks), 10,000 ms to acquire. The pass captured the connection digest
//            and connectionGeneration before the wait, and every later synchronous check compares against them.
//   EB5r     under the fence, EB1-EB4 again. Then the EB signer runs the final stop read and the synchronous
//            rechecks and calls the inner signer in the same tick.
//   EB6      the signed bytes are persisted (record `signed`) before they can leave the page.
//   EB7      per egress stage: EB1, EB2, EB4 again, then digest and generation; a refusal keeps `signed-held`.
//   EB8      the stage's `<stage>-started` intent is persisted.
//   EB8f     the EB transmitter runs the final stop read and the synchronous checks, then the single transmission
//            in the same tick; a refusal is recorded as `<stage>-withheld`.
//   EB9      `<stage>-acknowledged`, or `<stage>-unknown` when the transmission threw. The fence is released on
//            every path.
// The pass hands out two things to the library that signs or sends: the EB signer `ebSign(innerSign, armed)` and
// the EB transmitter `ebTransmit(innerSend, armed)`. Both refuse `tp1_fence_not_owned` outside the pass that armed
// them. Stages are `dispatch`, or `confirm` then `broadcast` for a signed transaction; a stage that is not
// acknowledged ends the pass, so an unknown confirmation never advances to broadcast.
// Nothing here touches a network, IndexedDB or navigator: the Web Locks manager, the clock, the checks and the
// record store (`head(lane)`, `append(lane, expectedRevision, record)`) are injected. No page loads this module yet.

/** Time allowed to acquire the wallet fence before `tp1_fence_timeout`. */
export const FENCE_TIMEOUT_MS = 10_000;
/** Aggregate time one pass may spend inside authority and stop reads. */
export const PASS_READ_DEADLINE_MS = 10_000;

const FENCE_LOCK_PREFIX = 'dacs-wallet-effects:';
const CONNECTION_REPLACEMENT_OPERATION = 'connection-replacement';
const STAGE_NAMES = new Set(['dispatch', 'confirm', 'broadcast']);
const MAX_CAUSE_MESSAGE_LENGTH = 200;

const SYSTEM_CLOCK = Object.freeze({
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

const refuse = (code, cause) => new EffectBoundaryRefusal(code, cause === undefined ? undefined : { cause });

const requireFunctions = (what, value, names) => {
  for (const name of names) if (typeof value?.[name] !== 'function') throw new TypeError(`${what}.${name} must be a function`);
};

// A synchronous check passes only by answering exactly `true`; a string is the refusal code.
function runCheck(check, ...args) {
  try {
    return check(...args);
  } catch (cause) {
    throw refuse('eb_check_failed', cause);
  }
}

function enforce(answer) {
  if (answer === true) return;
  throw typeof answer === 'string' && answer !== '' ? refuse(answer) : refuse('eb_check_invalid', answer);
}

const describeCause = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'unknown',
  message: String(error?.message ?? error).slice(0, MAX_CAUSE_MESSAGE_LENGTH),
});

// Time spent inside reads is summed against one limit. A read races a timer for what is left; a result that
// settles after the timer, or that pushes the total over the limit, is ignored.
function createReadBudget(clock, limitMs) {
  let spentMs = 0;
  return (start, timeoutCode) => new Promise((resolve, reject) => {
    const startedAt = clock.now();
    const timedOut = () => reject(refuse(timeoutCode));
    if (limitMs - spentMs <= 0) return timedOut();
    const cancelTimer = clock.setTimer(() => { spentMs = limitMs; timedOut(); }, limitMs - spentMs);
    const finish = (settleRead) => (value) => {
      cancelTimer();
      spentMs += clock.now() - startedAt;
      if (spentMs > limitMs) timedOut(); else settleRead(value);
    };
    Promise.resolve().then(start).then(finish(resolve), finish(reject));
  });
}

// Resolves with the function that releases the lock. A grant that reaches the callback after the timeout returns
// at once, so the lock is released and nothing is granted.
function requestLock(locks, name, clock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    let phase = 'waiting';
    const cancelTimer = clock.setTimer(() => {
      if (phase !== 'waiting') return;
      phase = 'timed-out';
      abort.abort(new Error(`fence not granted within ${timeoutMs} ms`));
      reject(refuse('tp1_fence_timeout', abort.signal.reason));
    }, timeoutMs);
    locks.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
      if (phase !== 'waiting') return undefined;
      phase = 'granted';
      cancelTimer();
      return new Promise((releaseLock) => resolve(releaseLock));
    }).catch((cause) => {
      if (phase !== 'waiting') return;
      phase = 'failed';
      cancelTimer();
      reject(refuse('eb_fence_failed', cause));
    });
  });
}

/**
 * The actor fence for one wallet, shared by every tab through Web Locks.
 * `run(operationId, work, capability?)` runs `work(capability)` holding the fence and releases it on every path;
 * with a capability it is a nested step: the capability must be the live one for the same operation (else
 * `tp1_fence_not_owned`) and nothing is acquired. `replaceConnection(replace)` runs `replace` under the fence and
 * bumps `connectionGeneration`, which nothing else changes. Throws `tp1_fence_timeout` (cause kept) after `timeoutMs`.
 */
export function createWalletFence({ locks, walletId, clock = SYSTEM_CLOCK, timeoutMs = FENCE_TIMEOUT_MS }) {
  requireFunctions('locks', locks, ['request']);
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
    holder = { capability: own, releaseLock };
    try {
      return await work(own);
    } finally {
      release(own, operationId);
    }
  }

  const replaceConnection = (replace) => run(CONNECTION_REPLACEMENT_OPERATION, async () => {
    try {
      return await replace();
    } finally {
      connectionGeneration += 1;
    }
  });

  return { run, release, owns, replaceConnection, get connectionGeneration() { return connectionGeneration; } };
}

// The pass's view of the world. `capability` is the fence capability once acquired (nested steps pass it back to
// `boundary.runPass`); `live` ends with the pass. The synchronous methods never await.
function createArmedPass({ fence, checks, clock, stoppedCode }, { operationId, approvalRevision }) {
  const binding = Object.freeze({ digest: runCheck(checks.connectionDigest), generation: fence.connectionGeneration });
  const readWithinBudget = createReadBudget(clock, PASS_READ_DEADLINE_MS);
  const armed = {
    operationId,
    capability: null,
    live: true,
    signCalls: 0,
    sendCalls: 0,
    assertOwned() {
      if (!armed.live || !fence.owns(armed.capability, operationId)) throw refuse('tp1_fence_not_owned');
    },
    admit: () => enforce(runCheck(checks.admission)),
    approved: () => enforce(runCheck(checks.approval, approvalRevision)),
    bound() {
      if (runCheck(checks.connectionDigest) !== binding.digest || fence.connectionGeneration !== binding.generation) throw refuse('tp1_local_binding_changed');
    },
    async readStop() {
      let stopped;
      try {
        stopped = await readWithinBudget(() => checks.stopped(), 'stop_check_timeout');
      } catch (error) {
        throw error instanceof EffectBoundaryRefusal ? error : refuse('stop_check_failed', error);
      }
      if (stopped === true) throw refuse(stoppedCode);
      if (stopped !== false) throw refuse('stop_check_invalid', stopped);
    },
    async readAuthority() {
      try {
        await readWithinBudget(() => checks.readAuthority(), 'tp1_authority_timeout');
      } catch (error) {
        throw error instanceof EffectBoundaryRefusal ? error : refuse(typeof error?.code === 'string' ? error.code : 'tp1_authority_failed', error);
      }
    },
    // EB1-EB4 and then the binding: the pre-checks, and EB5r's refresh under the fence.
    async refresh() {
      armed.admit();
      await armed.readStop();
      armed.approved();
      await armed.readAuthority();
      armed.bound();
    },
    // EB7: EB1, EB2 and EB4 again, then the digest and generation.
    async verifyBeforeIntent() {
      armed.admit();
      await armed.readStop();
      await armed.readAuthority();
      armed.bound();
    },
    async finalStop() {
      armed.assertOwned();
      await armed.readStop();
    },
    recheckBeforeEffect() {
      armed.assertOwned();
      armed.admit();
      armed.approved();
      armed.bound();
    },
    beforeSigner() {
      armed.recheckBeforeEffect();
      armed.signCalls += 1;
    },
    beforeSend() {
      armed.assertOwned();
      if (armed.sendCalls > 0) throw refuse('eb_transmission_repeated');
      armed.admit();
      armed.bound();
      armed.sendCalls += 1;
    },
  };
  return armed;
}

/**
 * The EB signer: wraps the inner signer so that, when the library calls it, it awaits the final stop read, runs
 * the synchronous rechecks (owner, admission, approval, digest, generation) and calls `innerSign` in the same
 * tick. Rejects with the refusal (inner signer not called) outside the pass that created `armed`.
 */
export function ebSign(innerSign, armed) {
  return async (...args) => {
    await armed.finalStop();
    armed.beforeSigner();
    return innerSign(...args);
  };
}

/**
 * The EB transmitter (EB8f): awaits the final stop read, runs the synchronous checks (owner, admission, digest,
 * generation) and calls `innerSend` in the same tick, once per stage. Rejects with the refusal (inner send not
 * called) outside the pass that created `armed`.
 */
export function ebTransmit(innerSend, armed) {
  return async (...args) => {
    await armed.finalStop();
    armed.beforeSend();
    return innerSend(...args);
  };
}

// Appends under the lane's revision: the head is read once, every append is compared against the revision the
// previous append returned, and a failed, malformed or out-of-sequence answer is `eb_persist_failed`.
function createLaneCursor(records, lane, identity) {
  let revision;
  return {
    async append(fields) {
      try {
        revision ??= (await records.head(lane)).revision;
        if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('record store returned a malformed lane head');
        const next = await records.append(lane, revision, { ...identity, ...fields });
        if (next?.revision !== revision + 1) throw new TypeError('record store returned an out-of-sequence revision');
        revision = next.revision;
      } catch (cause) {
        throw refuse('eb_persist_failed', cause);
      }
    },
  };
}

async function obtainSignedBytes(armed, cursor, { sign, retained }) {
  if (retained !== undefined) {
    await armed.finalStop();
    armed.recheckBeforeEffect();
    return retained.bytes;
  }
  const signed = await sign(armed);
  if (armed.signCalls === 0) throw refuse('eb_signer_bypassed');
  if (!(signed instanceof Uint8Array) || signed.length === 0) throw refuse('eb_signed_bytes_invalid');
  const bytes = Uint8Array.from(signed);
  await cursor.append({ kind: 'signed', bytes });
  return bytes;
}

async function runStage(armed, cursor, { name, send }, bytes) {
  try {
    await armed.verifyBeforeIntent();
  } catch (error) {
    await cursor.append({ kind: 'signed-held', stage: name, cause: describeCause(error) });
    throw error;
  }
  await cursor.append({ kind: `${name}-started`, stage: name });
  const unknown = async (cause) => {
    await cursor.append({ kind: `${name}-unknown`, stage: name, cause: describeCause(cause) });
    return { stage: name, state: 'unknown', cause };
  };
  armed.sendCalls = 0;
  let result;
  try {
    result = await send(armed, bytes);
  } catch (error) {
    if (armed.sendCalls > 0) return unknown(error);
    await cursor.append({ kind: `${name}-withheld`, stage: name, cause: describeCause(error) });
    throw error;
  }
  if (armed.sendCalls !== 1) return unknown(refuse('eb_transmitter_bypassed'));
  await cursor.append({ kind: `${name}-acknowledged`, stage: name });
  return { stage: name, state: 'acknowledged', result };
}

function assertPassRequest(request) {
  for (const field of ['operationId', 'lane']) {
    if (typeof request?.[field] !== 'string' || request[field] === '') throw new TypeError(`${field} must be a non-empty string`);
  }
  if ((request.sign === undefined) === (request.retained === undefined)) throw new TypeError('exactly one of sign and retained is required');
  if (request.sign !== undefined) requireFunctions('request', request, ['sign']);
  if (request.retained !== undefined && !(request.retained.bytes instanceof Uint8Array && request.retained.bytes.length > 0)) throw new TypeError('retained.bytes must be non-empty bytes');
  for (const stage of request.stages ?? []) {
    if (!STAGE_NAMES.has(stage?.name)) throw new TypeError(`unknown stage ${stage?.name}`);
    requireFunctions('stage', stage, ['send']);
  }
}

/**
 * Builds the pass runner for one wallet. `checks`: `admission()` and `approval(revision)` answer `true` or a refusal
 * code; `connectionDigest()` answers the local digest; `stopped()` answers a boolean (true = stopped); `readAuthority()`
 * resolves when the binding is current. `records` is the record store. `stoppedCode` is the refusal for a stop
 * (`writes_stopped`, or `seller_stopped`).
 * `runPass({ operationId, lane, pinVersion, approvalRevision, sign | retained, stages, capability? })` resolves
 * `{ operationId, passId, outcomes }`, one outcome per stage that ran (`acknowledged` or `unknown`). It rejects with
 * an `EffectBoundaryRefusal` for every refusal, with the signer and transport untouched where K0 says so.
 */
export function createEffectBoundary({ fence, checks, records, clock = SYSTEM_CLOCK, newPassId = () => globalThis.crypto.randomUUID(), stoppedCode = 'writes_stopped' }) {
  requireFunctions('fence', fence, ['run', 'owns']);
  requireFunctions('checks', checks, ['admission', 'approval', 'connectionDigest', 'stopped', 'readAuthority']);
  requireFunctions('records', records, ['head', 'append']);

  async function runUnderFence(armed, capability, request) {
    armed.capability = capability;
    const { operationId, lane, pinVersion, approvalRevision } = request;
    const passId = newPassId();
    const cursor = createLaneCursor(records, lane, { operationId, lane, pinVersion, approvalRevision, passId });
    await armed.refresh();
    const bytes = await obtainSignedBytes(armed, cursor, request);
    const outcomes = [];
    for (const stage of request.stages ?? []) {
      outcomes.push(await runStage(armed, cursor, stage, bytes));
      if (outcomes.at(-1).state !== 'acknowledged') break;
    }
    return { operationId, passId, outcomes };
  }

  async function runPass(request) {
    assertPassRequest(request);
    const armed = createArmedPass({ fence, checks, clock, stoppedCode }, request);
    try {
      await armed.refresh();
      return await fence.run(request.operationId, (capability) => runUnderFence(armed, capability, request), request.capability);
    } finally {
      armed.live = false;
    }
  }

  return { runPass };
}
