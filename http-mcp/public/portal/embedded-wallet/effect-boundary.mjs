// The browser wallet's K0 pass; no production path loads this module yet.
// EB1–EB4 pre-checks authorize nothing after the wallet-fence wait. EB5r repeats them under the fence;
// the EB signer performs its final stop read, synchronous checks and inner signature in the same tick.
// EB6 saves private signed bytes by CAS. Each stage runs EB7, saves its -started intent (EB8), then
// receives a one-use transmitter for EB8f's final stop read, synchronous checks and same-tick egress.
// EB9 acknowledges only a fulfilled inner transmission; an invoked but unfinished/failed one is unknown.
// Requests become frozen intents before any adapter call. Raw store heads become empty, resumable or
// closed once. Resumption requires identical identity/bytes and a nonempty prefix from the next stage.
// Normal execution advances with the same transition rule. Started, unknown and final records close lanes.
// records.head(lane) -> {revision, signed, last}, with raw signed/newest records (absent on empty lanes).
// records.append(lane, expectedRevision, record) -> {revision}; persistence is P53b1b's responsibility.
// Authority/stop reads share 10,000 ms. Sign, send and record waits have no imposed deadline. The fence is
// held until every invoked inner signer and send settles; a hung inner call holds it until page closure.
import { EffectBoundaryRefusal, SYSTEM_CLOCK, refuse, requireFunctions } from './wallet-fence.mjs';

/** Aggregate time one pass may spend inside authority and stop reads. */
export const PASS_READ_DEADLINE_MS = 10_000;
const MAX_CAUSE_MESSAGE_LENGTH = 200;
const IDENTITY_KEYS = Object.freeze(['operationId', 'pinVersion', 'approvalRevision']);
const WORKFLOWS = new Map([['dispatch', ['dispatch']], ['confirm-broadcast', ['confirm', 'broadcast']]]);
const RESUME_TUPLES = [['dispatch'], ['confirm'], ['broadcast'], ['confirm', 'broadcast']];
const STAGES = [...new Set([...WORKFLOWS.values()].flat())];
const KINDS = new Set(['signed', 'signed-held', ...STAGES.flatMap((stage) => ['started', 'withheld', 'unknown', 'acknowledged'].map((suffix) => `${stage}-${suffix}`))]);
const nonemptyString = (value) => typeof value === 'string' && value !== '';
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, index) => byte === b[index]);

function runCheck(checks, name, ...args) {
  try { return checks[name](...args); } catch (cause) { throw refuse('eb_check_failed', cause); }
}
function enforce(answer) {
  if (answer !== true) throw nonemptyString(answer) ? refuse(answer) : refuse('eb_check_invalid', answer);
}
function describeCause(error) {
  let code = 'unknown', message = 'Unprintable cause';
  try { const value = error?.code; if (typeof value === 'string') code = value.slice(0, MAX_CAUSE_MESSAGE_LENGTH); } catch {}
  try { message = String(error?.message ?? error).slice(0, MAX_CAUSE_MESSAGE_LENGTH); } catch {}
  return { code, message };
}

// Only read time consumes the aggregate budget; late answers cannot authorize an effect.
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

// A single transition policy for both newly signed and resumed workflows.
function nextStage(workflow, last) {
  const stages = WORKFLOWS.get(workflow);
  if (!stages || !KINDS.has(last?.kind)) return undefined;
  const { kind, stage } = last;
  if (kind === 'signed') return stage === undefined ? stages[0] : undefined;
  if (kind === 'signed-held') return stages.includes(stage) ? stage : undefined;
  const withheld = stages.find((name) => kind === `${name}-withheld`);
  if (withheld !== undefined) return stage === undefined || stage === withheld ? withheld : undefined;
  if (workflow === 'confirm-broadcast' && kind === 'confirm-acknowledged' && stage === 'confirm') return 'broadcast';
  return undefined;
}

// Parse once, before any further await. Missing/invalid signed values never reach the resume policy.
function laneState(head) {
  const { revision, signed, last } = head ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('record store returned a malformed lane revision');
  if (revision === 0 && signed == null && last == null) return { state: 'empty', revision };
  const closed = { state: 'closed', revision };
  if (revision === 0 || signed?.kind !== 'signed') return closed;
  const { workflow, bytes } = signed;
  if (!WORKFLOWS.has(workflow) || !(bytes instanceof Uint8Array) || bytes.length === 0) return closed;
  const copied = Uint8Array.from(bytes);
  const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, signed[key]]));
  if (!Object.values(identity).every(nonemptyString)) return closed;
  const next = nextStage(workflow, last);
  return next === undefined ? closed : { state: 'resumable', revision, workflow, bytes: copied, identity: Object.freeze(identity), next };
}
function mayResume(state, own) {
  if (state.state !== 'resumable') return false;
  const remaining = WORKFLOWS.get(state.workflow).slice(WORKFLOWS.get(state.workflow).indexOf(state.next));
  return own.tuple.length > 0 && own.tuple.length <= remaining.length && own.tuple.every((name, i) => name === remaining[i])
    && IDENTITY_KEYS.every((key) => state.identity[key] === own.identity[key]) && sameBytes(own.retained, state.bytes);
}

const STEP_CHECKS = Object.freeze({
  refresh: ['admission', 'stop', 'approval', 'authority', 'binding'],
  beforeIntent: ['admission', 'stop', 'authority', 'binding'],
  signerTail: ['owner', 'admission', 'approval', 'binding'],
  sendTail: ['owner', 'admission', 'binding'],
});
const STEPS = new WeakMap();
function createPass({ fence, checks, clock, stoppedCode }, { operationId, approvalRevision }) {
  const binding = { digest: runCheck(checks, 'connectionDigest'), generation: fence.connectionGeneration };
  const readWithinBudget = createReadBudget(clock, PASS_READ_DEADLINE_MS);
  let live = true, current = null;
  const effects = [];
  const pass = {
    capability: null, bytes: undefined,
    // Inner signer and send calls are owned by the pass: it waits for each one before the fence is released.
    track(effect) { effects.push(effect.then(() => {}, () => {})); return effect; },
    drain: () => Promise.all(effects),
    owner() { if (!live || !fence.owns(pass.capability, operationId)) throw refuse('tp1_fence_not_owned'); },
    admission: () => enforce(runCheck(checks, 'admission')),
    approval: () => enforce(runCheck(checks, 'approval', approvalRevision)),
    binding() {
      if (runCheck(checks, 'connectionDigest') !== binding.digest || fence.connectionGeneration !== binding.generation) throw refuse('tp1_local_binding_changed');
    },
    async stop() {
      let stopped;
      try { stopped = await readWithinBudget(() => checks.stopped(), 'stop_check_timeout'); }
      catch (error) { throw error instanceof EffectBoundaryRefusal ? error : refuse('stop_check_failed', error); }
      if (stopped === true) throw refuse(stoppedCode);
      if (stopped !== false) throw refuse('stop_check_invalid', stopped);
    },
    async authority() {
      try { await readWithinBudget(() => checks.readAuthority(), 'tp1_authority_timeout'); }
      catch (error) {
        if (error instanceof EffectBoundaryRefusal) throw error;
        let code;
        try { code = error?.code; } catch {}
        throw refuse(typeof code === 'string' ? code : 'tp1_authority_failed', error);
      }
    },
    async verify(names) { for (const name of names) await pass[name](); },
    verifyNow(names) { for (const name of names) pass[name](); },
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
function liveStep(handle, kind) {
  const step = STEPS.get(handle);
  if (step?.kind !== kind || !step.pass.isLive(step)) throw refuse('tp1_fence_not_owned');
  step.pass.owner();
  return step;
}
function claimStep(handle, kind, repeatedCode) {
  const step = liveStep(handle, kind);
  if (step.state !== 'open') throw refuse(repeatedCode);
  return step;
}

/** Wraps the inner signer with EB5r's final stop read and same-tick checks; requires a live one-use sign handle. */
export function ebSign(innerSign, handle) {
  return async (...args) => {
    await liveStep(handle, 'sign').pass.stop();
    const step = claimStep(handle, 'sign', 'eb_signer_repeated');
    step.pass.verifyNow(STEP_CHECKS.signerTail);
    step.state = 'consumed';
    const signed = await step.pass.track((async () => innerSign(...args))());
    if (step.pass.isLive(step) && signed instanceof Uint8Array) step.signed = Uint8Array.from(signed);
    return signed;
  };
}

/** Wraps one inner send with EB8f, byte equality and private copies; rejects foreign, stale or consumed handles. */
export function ebTransmit(innerSend, handle) {
  return async (bytes, ...rest) => {
    const offered = bytes instanceof Uint8Array ? Uint8Array.from(bytes) : undefined;
    await liveStep(handle, 'send').pass.stop();
    const step = claimStep(handle, 'send', 'eb_transmission_repeated');
    if (!sameBytes(offered, step.pass.bytes)) throw refuse('eb_bytes_mismatch');
    step.pass.verifyNow(STEP_CHECKS.sendTail);
    step.state = 'consumed';
    step.transmission = { status: 'pending' };
    const sending = step.pass.track((async () => innerSend(step.pass.copyBytes(), ...rest))());
    sending.then(() => { step.transmission = { status: 'fulfilled' }; }, (error) => { step.transmission = { status: 'failed', error }; });
    return sending;
  };
}

function createLaneCursor(records, lane, identity) {
  let head, revision;
  const guarded = async (work) => { try { return await work(); } catch (cause) { throw refuse('eb_persist_failed', cause); } };
  const readHead = async () => {
    if (head === undefined) { head = laneState(await records.head(lane)); revision = head.revision; }
    return head;
  };
  return {
    head: () => guarded(readHead),
    append: (fields) => guarded(async () => {
      await readHead();
      const next = await records.append(lane, revision, { ...identity, ...fields });
      if (!Number.isSafeInteger(next?.revision) || next.revision !== revision + 1) throw new TypeError('record store returned an out-of-sequence revision');
      revision = next.revision;
    }),
  };
}
async function signOrResume(pass, cursor, own) {
  const state = await cursor.head();
  if (own.retained !== undefined) {
    if (!mayResume(state, own)) throw refuse('eb_resume_not_allowed');
    await pass.stop();
    pass.verifyNow(STEP_CHECKS.signerTail);
    return state;
  }
  if (state.state !== 'empty') throw refuse('eb_lane_not_empty');
  const step = pass.openStep('sign');
  try { await own.sign(step.handle); } finally { pass.closeStep(); }
  if (step.state === 'open') throw refuse('eb_signer_bypassed');
  if (!(step.signed?.length > 0)) throw refuse('eb_signed_bytes_invalid');
  await cursor.append({ kind: 'signed', workflow: own.workflow, bytes: Uint8Array.from(step.signed) });
  return { workflow: own.workflow, bytes: step.signed, next: nextStage(own.workflow, { kind: 'signed' }) };
}

// Pure five-row policy: consuming a handle can never produce a withheld outcome.
function stageOutcome(invoked, settled, transmission) {
  if ('error' in settled) return { state: invoked ? 'unknown' : 'withheld', cause: settled.error };
  if (!invoked) return { state: 'unknown', cause: refuse('eb_transmitter_bypassed') };
  if (transmission.status !== 'fulfilled') return { state: 'unknown', cause: transmission.status === 'failed' ? transmission.error : refuse('eb_transmission_unfinished') };
  return { state: 'acknowledged', result: settled.result };
}
async function saveRefusal(cursor, fields, original) {
  try { await cursor.append({ ...fields, cause: describeCause(original) }); }
  catch (persistence) { throw refuse('eb_persist_failed', new AggregateError([original, persistence], 'refusal record failed')); }
}
async function runStage(pass, cursor, { name, send }) {
  try { await pass.verify(STEP_CHECKS.beforeIntent); }
  catch (error) { await saveRefusal(cursor, { kind: 'signed-held', stage: name }, error); throw error; }
  await cursor.append({ kind: `${name}-started`, stage: name });
  const step = pass.openStep('send');
  let settled;
  try { settled = { result: await send(step.handle, pass.copyBytes()) }; }
  catch (error) { settled = { error }; }
  finally { pass.closeStep(); }
  const outcome = stageOutcome(step.state === 'consumed', settled, step.transmission);
  if (outcome.state === 'withheld') {
    await saveRefusal(cursor, { kind: `${name}-withheld`, stage: name }, outcome.cause);
    throw outcome.cause;
  }
  await cursor.append({ kind: `${name}-${outcome.state}`, stage: name, ...(outcome.state === 'unknown' ? { cause: describeCause(outcome.cause) } : {}) });
  return { stage: name, ...outcome };
}

// Capture each caller value once, including identity, descriptors and retained bytes. A supplied capability is
// refused here, before any adapter call: a pass must acquire and keep its own fence hold, and a pass running under
// someone else's hold could outlive it.
function snapshotRequest(request) {
  const { operationId, lane, pinVersion, approvalRevision, capability, sign, retained, stages } = request ?? {};
  if (capability !== undefined) throw refuse('tp1_fence_not_owned');
  const identity = Object.freeze({ operationId, pinVersion, approvalRevision });
  for (const [key, value] of [...Object.entries(identity), ['lane', lane]]) if (!nonemptyString(value)) throw new TypeError(`${key} must be a non-empty string`);
  if ((sign === undefined) === (retained === undefined)) throw new TypeError('exactly one of sign and retained is required');
  if (sign !== undefined && typeof sign !== 'function') throw new TypeError('request.sign must be a function');
  const retainedBytes = retained?.bytes;
  if (retained !== undefined && !(retainedBytes instanceof Uint8Array && retainedBytes.length > 0)) throw new TypeError('retained.bytes must be non-empty bytes');
  const steps = Array.from(Array.isArray(stages) ? stages : [], (stage) => Object.freeze({ name: stage?.name, send: stage?.send }));
  for (const { send } of steps) if (typeof send !== 'function') throw new TypeError('stage.send must be a function');
  const names = steps.map(({ name }) => name);
  const tuple = (sign === undefined ? RESUME_TUPLES : [...WORKFLOWS.values()]).find((candidate) => candidate.length === names.length && candidate.every((name, i) => name === names[i]));
  if (tuple === undefined) throw new TypeError('stages must be a closed workflow or resume tuple');
  const workflow = [...WORKFLOWS.keys()].find((name) => WORKFLOWS.get(name) === tuple);
  return Object.freeze({ identity, lane, sign, workflow, tuple: Object.freeze([...tuple]), retained: retained === undefined ? undefined : Uint8Array.from(retainedBytes), stages: Object.freeze(steps) });
}

/**
 * Creates an unwired wallet pass runner with injected fence, checks and record store. Check methods return true
 * or a refusal code; stopped returns boolean, readAuthority resolves for a current binding. Approval receives the
 * captured revision. runPass requires nonempty string operationId/pinVersion/approvalRevision/lane and either
 * sign or retained.bytes plus closed stages; resolves {operationId, passId, outcomes}. Invalid requests throw
 * TypeError before adapter calls; refusal/persistence failures reject with EffectBoundaryRefusal and causes.
 * Every pass acquires its own fence hold: a request carrying a capability is refused tp1_fence_not_owned first.
 */
export function createEffectBoundary({ fence, checks, records, clock = SYSTEM_CLOCK, newPassId = () => globalThis.crypto.randomUUID(), stoppedCode = 'writes_stopped' }) {
  requireFunctions('fence', fence, ['run', 'owns']);
  requireFunctions('checks', checks, ['admission', 'approval', 'connectionDigest', 'stopped', 'readAuthority']);
  requireFunctions('records', records, ['head', 'append']);
  // The fence callback ends only after every inner signer and send the pass let start has settled.
  async function runUnderFence(pass, capability, own) {
    pass.capability = capability;
    try { return await runSteps(pass, own); } finally { pass.end(); await pass.drain(); }
  }
  async function runSteps(pass, own) {
    const { operationId } = own.identity;
    const passId = newPassId();
    const cursor = createLaneCursor(records, own.lane, { ...own.identity, lane: own.lane, passId });
    await pass.verify(STEP_CHECKS.refresh);
    const state = await signOrResume(pass, cursor, own);
    pass.bytes = state.bytes;
    const outcomes = [];
    for (const stage of own.stages) {
      if (stage.name !== state.next) throw refuse('eb_resume_not_allowed');
      const outcome = await runStage(pass, cursor, stage);
      outcomes.push(outcome);
      if (outcome.state !== 'acknowledged') break;
      state.next = nextStage(state.workflow, { kind: `${stage.name}-acknowledged`, stage: stage.name });
    }
    return { operationId, passId, outcomes };
  }
  async function runPass(request) {
    const own = snapshotRequest(request);
    const pass = createPass({ fence, checks, clock, stoppedCode }, own.identity);
    try {
      await pass.verify(STEP_CHECKS.refresh);
      return await fence.run(own.identity.operationId, (capability) => runUnderFence(pass, capability, own));
    } finally { pass.end(); }
  }
  return { runPass };
}
