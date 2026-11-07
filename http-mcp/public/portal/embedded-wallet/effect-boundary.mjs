// The effect boundary (K0) for the embedded browser wallet. Every effect-producing signature and every egress
// runs as one pass, in this order:
//   EB1-EB4  pre-checks: admission, stop, approval binding, authority. They refuse early and authorize nothing
//            after the fence wait.
//   EB5      the per-wallet actor fence (`wallet-fence.mjs`, Web Locks), 10,000 ms to acquire. The pass captured the
//            connection digest and connectionGeneration before the wait, and every later synchronous check compares
//            against them.
//   EB5r     under the fence, EB1-EB4 again. Then the EB signer runs the final stop read and the synchronous
//            rechecks and calls the inner signer in the same tick.
//   EB6      the signed bytes and the workflow are persisted (record `signed`) before they can leave the page.
//   EB7      per egress stage: EB1, EB2, EB4 again, then digest and generation; a refusal keeps `signed-held`.
//   EB8      the stage's `<stage>-started` intent is persisted.
//   EB8f     the EB transmitter runs the final stop read and the synchronous checks, then the single transmission
//            in the same tick; a refusal is recorded as `<stage>-withheld`.
//   EB9      `<stage>-acknowledged` once the transmission fulfilled, or `<stage>-unknown` once it was invoked and did
//            not (pending or failed when the stage returned). The fence is released on every path.
// A pass copies and freezes its request before its first await. Its stages are a closed tuple: a signing pass runs
// the workflow `dispatch` or `confirm-broadcast` (`confirm` then `broadcast`); a resume runs only a tuple RESUMES
// lists for the lane's signed workflow and newest record. A stage that is not acknowledged ends the pass.
// The sign step and each stage get their own one-use handle for the EB signer `ebSign(innerSign, handle)` or the EB
// transmitter `ebTransmit(innerSend, handle)`. A handle works only during its own step (else `tp1_fence_not_owned`)
// and only once; a stage's handle exists only after its `-started` record committed. The inner signer's bytes,
// copied before the sign step sees them, are the only bytes persisted and sent; each step and the transport get a
// fresh copy. The fence, the clock, the checks and the record store (`head(lane)` -> `{ revision, lastKind,
// lastStage, signedBytes, signedWorkflow }`, `append(lane, expectedRevision, record)`) are injected; nothing here
// touches a network, IndexedDB or navigator. No page loads this yet.
import { EffectBoundaryRefusal, SYSTEM_CLOCK, refuse, requireFunctions } from './wallet-fence.mjs';

/** Aggregate time one pass may spend inside authority and stop reads. */
export const PASS_READ_DEADLINE_MS = 10_000;

const MAX_CAUSE_MESSAGE_LENGTH = 200;
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, index) => byte === b[index]);

// A synchronous check passes only by answering exactly `true`; a string is the refusal code.
function runCheck(check, ...args) {
  try {
    return check(...args);
  } catch (cause) {
    throw refuse('eb_check_failed', cause);
  }
}

function enforce(answer) {
  if (answer !== true) throw typeof answer === 'string' && answer !== '' ? refuse(answer) : refuse('eb_check_invalid', answer);
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

// The stage tuples. A signing pass runs a whole workflow; a resume runs a tuple that RESUMES lists.
const DISPATCH = Object.freeze(['dispatch']);
const CONFIRM = Object.freeze(['confirm']);
const BROADCAST = Object.freeze(['broadcast']);
const CONFIRM_BROADCAST = Object.freeze(['confirm', 'broadcast']);
const WORKFLOWS = new Map([['dispatch', DISPATCH], ['confirm-broadcast', CONFIRM_BROADCAST]]);
const RESUME_TUPLES = Object.freeze([DISPATCH, CONFIRM, BROADCAST, CONFIRM_BROADCAST]);

// The resume table: the lane's signed workflow, its newest record's kind and held stage -> the tuples a resume may
// run. Every other head (`-started`, `-unknown`, `-acknowledged`, an unknown kind or workflow) is refused.
const resumeRow = (workflow, kind, stage, ...tuples) => Object.freeze({ workflow, kind, stage, tuples });
const RESUMES = Object.freeze([
  resumeRow('dispatch', 'signed', undefined, DISPATCH),
  resumeRow('dispatch', 'signed-held', 'dispatch', DISPATCH),
  resumeRow('dispatch', 'dispatch-withheld', 'dispatch', DISPATCH),
  resumeRow('confirm-broadcast', 'signed', undefined, CONFIRM, CONFIRM_BROADCAST),
  resumeRow('confirm-broadcast', 'signed-held', 'confirm', CONFIRM, CONFIRM_BROADCAST),
  resumeRow('confirm-broadcast', 'confirm-withheld', 'confirm', CONFIRM, CONFIRM_BROADCAST),
  resumeRow('confirm-broadcast', 'signed-held', 'broadcast', BROADCAST),
  resumeRow('confirm-broadcast', 'broadcast-withheld', 'broadcast', BROADCAST),
]);

// The held stage: a `<stage>-withheld` kind names it (a `lastStage` that differs gives `null`, which no row has);
// any other kind takes `lastStage`, so `signed-held` needs one and `signed` must have none.
function heldStage({ lastKind, lastStage }) {
  const named = typeof lastKind === 'string' && lastKind.endsWith('-withheld') ? lastKind.slice(0, -'-withheld'.length) : undefined;
  if (named === undefined) return lastStage;
  return lastStage === undefined || lastStage === named ? named : null;
}

const resumableTuples = (head) => RESUMES.find((row) => row.workflow === head.signedWorkflow && row.kind === head.lastKind && row.stage === heldStage(head))?.tuples ?? [];

// The checks each step runs, in order. `stop` and `authority` are awaited reads. The tails run synchronously after
// the step's final stop read (and, for EB8f, the handle and byte checks), so nothing awaits before the inner call.
// The approval binding is checked by the pre-checks, EB5r and the signer tail; EB7 and EB8f do not re-read it.
const STEP_CHECKS = Object.freeze({
  refresh: Object.freeze(['admission', 'stop', 'approval', 'authority', 'binding']),
  beforeIntent: Object.freeze(['admission', 'stop', 'authority', 'binding']),
  signerTail: Object.freeze(['owner', 'admission', 'approval', 'binding']),
  sendTail: Object.freeze(['owner', 'admission', 'binding']),
});

// Handles map to their step here. A handle is frozen and shows only the fence capability, for nested steps.
const STEPS = new WeakMap();

// The pass's state: `capability` is the fence capability, `bytes` the private canonical bytes, and at most one step
// is live at a time. Every check named in STEP_CHECKS is a method; the synchronous ones never await.
function createPass({ fence, checks, clock, stoppedCode }, { operationId, approvalRevision }) {
  const binding = Object.freeze({ digest: runCheck(checks.connectionDigest), generation: fence.connectionGeneration });
  const readWithinBudget = createReadBudget(clock, PASS_READ_DEADLINE_MS);
  let live = true;
  let current = null;
  const pass = {
    capability: null, bytes: undefined,
    owner() { if (!live || !fence.owns(pass.capability, operationId)) throw refuse('tp1_fence_not_owned'); },
    admission: () => enforce(runCheck(checks.admission)),
    approval: () => enforce(runCheck(checks.approval, approvalRevision)),
    binding() {
      if (runCheck(checks.connectionDigest) !== binding.digest || fence.connectionGeneration !== binding.generation) throw refuse('tp1_local_binding_changed');
    },
    async stop() {
      let stopped;
      try {
        stopped = await readWithinBudget(() => checks.stopped(), 'stop_check_timeout');
      } catch (error) {
        throw error instanceof EffectBoundaryRefusal ? error : refuse('stop_check_failed', error);
      }
      if (stopped === true) throw refuse(stoppedCode);
      if (stopped !== false) throw refuse('stop_check_invalid', stopped);
    },
    async authority() {
      try {
        await readWithinBudget(() => checks.readAuthority(), 'tp1_authority_timeout');
      } catch (error) {
        throw error instanceof EffectBoundaryRefusal ? error : refuse(typeof error?.code === 'string' ? error.code : 'tp1_authority_failed', error);
      }
    },
    async verify(names) { for (const name of names) await pass[name](); },
    verifyNow(names) { for (const name of names) pass[name](); },
    // Opens the only live step; its handle works until `closeStep()` or the end of the pass.
    openStep(kind) {
      const handle = Object.freeze({ get capability() { return pass.capability; } });
      current = { pass, kind, handle, state: 'open', signed: undefined, transmission: undefined };
      STEPS.set(handle, current);
      return current;
    },
    closeStep() { current = null; },
    isLive: (step) => live && step === current,
    copyBytes: () => Uint8Array.from(pass.bytes),
    end() { live = false; current = null; },
  };
  return pass;
}

// The live step behind a handle, of the given kind and under its owner's fence; anything else is not owned.
function liveStep(handle, kind) {
  const step = STEPS.get(handle);
  if (step?.kind !== kind || !step.pass.isLive(step)) throw refuse('tp1_fence_not_owned');
  step.pass.owner();
  return step;
}

// After the final stop read: the handle must still be live and unused.
function claimStep(handle, kind, repeatedCode) {
  const step = liveStep(handle, kind);
  if (step.state !== 'open') throw refuse(repeatedCode);
  return step;
}

/**
 * The EB signer: wraps the inner signer so that the library's call awaits the final stop read, runs the synchronous
 * rechecks (owner, admission, approval, digest, generation) and calls `innerSign` in the same tick. Rejects (inner
 * signer not called) unless `handle` is its pass's live sign handle, or with `eb_signer_repeated` on a second call.
 */
export function ebSign(innerSign, handle) {
  return async (...args) => {
    await liveStep(handle, 'sign').pass.stop();
    const step = claimStep(handle, 'sign', 'eb_signer_repeated');
    step.pass.verifyNow(STEP_CHECKS.signerTail);
    step.state = 'consumed';
    const signed = await innerSign(...args);
    if (step.pass.isLive(step) && signed instanceof Uint8Array) step.signed = Uint8Array.from(signed);
    return signed;
  };
}

/**
 * The EB transmitter (EB8f): copies the bytes it is given, awaits the final stop read, checks the handle, that the
 * copy equals the persisted bytes (`eb_bytes_mismatch`), admission, digest and generation, and calls `innerSend`
 * with a fresh copy in the same tick. Rejects (inner send not called) unless `handle` is the live stage handle, or
 * with `eb_transmission_repeated` on a second call.
 */
export function ebTransmit(innerSend, handle) {
  return async (bytes, ...rest) => {
    const offered = bytes instanceof Uint8Array ? Uint8Array.from(bytes) : undefined;
    await liveStep(handle, 'send').pass.stop();
    const step = claimStep(handle, 'send', 'eb_transmission_repeated');
    if (!sameBytes(offered, step.pass.bytes)) throw refuse('eb_bytes_mismatch');
    step.pass.verifyNow(STEP_CHECKS.sendTail);
    step.state = 'consumed';
    step.transmission = { status: 'pending' };
    const sending = (async () => innerSend(step.pass.copyBytes(), ...rest))();
    sending.then(() => { step.transmission = { status: 'fulfilled' }; }, (error) => { step.transmission = { status: 'failed', error }; });
    return sending;
  };
}

// Appends under the lane's revision: the head is read once, every append is compared against the revision the
// previous append returned, and a failed, malformed or out-of-sequence answer is `eb_persist_failed`.
function createLaneCursor(records, lane, identity) {
  let head;
  const readHead = async () => {
    head ??= await records.head(lane);
    if (!Number.isSafeInteger(head?.revision) || head.revision < 0) throw new TypeError('record store returned a malformed lane head');
    return head;
  };
  const guarded = (step) => step().catch((cause) => { throw refuse('eb_persist_failed', cause); });
  return {
    head: () => guarded(readHead),
    append: (fields) => guarded(async () => {
      const { revision } = await readHead();
      const next = await records.append(lane, revision, { ...identity, ...fields });
      if (next?.revision !== revision + 1) throw new TypeError('record store returned an out-of-sequence revision');
      head = { revision: next.revision };
    }),
  };
}

// A signing pass needs an empty lane and persists the signer's bytes with the workflow. A resume needs its tuple in
// RESUMES for the lane's head and the bytes of the lane's `signed` record; it then runs the EB5r tail.
async function signOrResume(pass, cursor, { sign, retained, tuple, workflow }) {
  const head = await cursor.head();
  if (retained !== undefined) {
    if (!resumableTuples(head).includes(tuple) || !sameBytes(retained, head.signedBytes)) throw refuse('eb_resume_not_allowed', head.lastKind);
    await pass.stop();
    pass.verifyNow(STEP_CHECKS.signerTail);
    return retained;
  }
  if (head.revision !== 0) throw refuse('eb_lane_not_empty', head.lastKind);
  const step = pass.openStep('sign');
  try {
    await sign(step.handle);
  } finally {
    pass.closeStep();
  }
  if (step.state === 'open') throw refuse('eb_signer_bypassed');
  if (!(step.signed?.length > 0)) throw refuse('eb_signed_bytes_invalid');
  await cursor.append({ kind: 'signed', workflow, bytes: Uint8Array.from(step.signed) });
  return step.signed;
}

// EB7, the `-started` intent, then the stage's own handle for EB8f. Once the handle was consumed the transmission
// was invoked, so the stage ends `acknowledged` or `unknown`, never withheld. It is `acknowledged` only when the EB
// transmitter's own transmission had fulfilled by the time the stage returned; one still pending, or one that
// failed under a stage that returned anyway, is `unknown`.
async function runStage(pass, cursor, { name, send }) {
  try {
    await pass.verify(STEP_CHECKS.beforeIntent);
  } catch (error) {
    await cursor.append({ kind: 'signed-held', stage: name, cause: describeCause(error) });
    throw error;
  }
  await cursor.append({ kind: `${name}-started`, stage: name });
  const step = pass.openStep('send');
  let settled;
  try {
    settled = { result: await send(step.handle, pass.copyBytes()) };
  } catch (error) {
    settled = { error };
  }
  pass.closeStep();
  const invoked = step.state === 'consumed';
  const unknown = async (cause) => {
    await cursor.append({ kind: `${name}-unknown`, stage: name, cause: describeCause(cause) });
    return { stage: name, state: 'unknown', cause };
  };
  if ('error' in settled) {
    if (invoked) return unknown(settled.error);
    await cursor.append({ kind: `${name}-withheld`, stage: name, cause: describeCause(settled.error) });
    throw settled.error;
  }
  if (!invoked) return unknown(refuse('eb_transmitter_bypassed'));
  if (step.transmission.status === 'failed') return unknown(step.transmission.error);
  if (step.transmission.status !== 'fulfilled') return unknown(refuse('eb_transmission_unfinished'));
  await cursor.append({ kind: `${name}-acknowledged`, stage: name });
  return { stage: name, state: 'acknowledged', result: settled.result };
}

const tupleOf = (candidates, names) => candidates.find((tuple) => tuple.length === names.length && tuple.every((name, index) => name === names[index]));

// The pass's own frozen copy of the request, read once. A signing pass's stages must be a whole workflow and a
// resume's a resumable tuple; anything else is a TypeError before any read, lock, record or effect.
function snapshotRequest(request) {
  const { operationId, lane, pinVersion, approvalRevision, capability, sign, retained, stages } = request ?? {};
  for (const [field, value] of [['operationId', operationId], ['lane', lane]]) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`${field} must be a non-empty string`);
  }
  if ((sign === undefined) === (retained === undefined)) throw new TypeError('exactly one of sign and retained is required');
  if (sign !== undefined && typeof sign !== 'function') throw new TypeError('request.sign must be a function');
  const retainedBytes = retained?.bytes;
  if (retained !== undefined && !(retainedBytes instanceof Uint8Array && retainedBytes.length > 0)) throw new TypeError('retained.bytes must be non-empty bytes');
  const steps = Array.from(Array.isArray(stages) ? stages : [], (stage) => Object.freeze({ name: stage?.name, send: stage?.send }));
  for (const { send } of steps) if (typeof send !== 'function') throw new TypeError('stage.send must be a function');
  const names = steps.map(({ name }) => name);
  const tuple = tupleOf(sign === undefined ? RESUME_TUPLES : [...WORKFLOWS.values()], names);
  if (tuple === undefined) throw new TypeError(`stages [${names.join(', ')}] are not a ${sign === undefined ? 'resumable tuple' : 'workflow'}`);
  const workflow = sign === undefined ? undefined : [...WORKFLOWS.keys()].find((name) => WORKFLOWS.get(name) === tuple);
  return Object.freeze({
    operationId, lane, pinVersion, approvalRevision, capability, sign, workflow, tuple,
    retained: retained === undefined ? undefined : Uint8Array.from(retainedBytes), stages: Object.freeze(steps),
  });
}

/**
 * Builds the pass runner for one wallet. `fence` is the wallet's `createWalletFence` result, `clock` the injected clock
 * and `newPassId` the pass id source. `checks`: `admission()` and `approval(revision)` answer `true` or a refusal
 * code; `connectionDigest()` answers the local digest; `stopped()` answers a boolean (true = stopped); `readAuthority()`
 * resolves when the binding is current. `records` is the record store. `stoppedCode` is the refusal for a stop
 * (`writes_stopped`, or `seller_stopped`). `runPass({ operationId, lane, pinVersion, approvalRevision, sign | retained,
 * stages, capability? })` resolves `{ operationId, passId, outcomes }`, one outcome per stage that ran (`acknowledged`
 * or `unknown`). It rejects with a TypeError for a malformed request or stage tuple, and with an
 * `EffectBoundaryRefusal` for every refusal, signer and transport untouched where K0 says so.
 */
export function createEffectBoundary({ fence, checks, records, clock = SYSTEM_CLOCK, newPassId = () => globalThis.crypto.randomUUID(), stoppedCode = 'writes_stopped' }) {
  requireFunctions('fence', fence, ['run', 'owns']);
  requireFunctions('checks', checks, ['admission', 'approval', 'connectionDigest', 'stopped', 'readAuthority']);
  requireFunctions('records', records, ['head', 'append']);

  async function runUnderFence(pass, capability, own) {
    pass.capability = capability;
    const { operationId, lane, pinVersion, approvalRevision } = own;
    const passId = newPassId();
    const cursor = createLaneCursor(records, lane, { operationId, lane, pinVersion, approvalRevision, passId });
    await pass.verify(STEP_CHECKS.refresh);
    pass.bytes = await signOrResume(pass, cursor, own);
    const outcomes = [];
    for (const stage of own.stages) {
      outcomes.push(await runStage(pass, cursor, stage));
      if (outcomes.at(-1).state !== 'acknowledged') break;
    }
    return { operationId, passId, outcomes };
  }

  async function runPass(request) {
    const own = snapshotRequest(request);
    const pass = createPass({ fence, checks, clock, stoppedCode }, own);
    try {
      await pass.verify(STEP_CHECKS.refresh);
      return await fence.run(own.operationId, (capability) => runUnderFence(pass, capability, own), own.capability);
    } finally {
      pass.end();
    }
  }

  return { runPass };
}
