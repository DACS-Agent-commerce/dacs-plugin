// K0 on the browser's effect boundary (public/portal/embedded-wallet/effect-boundary.mjs):
// the actor fence, the aggregate read deadline, EB5r/EB8f final checks and the EB signer/transmitter.
// Evidence: instrumented in-process doubles (controllable clock, Web Locks manager, in-memory record store
// honouring the store contract). No real Chrome and no real IndexedDB; the durable store is P53b1b's.
// K0-F10 is the test for the connection replacement below. K0-B12, F15, F19 and F7's compensation branch
// do not apply to a browser lane (no packed archive, no K1 revision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffectBoundary, ebSign, ebTransmit, PASS_READ_DEADLINE_MS } from '../../public/portal/embedded-wallet/effect-boundary.mjs';
import { createWorld, createMemoryRecords } from '../helpers/effect-boundary-doubles.mjs';
import { createGate, settle } from '../helpers/wallet-fence-doubles.mjs';

const READ_DEADLINE_MS = PASS_READ_DEADLINE_MS;
const FENCE_TIMEOUT_MS = 10_000;

function assertRefusal(error, code) {
  assert.equal(error?.name, 'EffectBoundaryRefusal', `expected a refusal, got ${error}`);
  assert.equal(error.code, code);
}

// Stalls the nth read of `kind` until the clock passes the deadline; `answerLate` then lets it resolve validly.
async function runWithStalledRead(world, kind, call, { answerLate }) {
  const late = createGate();
  world.on(kind, call, () => late.promise);
  const pending = world.settled(world.runPass());
  await settle();
  world.clock.advance(READ_DEADLINE_MS + (answerLate ? 1 : 0));
  late.open();
  return pending;
}

const isPending = async (promise) => (await Promise.race([promise.then(() => 'settled'), settle().then(() => 'pending')])) === 'pending';

// Two tabs of one wallet sharing the lock manager, the clock and the record store.
function twoTabs() {
  const first = createWorld({ operationId: 'op-a', lane: 'lane-a' });
  const second = createWorld({ operationId: 'op-b', lane: 'lane-b', clock: first.clock, locks: first.locks, records: first.records, events: first.events });
  return [first, second];
}

// Makes the tab's inner transport answer only when the returned handle is resolved or rejected.
function pendingTransport(world) {
  const transmission = {};
  world.behavior.transport = () => new Promise((resolve, reject) => { Object.assign(transmission, { resolve, reject }); });
  return transmission;
}

// A send stage that starts the wrapped transmission and returns (or throws) without waiting for it.
const earlySend = (world, { thenThrow } = {}) => async (armed, bytes) => {
  world.send(armed, bytes).catch(() => undefined);
  await settle();
  if (thenThrow) throw thenThrow;
  return { queued: true };
};

test('K0-B1 to K0-B11 on the browser boundary: authority and stop deadlines, a late fence grant, nested reuse, a non-owner release, overlapping purchases and reply bounds', async (t) => {
  await t.test('K0-B1 an authority reader rejecting with E refuses with E as the cause; signer 0, transport 0', async () => {
    const world = createWorld();
    const failure = new Error('authority node refused');
    world.on('authority', 1, () => { throw failure; });
    const { error } = await world.settled(world.runPass());
    assertRefusal(error, 'tp1_authority_failed');
    assert.equal(error.cause, failure);
    assert.deepEqual([world.counts.signer, world.counts.transport], [0, 0]);
  });

  await t.test('K0-B2 an authority reader that never answers refuses tp1_authority_timeout at 10,000 ms; signer 0', async () => {
    const world = createWorld();
    world.on('authority', 1, () => new Promise(() => {}));
    const pending = world.settled(world.runPass());
    await settle();
    world.clock.advance(READ_DEADLINE_MS - 1);
    assert.ok(await isPending(pending), 'still waiting one millisecond before the deadline');
    world.clock.advance(1);
    assertRefusal((await pending).error, 'tp1_authority_timeout');
    assert.equal(world.counts.signer, 0);
  });

  await t.test('K0-B3 an authority result that resolves validly at 10,001 ms is ignored; signer 0', async () => {
    const world = createWorld();
    const { error } = await runWithStalledRead(world, 'authority', 1, { answerLate: true });
    assertRefusal(error, 'tp1_authority_timeout');
    assert.equal(world.counts.signer, 0);
    assert.ok(await world.fenceIsFree());
  });

  await t.test('K0-B4 a stop callback that rejects, stalls or answers the string "false" counts as stopped with its cause', async () => {
    const rejecting = createWorld();
    const failure = new Error('stop route down');
    rejecting.on('stop', 1, () => { throw failure; });
    const failed = (await rejecting.settled(rejecting.runPass())).error;
    assertRefusal(failed, 'stop_check_failed');
    assert.equal(failed.cause, failure);

    const stalled = createWorld();
    assertRefusal((await runWithStalledRead(stalled, 'stop', 1, { answerLate: false })).error, 'stop_check_timeout');

    const invalid = createWorld();
    invalid.state.stopAnswer = 'false';
    const rejected = (await invalid.settled(invalid.runPass())).error;
    assertRefusal(rejected, 'stop_check_invalid');
    assert.equal(rejected.cause, 'false');
    for (const world of [rejecting, stalled, invalid]) assert.equal(world.counts.signer, 0);
  });

  await t.test('K0-B5 a fence grant that arrives after tp1_fence_timeout is released at once and the next waiter acquires', async () => {
    const world = createWorld();
    world.locks.ignoreAbort = true;
    const holder = world.holdFence();
    await settle();
    const pending = world.settled(world.runPass());
    await settle();
    world.clock.advance(FENCE_TIMEOUT_MS);
    const { error } = await pending;
    assertRefusal(error, 'tp1_fence_timeout');
    assert.ok(error.cause, 'the abort reason is kept as the cause');
    holder.release();
    await Promise.all(world.background);
    assert.equal(world.counts.signer, 0);
    assert.ok(await world.fenceIsFree(), 'the late grant did not keep the lock');
  });

  await t.test('K0-B6 a nested step of the same operation reuses the capability: one acquisition, no deadlock', async () => {
    const world = createWorld();
    const nested = [];
    const { error } = await world.settled(world.runPass({
      sign: async (armed) => {
        const bytes = await world.sign(armed);
        nested.push(await world.settled(world.boundary.runPass(world.request({ lane: 'lane-nested', capability: armed.capability }))));
        return bytes;
      },
    }));
    assert.equal(error, undefined);
    assert.equal(nested[0].error, undefined);
    assert.equal(world.counts.lockRequests, 1);
    assert.equal(world.counts.signer, 2);
    assert.deepEqual(world.records.kinds('lane-nested'), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  });

  await t.test('K0-B7 another operation presenting the capability is refused tp1_fence_not_owned; signer 0', async () => {
    const world = createWorld();
    const foreign = [];
    await world.runPass({
      sign: async (armed) => {
        foreign.push(await world.settled(world.boundary.runPass(world.request({ operationId: 'op-2', capability: armed.capability }))));
        return world.sign(armed);
      },
    });
    assertRefusal(foreign[0].error, 'tp1_fence_not_owned');
    assert.equal(world.counts.signer, 1, 'only the owner signed');
  });

  await t.test('K0-B9 two overlapping purchases on one actor never interleave sign-to-dispatch sections', async () => {
    const world = createWorld();
    const gate = createGate();
    world.behavior.transport = () => gate.promise;
    const first = world.settled(world.runPass());
    await settle();
    const second = world.settled(world.runPass({ operationId: 'op-2', lane: 'lane-2' }));
    await settle();
    assert.equal(world.counts.signer, 1, 'the second purchase has not signed while the first is in flight');
    gate.open();
    world.behavior.transport = async () => ({ accepted: true });
    assert.equal((await first).error, undefined);
    assert.equal((await second).error, undefined);
    assert.deepEqual(world.events.filter((event) => event.startsWith('inner-')), ['inner-sign', 'inner-send', 'inner-sign', 'inner-send']);
  });

  await t.test('K0-B10 an authority reply over its byte or list bound is the reader\'s refusal and its cause is kept', async () => {
    for (const code of ['authority_reply_too_large', 'authority_list_too_large']) {
      const world = createWorld();
      const overBound = Object.assign(new RangeError(code), { code });
      world.on('authority', 1, () => { throw overBound; });
      const { error } = await world.settled(world.runPass());
      assertRefusal(error, code);
      assert.equal(error.cause, overBound);
      assert.equal(world.counts.signer, 0);
    }
  });

  await t.test('K0-B11 authority reads during a payment make no signer call and no fence acquisition', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass());
    assert.equal(error, undefined, 'the reader throws if it touches the signer or the fence');
    assert.equal(world.counts.authority, 3);
    assert.equal(world.counts.lockRequests, 1);
  });
});

const barrierRows = [
  { name: 'K0-F1 a fenced replacement queued before the pass runs first; EB5r refuses tp1_local_binding_changed', queueBefore: (w) => w.background.push(w.fence.replaceConnection(async () => { w.state.digest = 'digest-2'; })), code: 'tp1_local_binding_changed', signer: 0, kinds: [] },
  { name: 'K0-F2 a reconnect that bypasses the fence while waiting refuses tp1_local_binding_changed', waiting: (w) => { w.state.digest = 'digest-2'; }, code: 'tp1_local_binding_changed', signer: 0, kinds: [] },
  { name: 'K0-F3 KILL while waiting refuses writes_stopped', waiting: (w) => { w.state.killed = true; }, code: 'writes_stopped', signer: 0, kinds: [] },
  { name: 'K0-F3 KILL while waiting on a seller lane refuses seller_stopped', worldOptions: { stoppedCode: 'seller_stopped' }, waiting: (w) => { w.state.killed = true; }, code: 'seller_stopped', signer: 0, kinds: [] },
  { name: 'K0-F3 the guard flipping off while waiting refuses kit_operation_guard_off', waiting: (w) => { w.state.admission = 'kit_operation_guard_off'; }, code: 'kit_operation_guard_off', signer: 0, kinds: [] },
  { name: 'K0-F3 the hold flipping off while waiting refuses profile_not_admitted', waiting: (w) => { w.state.admission = 'profile_not_admitted'; }, code: 'profile_not_admitted', signer: 0, kinds: [] },
  { name: 'K0-F4 a reconnect inside EB5r\'s authority read is refused by the synchronous check after it', arrange: (w) => w.on('authority', 2, () => { w.state.digest = 'digest-2'; }), code: 'tp1_local_binding_changed', signer: 0, kinds: [] },
  { name: 'K0-F5 a reconnect inside EB7\'s authority read keeps signed-held{tp1_local_binding_changed}; signer 1', arrange: (w) => w.on('authority', 3, () => { w.state.digest = 'digest-2'; }), code: 'tp1_local_binding_changed', signer: 1, kinds: ['signed', 'signed-held'], lastCause: 'tp1_local_binding_changed' },
  { name: 'K0-F6 KILL inside EB7\'s authority read is refused at EB8f: dispatch-withheld{writes_stopped}', arrange: (w) => w.on('authority', 3, () => { w.state.killed = true; }), code: 'writes_stopped', signer: 1, kinds: ['signed', 'dispatch-started', 'dispatch-withheld'], lastCause: 'writes_stopped' },
  { name: 'K0-F7 KILL inside the dispatch-intent persistence gives dispatch-withheld{writes_stopped}', arrange: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.killed = true; }), code: 'writes_stopped', signer: 1, kinds: ['signed', 'dispatch-started', 'dispatch-withheld'], lastCause: 'writes_stopped' },
  { name: 'K0-F7 a reconnect inside the dispatch-intent persistence gives dispatch-withheld{tp1_local_binding_changed}', arrange: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.digest = 'digest-2'; }), code: 'tp1_local_binding_changed', signer: 1, kinds: ['signed', 'dispatch-started', 'dispatch-withheld'], lastCause: 'tp1_local_binding_changed' },
  { name: 'K0-F7 the guard flipping off inside the dispatch-intent persistence gives dispatch-withheld with the EB1 code', arrange: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.admission = 'kit_operation_guard_off'; }), code: 'kit_operation_guard_off', signer: 1, kinds: ['signed', 'dispatch-started', 'dispatch-withheld'], lastCause: 'kit_operation_guard_off' },
  {
    name: 'K0-F9 a failed dispatch-withheld write after a refused EB8f leaves dispatch-started: eb_persist_failed, transport 0',
    arrange: (w) => {
      w.records.beforeCommit.set('dispatch-started', () => { w.state.killed = true; });
      w.records.failures.set('dispatch-withheld', new Error('EIO'));
    },
    code: 'eb_persist_failed', signer: 1, kinds: ['signed', 'dispatch-started'],
  },
  { name: 'a persistence failure on the signed bytes sends nothing: eb_persist_failed with the cause', arrange: (w) => w.records.failures.set('signed', Object.assign(new Error('write failed'), { code: 'EIO' })), code: 'eb_persist_failed', signer: 1, kinds: [], causeCode: 'EIO' },
  { name: 'a failed dispatch-acknowledged write after the transmission is eb_persist_failed and leaves dispatch-started', arrange: (w) => w.records.failures.set('dispatch-acknowledged', new Error('EIO')), code: 'eb_persist_failed', signer: 1, transport: 1, kinds: ['signed', 'dispatch-started'] },
  { name: 'an admission check that answers something other than true or a code refuses eb_check_invalid', arrange: (w) => { w.state.admission = 1; }, code: 'eb_check_invalid', signer: 0, kinds: [] },
];

// Every read before and after the signature, stalled past the deadline with a valid late answer.
const stalledReads = [
  { kind: 'stop', call: 1, code: 'stop_check_timeout', signer: 0, kinds: [] },
  { kind: 'authority', call: 1, code: 'tp1_authority_timeout', signer: 0, kinds: [] },
  { kind: 'stop', call: 2, code: 'stop_check_timeout', signer: 0, kinds: [] },
  { kind: 'authority', call: 2, code: 'tp1_authority_timeout', signer: 0, kinds: [] },
  { kind: 'stop', call: 3, code: 'stop_check_timeout', signer: 0, kinds: [] },
  { kind: 'stop', call: 4, code: 'stop_check_timeout', signer: 1, kinds: ['signed', 'signed-held'] },
  { kind: 'authority', call: 3, code: 'tp1_authority_timeout', signer: 1, kinds: ['signed', 'signed-held'] },
  { kind: 'stop', call: 5, code: 'stop_check_timeout', signer: 1, kinds: ['signed', 'dispatch-started', 'dispatch-withheld'] },
];

async function runBarrierRow(row) {
  const world = createWorld(row.worldOptions);
  row.arrange?.(world);
  let outcome;
  if (row.waiting || row.queueBefore) {
    const holder = world.holdFence();
    await settle();
    row.queueBefore?.(world);
    const pending = world.settled(world.runPass());
    await settle();
    row.waiting?.(world);
    holder.release();
    outcome = await pending;
  } else if (row.kind) {
    outcome = await runWithStalledRead(world, row.kind, row.call, { answerLate: true });
  } else {
    outcome = await world.settled(world.runPass());
  }
  await Promise.all(world.background);
  assertRefusal(outcome.error, row.code);
  assert.equal(world.counts.signer, row.signer, 'signer calls');
  assert.equal(world.counts.transport, row.transport ?? 0, 'transport calls');
  assert.deepEqual(world.records.kinds('lane-1'), row.kinds);
  if (row.lastCause) assert.equal(world.records.records('lane-1').at(-1).cause.code, row.lastCause);
  if (row.causeCode) assert.equal(outcome.error.cause.code, row.causeCode);
  assert.ok(await world.fenceIsFree(), 'the fence is released on this path');
}

test('K0-F1 to K0-F11 barriers refuse or withhold with the listed signer and transport counts', async (t) => {
  for (const row of barrierRows) {
    await t.test(row.name, () => runBarrierRow(row));
  }
  for (const row of stalledReads) {
    await t.test(`K0-F11 ${row.kind} read ${row.call} resolving after the pass deadline is ignored: ${row.code}`, () => runBarrierRow(row));
  }

  await t.test('a check that throws refuses eb_check_failed with the cause', async () => {
    const world = createWorld();
    const failure = new Error('guard unreadable');
    Object.defineProperty(world.state, 'admission', { get() { throw failure; } });
    const { error } = await world.settled(world.runPass());
    assertRefusal(error, 'eb_check_failed');
    assert.equal(error.cause, failure);
    assert.equal(world.counts.signer, 0);
  });

  await t.test('a pass succeeds: the signed bytes are persisted first and the transport receives exactly those bytes', async () => {
    const world = createWorld();
    const { value, error } = await world.settled(world.runPass());
    assert.equal(error, undefined);
    assert.deepEqual(value.outcomes, [{ stage: 'dispatch', state: 'acknowledged', result: { accepted: true } }]);
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
    const persisted = world.records.records('lane-1')[0];
    assert.deepEqual([persisted.operationId, persisted.lane, persisted.pinVersion, persisted.approvalRevision], ['op-1', 'lane-1', 'pin-1', 'approval-1']);
    assert.deepEqual([...world.sent[0]], [...persisted.bytes]);
    assert.ok(await world.fenceIsFree());
  });

  await t.test('K0-F9 EB9 a transport that throws after the transmission records dispatch-unknown and is not a refusal', async () => {
    const world = createWorld();
    const lost = new Error('socket reset');
    world.behavior.transport = async () => { throw lost; };
    const { value, error } = await world.settled(world.runPass());
    assert.equal(error, undefined);
    assert.equal(value.outcomes[0].state, 'unknown');
    assert.equal(value.outcomes[0].cause, lost);
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-unknown']);
    assert.equal(world.records.records('lane-1').at(-1).cause.message, 'socket reset');
    assert.equal(world.counts.transport, 1);
  });

  await t.test('confirmation and broadcast are separate stages and an unknown confirmation never advances to broadcast', async () => {
    const stages = (world) => [{ name: 'confirm', send: world.send }, { name: 'broadcast', send: world.send }];
    const acknowledged = createWorld();
    const both = await acknowledged.runPass({ stages: stages(acknowledged) });
    assert.deepEqual(both.outcomes.map((outcome) => `${outcome.stage}:${outcome.state}`), ['confirm:acknowledged', 'broadcast:acknowledged']);
    assert.deepEqual(acknowledged.records.kinds('lane-1'), ['signed', 'confirm-started', 'confirm-acknowledged', 'broadcast-started', 'broadcast-acknowledged']);

    const unknown = createWorld();
    unknown.behavior.transport = async () => { throw new Error('answer lost'); };
    const halted = await unknown.runPass({ stages: stages(unknown) });
    assert.deepEqual(halted.outcomes.map((outcome) => `${outcome.stage}:${outcome.state}`), ['confirm:unknown']);
    assert.deepEqual(unknown.records.kinds('lane-1'), ['signed', 'confirm-started', 'confirm-unknown']);
    assert.equal(unknown.counts.transport, 1);
  });

  await t.test('K0-F8 after a withheld pass and a restart, a new explicit request transmits the retained bytes once', async () => {
    const first = createWorld();
    first.records.beforeCommit.set('dispatch-started', () => { first.state.killed = true; });
    assertRefusal((await first.settled(first.runPass())).error, 'writes_stopped');
    first.records.beforeCommit.clear();
    assert.equal(first.counts.transport, 0, 'no automatic transmission');

    const restarted = createWorld({ records: first.records });
    const retained = first.records.records('lane-1')[0];
    const resumed = await restarted.settled(restarted.runPass({ retained: { bytes: retained.bytes }, sign: undefined }));
    assert.equal(resumed.error, undefined);
    assert.equal(restarted.counts.signer, 0, 'the retained bytes are not signed again');
    assert.equal(restarted.counts.transport, 1);
    assert.deepEqual([...restarted.sent[0]], [...retained.bytes]);
    assert.deepEqual(first.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-withheld', 'dispatch-started', 'dispatch-acknowledged']);
  });
});

const finalReadBarriers = [
  { name: 'K0-F13 KILL inside the final authority read is refused by the final stop check', kind: 'authority', call: 2, change: (w) => { w.state.killed = true; }, code: 'writes_stopped', stops: 3 },
  { name: 'K0-F14 the guard flipping off inside the final authority read is refused by the synchronous recheck', kind: 'authority', call: 2, change: (w) => { w.state.admission = 'kit_operation_guard_off'; }, code: 'kit_operation_guard_off', stops: 3 },
  { name: 'K0-F14 the hold flipping off inside the final stop read is refused by the synchronous recheck', kind: 'stop', call: 3, change: (w) => { w.state.admission = 'profile_not_admitted'; }, code: 'profile_not_admitted', stops: 3 },
  { name: 'K0-F16 a reconnect inside the final stop read is refused tp1_local_binding_changed', kind: 'stop', call: 3, change: (w) => { w.state.digest = 'digest-2'; }, code: 'tp1_local_binding_changed', stops: 3 },
  { name: 'K0-F17 the approval consumed inside the final authority read refuses with the EB3 code', kind: 'authority', call: 2, change: (w) => { w.state.approval = 'write-fee-cap'; }, code: 'write-fee-cap', stops: 3 },
  { name: 'K0-F17 the approval consumed inside the final stop read refuses with the EB3 code', kind: 'stop', call: 3, change: (w) => { w.state.approval = 'above the approved total'; }, code: 'above the approved total', stops: 3 },
];

test('K0-F13, F14, F16 and F17 inside the final authority read and final stop read refuse with signer calls 0', async (t) => {
  for (const row of finalReadBarriers) {
    await t.test(row.name, async () => {
      const world = createWorld();
      world.on(row.kind, row.call, () => row.change(world));
      const { error } = await world.settled(world.runPass());
      assertRefusal(error, row.code);
      assert.deepEqual([world.counts.signer, world.counts.transport, world.counts.stop], [0, 0, row.stops]);
      assert.deepEqual(world.records.kinds('lane-1'), []);
      assert.ok(await world.fenceIsFree());
    });
  }
});

test('two tabs sharing one wallet never interleave sign-to-dispatch sections, and a wait past 10,000 ms refuses tp1_fence_timeout', async () => {
  const tabA = createWorld({ operationId: 'op-a', lane: 'lane-a' });
  const tabB = createWorld({ operationId: 'op-b', lane: 'lane-b', clock: tabA.clock, locks: tabA.locks, records: tabA.records, events: tabA.events });
  const tabC = createWorld({ operationId: 'op-c', lane: 'lane-c', clock: tabA.clock, locks: tabA.locks, records: tabA.records, events: tabA.events });
  const dispatching = createGate();
  tabA.behavior.transport = () => dispatching.promise;

  const purchaseA = tabA.settled(tabA.runPass());
  await settle();
  const purchaseB = tabB.settled(tabB.runPass());
  const purchaseC = tabC.settled(tabC.runPass());
  await settle();
  assert.deepEqual(tabA.events.filter((event) => event.endsWith(':sign') || event.endsWith(':send')), ['op-a:sign', 'op-a:send'], 'only the first tab is inside its section');

  tabA.clock.advance(FENCE_TIMEOUT_MS);
  const [timedOutB, timedOutC] = [await purchaseB, await purchaseC];
  for (const { error } of [timedOutB, timedOutC]) {
    assertRefusal(error, 'tp1_fence_timeout');
    assert.ok(error.cause, 'the timeout cause is kept');
  }
  assert.deepEqual([tabB.counts.signer, tabC.counts.signer], [0, 0]);

  dispatching.open();
  assert.equal((await purchaseA).error, undefined);
  const later = await tabB.settled(tabB.runPass({ operationId: 'op-b2', lane: 'lane-b2' }));
  assert.equal(later.error, undefined, 'a timed-out wait leaves the fence usable');
  assert.deepEqual(tabA.events.filter((event) => event.endsWith(':sign') || event.endsWith(':send')), ['op-a:sign', 'op-a:send', 'op-b:sign', 'op-b:send']);
});

test('a connection replacement takes the fence and bumps connectionGeneration, and a pass that sees a new generation refuses tp1_local_binding_changed', async (t) => {
  await t.test('K0-F10 a replacement requested while a pass holds the fence waits; the pass completes on the bound connection', async () => {
    const world = createWorld();
    const dispatching = createGate();
    world.behavior.transport = () => dispatching.promise;
    const pass = world.settled(world.runPass());
    await settle();
    const replacement = world.fence.replaceConnection(async () => { world.state.digest = 'digest-2'; });
    await settle();
    assert.deepEqual([world.fence.connectionGeneration, world.state.digest], [0, 'digest-1'], 'the replacement waits for the pass');
    dispatching.open();
    assert.equal((await pass).error, undefined);
    await replacement;
    assert.equal(world.fence.connectionGeneration, 1);
    world.behavior.transport = async () => ({ accepted: true });
    const next = await world.settled(world.runPass({ operationId: 'op-2', lane: 'lane-2' }));
    assert.equal(next.error, undefined, 'the next pass binds to the new connection');
  });

  await t.test('a pass queued behind a replacement refuses on the generation alone, with the digest unchanged', async () => {
    const world = createWorld();
    const holder = world.holdFence();
    await settle();
    world.background.push(world.fence.replaceConnection(async () => {}));
    const pending = world.settled(world.runPass());
    await settle();
    holder.release();
    assertRefusal((await pending).error, 'tp1_local_binding_changed');
    await Promise.all(world.background);
    assert.equal(world.counts.signer, 0);
  });


});

test('the EB signer and EB transmitter run the EB5r and EB8f tails immediately before the inner call they wrap, and refuse tp1_fence_not_owned outside the pass that armed them', async (t) => {
  await t.test('the signer tail is stop read, admission, approval, digest and generation, then the inner signer in the same tick', async () => {
    const world = createWorld();
    await world.runPass();
    const at = world.events.indexOf('inner-sign');
    assert.deepEqual(world.events.slice(at - 4, at + 1), ['stop-read', 'admission', 'approval', 'digest', 'inner-sign']);
  });

  await t.test('the transmitter tail is stop read, admission and digest, then the inner send in the same tick', async () => {
    const world = createWorld();
    await world.runPass();
    const at = world.events.indexOf('inner-send');
    assert.deepEqual(world.events.slice(at - 3, at + 1), ['stop-read', 'admission', 'digest', 'inner-send']);
  });

  await t.test('an EB signer or transmitter used after its pass, or while another operation holds the fence, is refused tp1_fence_not_owned', async () => {
    const world = createWorld();
    const armedPasses = [];
    await world.runPass({
      sign: (armed) => { armedPasses.push(armed); return world.sign(armed); },
      stages: [{ name: 'dispatch', send: (armed, bytes) => { armedPasses.push(armed); return world.send(armed, bytes); } }],
    });
    const gate = createGate();
    world.behavior.transport = () => gate.promise;
    const otherOperation = world.settled(world.runPass({ operationId: 'op-2', lane: 'lane-2' }));
    await settle();
    const before = { stop: world.counts.stop, signer: world.counts.signer, transport: world.counts.transport };
    for (const armed of armedPasses) {
      let innerCalls = 0;
      const stolenSign = await world.settled(ebSign(async () => { innerCalls += 1; }, armed)());
      const stolenSend = await world.settled(ebTransmit(async () => { innerCalls += 1; }, armed)());
      assertRefusal(stolenSign.error, 'tp1_fence_not_owned');
      assertRefusal(stolenSend.error, 'tp1_fence_not_owned');
      assert.equal(innerCalls, 0);
    }
    assert.deepEqual({ stop: world.counts.stop, signer: world.counts.signer, transport: world.counts.transport }, before, 'no read and no inner call happened');
    gate.open();
    await otherOperation;
  });

  await t.test('a second transmission through one armed stage is refused', async () => {
    const world = createWorld();
    const attempts = [];
    const { value } = await world.settled(world.runPass({
      stages: [{ name: 'dispatch', send: async (armed, bytes) => {
        const first = await world.send(armed, bytes);
        attempts.push(await world.settled(world.send(armed, bytes)));
        return first;
      } }],
    }));
    assertRefusal(attempts[0].error, 'eb_transmission_repeated');
    assert.equal(world.counts.transport, 1);
    assert.equal(value.outcomes[0].state, 'acknowledged');
  });

  await t.test('hostile: a sign step that returns bytes without the EB signer is refused before anything is persisted', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async () => new Uint8Array([1, 2, 3]) }));
    assertRefusal(error, 'eb_signer_bypassed');
    assert.deepEqual(world.records.kinds('lane-1'), []);
    assert.equal(world.counts.transport, 0);
  });

  await t.test('hostile: a send step that never runs the EB transmitter leaves dispatch-unknown, not "not sent"', async () => {
    const world = createWorld();
    const { value } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: async () => ({ accepted: true }) }] }));
    assert.equal(value.outcomes[0].state, 'unknown');
    assert.equal(value.outcomes[0].cause.code, 'eb_transmitter_bypassed');
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-unknown']);
  });

  await t.test('hostile: a first stage that returns while its transmission is still pending ends confirm-unknown, broadcast never runs, and the fence is held until the send settles', async () => {
    const [world, other] = twoTabs();
    const transmission = pendingTransport(world);
    const running = world.settled(world.runPass({
      stages: [
        { name: 'confirm', send: async (armed, bytes) => { world.send(armed, bytes).catch(() => undefined); await settle(); return { queued: true }; } },
        { name: 'broadcast', send: world.send },
      ],
    }));
    await settle();
    assert.ok(await isPending(running), 'the pass waits for the send it let start');
    assert.equal(await world.fenceIsFree(), false);
    const second = other.settled(other.runPass());
    await settle();
    assert.deepEqual([other.counts.signer, other.counts.transport], [0, 0], 'a second operation does not sign or send during the first send');
    transmission.reject(new Error('confirmation rejected after the callback returned'));
    const { value } = await running;
    assert.deepEqual(value.outcomes.map(({ stage, state }) => [stage, state]), [['confirm', 'unknown']]);
    assert.equal(value.outcomes[0].cause.code, 'eb_transmission_unfinished');
    assert.equal(world.counts.transport, 1);
    assert.deepEqual(world.records.kinds(world.lane), ['signed', 'confirm-started', 'confirm-unknown']);
    assert.equal((await second).error, undefined);
    assert.deepEqual([other.counts.signer, other.counts.transport], [1, 1], 'the second operation runs once the first send settled');
  });

  await t.test('hostile: a stage whose transmission failed but whose callback resolves ends dispatch-unknown with the transport error as cause', async () => {
    const world = createWorld();
    const transportError = new Error('transport down');
    world.behavior.transport = async () => { throw transportError; };
    const { value } = await world.settled(world.runPass({
      stages: [{ name: 'dispatch', send: async (armed, bytes) => { await world.send(armed, bytes).catch(() => undefined); return { accepted: true }; } }],
    }));
    assert.equal(value.outcomes[0].state, 'unknown');
    assert.equal(value.outcomes[0].cause, transportError);
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-unknown']);
    assert.equal(world.records.records('lane-1')[2].cause.message, 'transport down');
  });
});

test('the bytes the wrapped signer returned are the bytes persisted and the only bytes the transmitter sends', async (t) => {
  await t.test('a sign step returning other bytes than the wrapped signer does not change what is persisted or sent', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async (armed) => { await world.sign(armed); return new Uint8Array([2]); } }));
    assert.equal(error, undefined);
    assert.deepEqual([...world.records.records('lane-1')[0].bytes], world.SIGNED_BYTES);
    assert.deepEqual([...world.sent[0]], world.SIGNED_BYTES);
  });

  const otherBytes = [
    { name: 'other bytes than the persisted ones', send: (world, armed) => world.send(armed, new Uint8Array([99])) },
    { name: 'the persisted array changed by the stage before the transmitter', send: (world, armed, bytes) => { bytes[0] = 99; return world.send(armed, bytes); } },
    { name: 'a shorter prefix of the persisted bytes', send: (world, armed, bytes) => world.send(armed, bytes.slice(0, 2)) },
    { name: 'no bytes', send: (world, armed) => world.send(armed) },
    { name: 'a value that is not bytes', send: (world, armed) => world.send(armed, 'text') },
  ];
  for (const row of otherBytes) {
    await t.test(`the transmitter refuses ${row.name} with transport 0 and records dispatch-withheld`, async () => {
      const world = createWorld();
      const { error } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: (armed, bytes) => row.send(world, armed, bytes) }] }));
      assertRefusal(error, 'eb_bytes_mismatch');
      assert.equal(world.counts.transport, 0);
      assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-withheld']);
    });
  }

  await t.test('a second signature in one pass is refused and the signer ran once', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async (armed) => { await world.sign(armed); return world.sign(armed); } }));
    assertRefusal(error, 'eb_signer_repeated');
    assert.equal(world.counts.signer, 1);
    assert.equal(world.counts.transport, 0);
  });

  await t.test('a send step that signs with its stage handle is refused tp1_fence_not_owned and the signer is not called', async () => {
    const first = createWorld();
    first.records.beforeCommit.set('dispatch-started', () => { first.state.killed = true; });
    await first.settled(first.runPass());
    first.records.beforeCommit.clear();
    const resumed = createWorld({ records: first.records });
    const { error } = await resumed.settled(resumed.runPass({
      retained: { bytes: new Uint8Array(first.SIGNED_BYTES) },
      sign: undefined,
      stages: [{ name: 'dispatch', send: (armed) => resumed.sign(armed) }],
    }));
    assertRefusal(error, 'tp1_fence_not_owned');
    assert.deepEqual([resumed.counts.signer, resumed.counts.transport], [0, 0]);
  });

  await t.test('a sign step that sends with its sign handle before the bytes are persisted is refused tp1_fence_not_owned', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async (armed) => { await world.sign(armed); return world.send(armed, new Uint8Array(world.SIGNED_BYTES)); } }));
    assertRefusal(error, 'tp1_fence_not_owned');
    assert.equal(world.counts.transport, 0);
    assert.deepEqual(world.records.kinds('lane-1'), []);
  });

  await t.test('a signer result that is not bytes is refused before anything is persisted', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: (armed) => ebSign(async () => 'signature', armed)() }));
    assertRefusal(error, 'eb_signed_bytes_invalid');
    assert.deepEqual(world.records.kinds('lane-1'), []);
  });
});

test('the handle given to sign and send steps carries no pass state: bytes, call counts and liveness cannot be changed through it', async (t) => {
  const forged = new Uint8Array([66, 66]);

  await t.test('the handle is frozen and shows only the fence capability', async () => {
    const world = createWorld();
    const seen = [];
    await world.runPass({ sign: (armed) => { seen.push(armed); return world.sign(armed); } });
    assert.ok(Object.isFrozen(seen[0]));
    assert.deepEqual(Object.keys(seen[0]), ['capability']);
  });

  await t.test('a sign step overwriting the handle\'s byte fields after the EB signer ran changes neither the persisted nor the sent bytes', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async (armed) => {
      await world.sign(armed);
      for (const field of ['signedBytes', 'signed', 'bytes']) Reflect.set(armed, field, forged);
    } }));
    assert.equal(error, undefined);
    assert.deepEqual([...world.records.records('lane-1')[0].bytes], world.SIGNED_BYTES);
    assert.deepEqual(world.sent.map((bytes) => [...bytes]), [world.SIGNED_BYTES]);
  });

  await t.test('a send step overwriting the handle\'s bytes then sending them is refused eb_bytes_mismatch with transport 0', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: (armed) => {
      Reflect.set(armed, 'bytes', forged);
      return world.send(armed, forged);
    } }] }));
    assertRefusal(error, 'eb_bytes_mismatch');
    assert.equal(world.counts.transport, 0);
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-withheld']);
  });

  await t.test('a send step resetting the handle\'s call count cannot transmit a second time', async () => {
    const world = createWorld();
    const attempts = [];
    const { value } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: async (armed, bytes) => {
      const first = await world.send(armed, bytes);
      Reflect.set(armed, 'sendCalls', 0);
      attempts.push(await world.settled(world.send(armed, bytes)));
      return first;
    } }] }));
    assertRefusal(attempts[0].error, 'eb_transmission_repeated');
    assert.equal(world.counts.transport, 1);
    assert.equal(value.outcomes[0].state, 'acknowledged');
  });

  await t.test('a copy of a handle is not a handle: the EB signer and EB transmitter refuse it tp1_fence_not_owned', async () => {
    const world = createWorld();
    const copies = [];
    await world.runPass({ sign: (armed) => { copies.push({ ...armed }); return world.sign(armed); } });
    let innerCalls = 0;
    for (const copy of [...copies, {}, undefined]) {
      assertRefusal((await world.settled(ebSign(async () => { innerCalls += 1; }, copy)())).error, 'tp1_fence_not_owned');
      assertRefusal((await world.settled(ebTransmit(async () => { innerCalls += 1; }, copy)())).error, 'tp1_fence_not_owned');
    }
    assert.equal(innerCalls, 0);
  });
});

test('resume bytes are copied when the pass starts: changing the caller\'s array inside any stop read changes neither the comparison nor the transmission', async (t) => {
  for (const call of [1, 2, 3, 4, 5]) {
    await t.test(`the caller's array changed inside stop read ${call}`, async () => {
      const first = createWorld();
      first.records.beforeCommit.set('dispatch-started', () => { first.state.killed = true; });
      await first.settled(first.runPass());
      first.records.beforeCommit.clear();
      const retained = { bytes: new Uint8Array(first.SIGNED_BYTES) };
      const resumed = createWorld({ records: first.records });
      resumed.on('stop', call, () => { retained.bytes[0] = 99; });
      const { error } = await resumed.settled(resumed.runPass({ retained, sign: undefined }));
      assert.equal(error, undefined);
      assert.deepEqual(resumed.sent.map((bytes) => [...bytes]), [first.SIGNED_BYTES]);
      assert.equal(first.records.kinds('lane-1').at(-1), 'dispatch-acknowledged');
    });
  }
});

// Each row leaves a two-stage lane at a stage that was held or withheld, then a second pass resumes it. A `fromHead`
test('K0-F8 a lane resumed at confirm alone ends at confirm-acknowledged and a later resume transmits broadcast once', async () => {
  const first = createWorld();
  first.records.failures.set('confirm-started', new Error('disk full'));
  await first.settled(first.runPass({ stages: stagesOf(first, ['confirm', 'broadcast']) }));
  first.records.failures.clear();
  const retained = () => ({ bytes: new Uint8Array(first.SIGNED_BYTES) });
  const confirmed = createWorld({ records: first.records });
  assert.equal((await confirmed.settled(confirmed.runPass({ retained: retained(), sign: undefined, stages: stagesOf(confirmed, ['confirm']) }))).error, undefined);
  assert.equal(first.records.kinds('lane-1').at(-1), 'confirm-acknowledged');
  const broadcast = createWorld({ records: first.records });
  assert.equal((await broadcast.settled(broadcast.runPass({ retained: retained(), sign: undefined, stages: stagesOf(broadcast, ['broadcast']) }))).error, undefined);
  assert.equal(broadcast.counts.transport, 1);
  assert.deepEqual(first.records.kinds('lane-1').slice(-2), ['broadcast-started', 'broadcast-acknowledged']);
});

const stagesOf = (world, names) => names.map((name) => ({ name, send: world.send }));
const effectCounts = (world) => [world.counts.stop, world.counts.authority, world.counts.lockRequests, world.counts.signer, world.counts.transport];

const rejectedTuples = [
  { name: 'empty', stages: () => [] },
  { name: 'missing', stages: () => undefined },
  { name: 'a repeated dispatch', stages: (w) => stagesOf(w, ['dispatch', 'dispatch']) },
  { name: 'a repeated confirm', stages: (w) => stagesOf(w, ['confirm', 'confirm']) },
  { name: 'broadcast before confirm', stages: (w) => stagesOf(w, ['broadcast', 'confirm']) },
  { name: 'dispatch mixed with broadcast', stages: (w) => stagesOf(w, ['dispatch', 'broadcast']) },
  { name: 'an unknown stage', stages: (w) => stagesOf(w, ['refund']) },
  { name: 'a stage without send', stages: () => [{ name: 'dispatch' }] },
  ...[
    ['broadcast', 'broadcast'], ['confirm', 'dispatch'], ['broadcast', 'dispatch'], ['dispatch', 'confirm'],
    ['confirm', 'broadcast', 'dispatch'], ['confirm', 'broadcast', 'confirm'], ['confirm', 'broadcast', 'broadcast'],
    ['dispatch', 'dispatch', 'dispatch'], ['confirm', 'confirm', 'broadcast'], ['refund', 'dispatch'],
  ].map((names) => ({ name: names.join('+'), stages: (w) => stagesOf(w, names) })),
  { name: 'null stages', stages: () => null },
  { name: 'non-array stages', stages: () => ({ 0: { name: 'dispatch' }, length: 1 }) },
];

test('a pass runs only a closed stage tuple: anything else is a TypeError before any read, lock, record or effect', async (t) => {
  for (const row of rejectedTuples) {
    for (const mode of ['signing', 'resume']) {
      await t.test(`a ${mode} pass with ${row.name} throws with signer 0, transport 0 and an empty lane`, async () => {
        const world = createWorld();
        const resume = mode === 'resume' ? { retained: { bytes: new Uint8Array(world.SIGNED_BYTES) }, sign: undefined } : {};
        const { error } = await world.settled(world.runPass({ ...resume, stages: row.stages(world) }));
        assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
        assert.deepEqual(effectCounts(world), [0, 0, 0, 0, 0]);
        assert.deepEqual(world.records.kinds('lane-1'), []);
      });
    }
  }
  for (const names of [['confirm'], ['broadcast']]) {
    await t.test(`a signing pass with only ${names[0]} is not a workflow and throws before any effect`, async () => {
      const world = createWorld();
      const { error } = await world.settled(world.runPass({ stages: stagesOf(world, names) }));
      assert.ok(error instanceof TypeError);
      assert.deepEqual(effectCounts(world), [0, 0, 0, 0, 0]);
    });
  }
  await t.test('a signing pass records its workflow on the signed record', async () => {
    const world = createWorld();
    await world.runPass({ stages: stagesOf(world, ['confirm', 'broadcast']) });
    assert.equal(world.records.records('lane-1')[0].workflow, 'confirm-broadcast');
  });
});

// Independent answer key: exactly nine states, including confirmation committed before broadcast intent.
const RESUME_ANSWERS = [
  ['dispatch', 'signed', undefined, [['dispatch']]],
  ['dispatch', 'signed-held', 'dispatch', [['dispatch']]],
  ['dispatch', 'dispatch-withheld', 'dispatch', [['dispatch']]],
  ['confirm-broadcast', 'signed', undefined, [['confirm'], ['confirm', 'broadcast']]],
  ['confirm-broadcast', 'signed-held', 'confirm', [['confirm'], ['confirm', 'broadcast']]],
  ['confirm-broadcast', 'confirm-withheld', 'confirm', [['confirm'], ['confirm', 'broadcast']]],
  ['confirm-broadcast', 'confirm-acknowledged', 'confirm', [['broadcast']]],
  ['confirm-broadcast', 'signed-held', 'broadcast', [['broadcast']]],
  ['confirm-broadcast', 'broadcast-withheld', 'broadcast', [['broadcast']]],
];
const IDENTITY = { operationId: 'op-1', pinVersion: 'pin-1', approvalRevision: 'approval-1' };
const storedSigned = (overrides) => ({ kind: 'signed', workflow: 'dispatch', bytes: new Uint8Array([7, 8, 9, 10]), ...IDENTITY, ...overrides });
function craftedRecords(signed, last = signed, revision = 3) {
  const appended = [];
  return { appended, head: async () => ({ revision, signed, last }), append: async (lane, expected, record) => { appended.push(record.kind); return { revision: expected + 1 }; } };
}
const resumeRequest = (w, names = ['dispatch']) => ({ sign: undefined, retained: { bytes: new Uint8Array(w.SIGNED_BYTES) }, stages: stagesOf(w, names) });
function noResumeEffects(w) {
  assert.deepEqual([w.counts.signer, w.counts.transport, w.records.appended], [0, 0, []]);
}

test('K0-F8 raw head workflow, kind, stage, identity and tuple agree with the independent nine-row answer key', async () => {
  const stages = ['dispatch', 'confirm', 'broadcast'];
  const kinds = ['signed', 'signed-held', 'refund-withheld', 'constructor', undefined, ...stages.flatMap((s) => ['withheld', 'started', 'unknown', 'acknowledged'].map((end) => `${s}-${end}`))];
  const identities = [{}, ...Object.keys(IDENTITY).flatMap((key) => [{ [key]: 'changed' }, { [key]: undefined }, { [key]: {} }])];
  let allowed = 0;
  for (const workflow of ['dispatch', 'confirm-broadcast', undefined, 'refund']) {
    for (const kind of kinds) for (const stage of [undefined, ...stages]) for (const identity of identities) {
      for (const tuple of [['dispatch'], ['confirm'], ['broadcast'], ['confirm', 'broadcast']]) {
        const signed = storedSigned({ workflow, ...identity });
        const w = createWorld({ records: craftedRecords(signed, { kind, stage }) });
        const { error } = await w.settled(w.runPass(resumeRequest(w, tuple)));
        const effectiveStage = kind?.endsWith('-withheld') && stage === undefined ? kind.slice(0, -9) : stage;
        const accept = Object.keys(identity).length === 0 && RESUME_ANSWERS.some(([wf, k, s, tuples]) => wf === workflow && k === kind && s === effectiveStage && tuples.some((t) => t.join() === tuple.join()));
        const actual = [error?.code, w.counts.signer, w.counts.transport, w.records.appended];
        const expected = accept ? [undefined, 0, tuple.length, tuple.flatMap((s) => [`${s}-started`, `${s}-acknowledged`])] : ['eb_resume_not_allowed', 0, 0, []];
        assert.deepEqual(actual, expected, JSON.stringify({ workflow, kind, stage, identity, tuple }));
        if (accept) allowed += 1;
      }
    }
  }
  assert.equal(allowed, 16, 'nine states include short prefixes and omitted withheld stage');
});

test('cold2 F1 request identities are primitive nonempty strings before every adapter in both modes', async (t) => {
  for (const key of [...Object.keys(IDENTITY), 'lane']) for (const value of [undefined, null, {}, 1, '', new String('revision')]) {
    for (const mode of ['sign', 'resume']) await t.test(`${key} ${String(value)} ${mode}`, async () => {
      const w = createWorld();
      let heads = 0;
      w.records.head = async () => { heads += 1; return { revision: 0 }; };
      const { error } = await w.settled(w.runPass({ ...(mode === 'resume' ? resumeRequest(w) : {}), [key]: value }));
      assert.ok(error instanceof TypeError);
      assert.deepEqual([...effectCounts(w), heads, w.events.length, w.records.kinds(w.lane).length], [0, 0, 0, 0, 0, 0, 0, 0]);
    });
  }
});

test('cold2 F1 exact missing-pin and missing-approval probes refuse both initial sign and matching-missing resume', async (t) => {
  for (const key of ['pinVersion', 'approvalRevision']) await t.test(key, async () => {
    const w = createWorld();
    w.records.failures.set('dispatch-started', new Error('intent commit failed'));
    const initial = await w.settled(w.runPass({ [key]: undefined }));
    assert.ok(initial.error instanceof TypeError);
    const records = craftedRecords(storedSigned({ [key]: undefined }));
    const resumed = createWorld({ records });
    assert.ok((await resumed.settled(resumed.runPass({ ...resumeRequest(resumed), [key]: undefined }))).error instanceof TypeError);
    noResumeEffects(resumed);
    assert.deepEqual([w.counts.signer, w.counts.transport, w.records.kinds(w.lane)], [0, 0, []]);
  });
});

test('raw malformed lane heads never authorize signing or resumption', async (t) => {
  const signed = storedSigned();
  const invalid = [undefined, null, {}, { ...signed, kind: 'other' }, { ...signed, bytes: [] }, { ...signed, bytes: new Uint8Array() }, ...Object.keys(IDENTITY).flatMap((key) => [undefined, null, {}, 1, ''].map((value) => ({ ...signed, [key]: value })))];
  for (const [index, record] of invalid.entries()) await t.test(`signed shape ${index}`, async () => {
    const w = createWorld({ records: craftedRecords(record, { kind: 'signed' }) });
    assertRefusal((await w.settled(w.runPass(resumeRequest(w)))).error, 'eb_resume_not_allowed');
    noResumeEffects(w);
    assertRefusal((await w.settled(w.runPass())).error, 'eb_lane_not_empty');
  });
  for (const revision of [-1, '1', NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    const w = createWorld({ records: craftedRecords(signed, signed, revision) });
    assertRefusal((await w.settled(w.runPass(resumeRequest(w)))).error, 'eb_persist_failed');
    noResumeEffects(w);
  }
  await t.test('an empty lane cannot resume retained bytes', async () => {
    const w = createWorld();
    assertRefusal((await w.settled(w.runPass(resumeRequest(w)))).error, 'eb_resume_not_allowed');
    assert.deepEqual([w.counts.signer, w.counts.transport, w.records.kinds(w.lane)], [0, 0, []]);
  });
  await t.test('an occupied valid lane cannot sign again', async () => {
    const w = createWorld({ records: craftedRecords(signed) });
    assertRefusal((await w.settled(w.runPass())).error, 'eb_lane_not_empty');
    noResumeEffects(w);
  });
  const inconsistentEmpty = createWorld({ records: craftedRecords(signed, signed, 0) });
  assertRefusal((await inconsistentEmpty.settled(inconsistentEmpty.runPass())).error, 'eb_lane_not_empty');
  assert.equal(inconsistentEmpty.counts.signer, 0);
});

test('K0-F8 crash recovery is derived from each actual committed write and never repeats confirm', async (t) => {
  for (const workflow of [['dispatch'], ['confirm', 'broadcast']]) {
    const complete = createWorld();
    await complete.runPass({ stages: stagesOf(complete, workflow) });
    const writes = complete.records.records(complete.lane);
    for (let i = 0; i < writes.length; i += 1) await t.test(`crash after ${workflow.join('+')} ${writes[i].kind}`, async () => {
      const records = createMemoryRecords();
      for (let j = 0; j <= i; j += 1) await records.append('lane-1', j, writes[j]);
      const next = writes[i].kind === 'signed' ? workflow : writes[i].kind === 'confirm-acknowledged' ? ['broadcast'] : null;
      const w = createWorld({ records });
      const { error } = await w.settled(w.runPass(resumeRequest(w, next ?? workflow)));
      assert.equal(error?.code, next ? undefined : 'eb_resume_not_allowed');
      assert.deepEqual([w.counts.signer, w.counts.transport], [0, next?.length ?? 0]);
      const repeat = createWorld({ records });
      assertRefusal((await repeat.settled(repeat.runPass(resumeRequest(repeat, ['confirm'])))).error, 'eb_resume_not_allowed');
      assert.equal(repeat.counts.transport, 0);
    });
  }
});

test('a failed broadcast-started commit leaves confirm acknowledged and a restart sends broadcast once', async () => {
  const w = createWorld();
  w.records.failures.set('broadcast-started', new Error('disk full'));
  assertRefusal((await w.settled(w.runPass({ stages: stagesOf(w, ['confirm', 'broadcast']) }))).error, 'eb_persist_failed');
  w.records.failures.clear();
  const restarted = createWorld({ records: w.records });
  await restarted.runPass(resumeRequest(restarted, ['broadcast']));
  assert.deepEqual([w.counts.transport, restarted.counts.signer, restarted.counts.transport], [1, 0, 1]);
});

test('the EB8f transport gets a private copy: the caller\'s array and the transport\'s own input cannot change what is persisted or sent', async (t) => {
  await t.test('a send step changing its array during the final stop read and after the inner send started sends the persisted bytes', async () => {
    const world = createWorld();
    const transmitting = createGate();
    const seen = [];
    world.behavior.transport = async (bytes) => { await transmitting.promise; seen.push([...bytes]); return { accepted: true }; };
    const { value } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: async (handle, bytes) => {
      const mine = new Uint8Array(bytes);
      const sending = world.send(handle, mine);
      mine[0] = 98;
      await settle();
      mine[0] = 99;
      transmitting.open();
      return sending;
    } }] }));
    assert.equal(value.outcomes[0].state, 'acknowledged');
    assert.deepEqual(seen, [world.SIGNED_BYTES]);
    assert.deepEqual([...world.records.records('lane-1')[0].bytes], world.SIGNED_BYTES);
  });

  await t.test('a transport changing its input during confirm does not change the bytes broadcast sends', async () => {
    const world = createWorld();
    world.behavior.transport = async (bytes) => { bytes[0] = 99; return { accepted: true }; };
    await world.runPass({ stages: stagesOf(world, ['confirm', 'broadcast']) });
    assert.equal(world.counts.transport, 2);
    assert.notEqual(world.sent[0], world.sent[1], 'each transmission gets its own array');
    assert.deepEqual([...world.sent[1]].slice(1), world.SIGNED_BYTES.slice(1));
    assert.equal(world.sent[1][0], 99, 'the second array was changed by its own transport only');
  });

  await t.test('a sign step changing the array the EB signer returned changes neither the persisted nor the sent bytes', async () => {
    const world = createWorld();
    await world.runPass({ sign: async (handle) => { const signed = await world.sign(handle); signed[0] = 99; return signed; } });
    assert.deepEqual([...world.records.records('lane-1')[0].bytes], world.SIGNED_BYTES);
    assert.deepEqual([...world.sent[0]], world.SIGNED_BYTES);
  });
});

test('each step has its own one-use handle: a kept, stale or other-stage handle is refused with zero inner calls', async (t) => {
  await t.test('a kept sign handle transmitting during EB7 is refused tp1_fence_not_owned and the stage then sends once', async () => {
    const world = createWorld();
    let signHandle;
    const early = [];
    world.on('authority', 3, async () => {
      early.push(await world.settled(world.send(signHandle, new Uint8Array(world.SIGNED_BYTES))));
      early.push(await world.settled(world.sign(signHandle)));
    });
    const { error } = await world.settled(world.runPass({ sign: (handle) => { signHandle = handle; return world.sign(handle); } }));
    assert.equal(error, undefined);
    for (const attempt of early) assertRefusal(attempt.error, 'tp1_fence_not_owned');
    assert.deepEqual([world.counts.signer, world.counts.transport], [1, 1]);
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  });

  await t.test('a handle used while the -started record is being written is refused', async () => {
    const world = createWorld();
    const handles = [];
    const pending = [];
    for (const kind of ['confirm-started', 'broadcast-started']) {
      world.records.beforeCommit.set(kind, async () => { for (const handle of handles) pending.push(await world.settled(world.send(handle, new Uint8Array(world.SIGNED_BYTES)))); });
    }
    const keep = (handle, bytes) => { handles.push(handle); return world.send(handle, bytes); };
    await world.runPass({ sign: (handle) => { handles.push(handle); return world.sign(handle); }, stages: [{ name: 'confirm', send: keep }, { name: 'broadcast', send: keep }] });
    assert.equal(pending.length, 3);
    for (const attempt of pending) assertRefusal(attempt.error, 'tp1_fence_not_owned');
    assert.equal(world.counts.transport, 2);
  });

  await t.test('a confirm handle used during broadcast is refused and broadcast sends its own once', async () => {
    const world = createWorld();
    let confirmHandle;
    const stale = [];
    const { value } = await world.settled(world.runPass({ stages: [
      { name: 'confirm', send: (handle, bytes) => { confirmHandle = handle; return world.send(handle, bytes); } },
      { name: 'broadcast', send: async (handle, bytes) => { stale.push(await world.settled(world.send(confirmHandle, bytes))); return world.send(handle, bytes); } },
    ] }));
    assertRefusal(stale[0].error, 'tp1_fence_not_owned');
    assert.deepEqual(value.outcomes.map((outcome) => outcome.state), ['acknowledged', 'acknowledged']);
    assert.equal(world.counts.transport, 2);
  });

  await t.test('two concurrent transmissions on one live handle make one inner call; the other is eb_transmission_repeated', async () => {
    const world = createWorld();
    const attempts = [];
    const { value } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: async (handle, bytes) => {
      attempts.push(...await Promise.all([world.settled(world.send(handle, bytes)), world.settled(world.send(handle, bytes))]));
      return attempts.find((attempt) => attempt.error === undefined).value;
    } }] }));
    assert.equal(world.counts.transport, 1);
    assert.deepEqual(attempts.map((attempt) => attempt.error?.code), [undefined, 'eb_transmission_repeated']);
    assert.equal(value.outcomes[0].state, 'acknowledged');
  });

  await t.test('a transmission the send step started but did not await is refused once the stage closed and the stage is unknown', async () => {
    const world = createWorld();
    const late = [];
    const { value } = await world.settled(world.runPass({ stages: [{ name: 'dispatch', send: (handle, bytes) => { late.push(world.settled(world.send(handle, bytes))); } }] }));
    assertRefusal((await late[0]).error, 'tp1_fence_not_owned');
    assert.equal(world.counts.transport, 0);
    assert.equal(value.outcomes[0].state, 'unknown');
  });
});

test('the pass copies its request on entry: changing the caller\'s request or stage descriptors at any await changes nothing', async (t) => {
  for (const workflow of [['dispatch'], ['confirm', 'broadcast']]) {
    const points = [...Array.from({ length: workflow.length === 1 ? 5 : 7 }, (_, i) => ['stop', i + 1]), ...Array.from({ length: workflow.length === 1 ? 3 : 4 }, (_, i) => ['authority', i + 1]), ...['signed', ...workflow.flatMap((s) => [`${s}-started`, `${s}-acknowledged`])].map((kind) => ['commit', kind])];
    for (const [kind, call] of points) await t.test(`${workflow.join('+')} request changed inside ${kind} ${call}`, async () => {
      const world = createWorld();
      let foreign = 0;
      const request = world.request({ stages: stagesOf(world, workflow) });
      const tamper = () => {
        request.stages[0].name = 'broadcast';
        request.stages[0].send = async () => { foreign += 1; };
        request.stages.push({ name: 'dispatch', send: world.send });
        request.sign = async () => { foreign += 1; };
        request.lane = 'lane-other';
        for (const key of Object.keys(IDENTITY)) request[key] = { changed: true };
      };
      if (kind === 'commit') world.records.beforeCommit.set(call, tamper); else world.on(kind, call, tamper);
      const { error } = await world.settled(world.boundary.runPass(request));
      assert.equal(error, undefined);
      assert.deepEqual([world.counts.signer, world.counts.transport, foreign], [1, workflow.length, 0]);
      assert.deepEqual(world.records.kinds('lane-1'), ['signed', ...workflow.flatMap((s) => [`${s}-started`, `${s}-acknowledged`])]);
      assert.deepEqual(world.records.kinds('lane-other'), []);
      for (const record of world.records.records(world.lane)) for (const [key, value] of Object.entries(IDENTITY)) assert.equal(record[key], value);
    });
  }
});

const appendFailures = [
  { kind: 'signed', arrange: () => {}, transport: 0, kinds: [] },
  { kind: 'signed-held', arrange: (w) => w.on('authority', 3, () => { w.state.digest = 'digest-2'; }), transport: 0, kinds: ['signed'] },
  { kind: 'dispatch-started', arrange: () => {}, transport: 0, kinds: ['signed'] },
  { kind: 'dispatch-withheld', arrange: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.killed = true; }), transport: 0, kinds: ['signed', 'dispatch-started'] },
  { kind: 'dispatch-acknowledged', arrange: () => {}, transport: 1, kinds: ['signed', 'dispatch-started'] },
  { kind: 'dispatch-unknown', arrange: (w) => { w.behavior.transport = async () => { throw new Error('socket reset'); }; }, transport: 1, kinds: ['signed', 'dispatch-started'] },
];

test('a failed append stops the next effect, and an invoked transmission is never reported or recorded as withheld', async (t) => {
  for (const row of appendFailures) {
    await t.test(`a failed ${row.kind} write refuses eb_persist_failed with transport ${row.transport}`, async () => {
      const world = createWorld();
      row.arrange(world);
      world.records.failures.set(row.kind, new Error('disk full'));
      const { error } = await world.settled(world.runPass());
      assertRefusal(error, 'eb_persist_failed');
      assert.deepEqual([world.counts.signer, world.counts.transport], [1, row.transport]);
      assert.deepEqual(world.records.kinds('lane-1'), row.kinds);
      assert.ok(await world.fenceIsFree());
    });
  }
});

test('a record store that moved under the pass or answers out of sequence refuses eb_persist_failed before any send', async (t) => {
  await t.test('a lane another writer advanced after the pass read its head is not overwritten: the append is refused and nothing is sent', async () => {
    const world = createWorld();
    world.records.beforeCommit.set('signed', () => world.records.append('lane-1', 0, { kind: 'other-writer' }));
    const { error } = await world.settled(world.runPass());
    assertRefusal(error, 'eb_persist_failed');
    assert.match(error.cause.message, /revision conflict/);
    assert.deepEqual(world.records.kinds('lane-1'), ['other-writer']);
    assert.deepEqual([world.counts.signer, world.counts.transport], [1, 0]);
    assert.ok(await world.fenceIsFree());
  });

  await t.test('an append that answers a revision other than the next one stops the pass with transport 0', async () => {
    const world = createWorld();
    const append = world.records.append;
    world.records.append = async (...args) => {
      await append(...args);
      return { revision: 99 };
    };
    const { error } = await world.settled(world.runPass());
    assertRefusal(error, 'eb_persist_failed');
    assert.ok(error.cause instanceof TypeError);
    assert.deepEqual([world.counts.signer, world.counts.transport], [1, 0]);
    assert.ok(await world.fenceIsFree());
  });
});

test('error summaries tolerate null prototypes, throwing getters and oversized messages before and after invocation', async (t) => {
  const causes = [Object.create(null), Object.defineProperty({}, 'message', { get() { throw new Error('getter'); } }), Object.defineProperty({}, 'code', { get() { throw new Error('getter'); } }), new Error('x'.repeat(500))];
  for (const [index, cause] of causes.entries()) for (const invoked of [false, true]) await t.test(`cause ${index}, invoked ${invoked}`, async () => {
    const w = createWorld();
    const result = await w.settled(w.runPass({ stages: [{ name: 'dispatch', send: async (h, bytes) => { if (invoked) await w.send(h, bytes); throw cause; } }] }));
    if (invoked) assert.equal(result.value.outcomes[0].cause, cause); else assert.equal(result.error, cause);
    const last = w.records.records(w.lane).at(-1);
    assert.equal(last.kind, invoked ? 'dispatch-unknown' : 'dispatch-withheld');
    assert.ok(last.cause.message.length <= 200);
    assert.ok(last.cause.code.length <= 200);
  });
});

test('failed held and withheld records retain the original refusal and persistence cause', async (t) => {
  for (const kind of ['signed-held', 'dispatch-withheld']) await t.test(kind, async () => {
    const w = createWorld();
    const original = new Error('original refusal');
    const disk = new Error('disk full');
    if (kind === 'signed-held') w.on('authority', 3, () => { throw original; });
    w.records.failures.set(kind, disk);
    const stages = kind === 'dispatch-withheld' ? [{ name: 'dispatch', send: async () => { throw original; } }] : undefined;
    const { error } = await w.settled(w.runPass(stages ? { stages } : {}));
    assertRefusal(error, 'eb_persist_failed');
    assert.ok(error.cause instanceof AggregateError);
    const [refusal, persistence] = error.cause.errors;
    assert.equal(kind === 'signed-held' ? refusal.cause : refusal, original);
    assertRefusal(persistence, 'eb_persist_failed');
    assert.equal(persistence.cause, disk);
  });
});

test('checks keep their receiver and approval receives only the captured primitive revision', async () => {
  const w = createWorld();
  const calls = [];
  const checks = {
    ok: true,
    admission() { assert.equal(this, checks); return this.ok; },
    approval(revision) { assert.equal(this, checks); calls.push(revision); return this.ok; },
    connectionDigest() { assert.equal(this, checks); return 'digest'; },
    async stopped() { assert.equal(this, checks); return !this.ok; },
    async readAuthority() { assert.equal(this, checks); },
  };
  const boundary = createEffectBoundary({ fence: w.fence, records: w.records, checks, clock: w.clock });
  await boundary.runPass(w.request());
  assert.deepEqual(calls, ['approval-1', 'approval-1', 'approval-1']);
});

test('identity getters are captured exactly once and mutable object revisions never reach a commit barrier', async () => {
  const w = createWorld();
  const request = w.request();
  const reads = {};
  for (const [key, value] of Object.entries({ ...IDENTITY, lane: w.lane })) Object.defineProperty(request, key, { get() { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? value : 'changed'; } });
  await w.boundary.runPass(request);
  assert.deepEqual(Object.values(reads), [1, 1, 1, 1]);
  const objectRevision = { value: 'approval-1' };
  const invalid = createWorld();
  invalid.records.beforeCommit.set('signed', () => { objectRevision.value = 'changed'; });
  assert.ok((await invalid.settled(invalid.runPass({ approvalRevision: objectRevision }))).error instanceof TypeError);
  assert.equal(objectRevision.value, 'approval-1');
  assert.deepEqual(effectCounts(invalid), [0, 0, 0, 0, 0]);
});

test('the five stage outcome rows use actual transmission settlement and late success or failure never advances broadcast', async (t) => {
  for (const mode of ['not-invoked-error', 'not-invoked-ok', 'invoked-error', 'failed', 'pending-success', 'pending-error', 'fulfilled']) await t.test(mode, async () => {
    const w = createWorld();
    const failure = new Error('stage failure');
    let settleTransport;
    if (mode.startsWith('pending')) w.behavior.transport = () => new Promise((resolve, reject) => { settleTransport = mode === 'pending-success' ? resolve : reject; });
    if (mode === 'failed') w.behavior.transport = async () => { throw failure; };
    const callback = async (h, bytes) => {
      if (mode === 'not-invoked-error') throw failure;
      if (mode === 'not-invoked-ok') return 'no send';
      const sending = w.send(h, bytes);
      if (mode.startsWith('pending')) { sending.catch(() => {}); await settle(); return 'queued'; }
      await sending.catch(() => {});
      if (mode === 'invoked-error') throw failure;
      return 'callback ok';
    };
    const running = w.settled(w.runPass({ stages: [{ name: 'confirm', send: callback }, { name: 'broadcast', send: w.send }] }));
    if (mode.startsWith('pending')) {
      await settle();
      assert.ok(await isPending(running), 'the pass holds the fence until the send it let start settles');
      settleTransport(mode === 'pending-error' ? failure : 'late ok');
    }
    const { error, value } = await running;
    if (mode === 'not-invoked-error') assert.equal(error, failure);
    else assert.equal(value.outcomes[0].state, mode === 'fulfilled' ? 'acknowledged' : 'unknown');
    assert.equal(w.counts.transport, mode === 'fulfilled' ? 2 : mode.startsWith('not-invoked') ? 0 : 1);
    if (mode.startsWith('pending')) assert.deepEqual(w.records.kinds(w.lane), ['signed', 'confirm-started', 'confirm-unknown']);
    const before = w.records.kinds(w.lane);
    await settle();
    assert.deepEqual(w.records.kinds(w.lane), before);
  });
});

test('retained bytes must match the validated raw record and later mutations of that record cannot change egress', async () => {
  const signed = storedSigned();
  const wrong = createWorld({ records: craftedRecords(signed) });
  assertRefusal((await wrong.settled(wrong.runPass({ ...resumeRequest(wrong), retained: { bytes: new Uint8Array([99]) } }))).error, 'eb_resume_not_allowed');
  noResumeEffects(wrong);
  const w = createWorld({ records: craftedRecords(signed) });
  w.on('stop', 3, () => { signed.bytes.fill(99); signed.approvalRevision = 'changed'; });
  await w.runPass(resumeRequest(w));
  assert.deepEqual([...w.sent[0]], w.SIGNED_BYTES);
});

test('the aggregate read budget spans prechecks and the fenced signer tail', async () => {
  const w = createWorld();
  for (const [kind, call] of [['stop', 1], ['authority', 1], ['stop', 2], ['authority', 2]]) w.on(kind, call, () => w.clock.advance(2_499));
  w.on('stop', 3, () => w.clock.advance(4));
  assertRefusal((await w.settled(w.runPass())).error, 'stop_check_timeout');
  assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
  assert.ok(await w.fenceIsFree());
});

test('invalid request shapes and signer results fail closed', async (t) => {
  const requests = [undefined, null, 1, {}, { sign: undefined }, { retained: { bytes: new Uint8Array([1]) } }, { sign: 1 }, { sign: undefined, retained: {} }, { sign: undefined, retained: { bytes: [] } }, { sign: undefined, retained: { bytes: new Uint8Array() } }];
  for (const [index, overrides] of requests.entries()) await t.test(`request shape ${index}`, async () => {
    const w = createWorld();
    const request = index < 4 ? overrides : w.request(overrides);
    assert.ok((await w.settled(w.boundary.runPass(request))).error instanceof TypeError);
    assert.deepEqual(effectCounts(w), [0, 0, 0, 0, 0]);
  });
  const w = createWorld();
  assertRefusal((await w.settled(w.runPass({ sign: (h) => ebSign(async () => new Uint8Array(), h)() }))).error, 'eb_signed_bytes_invalid');
  assert.deepEqual(w.records.kinds(w.lane), []);
});

test('authority failures retain readable codes and the original cause when properties throw', async () => {
  for (const failure of [Object.assign(new Error('authority refused'), { code: 'unknown' }), Object.defineProperty({}, 'code', { get() { throw new Error('getter'); } }), Object.create(null)]) {
    const w = createWorld();
    w.on('authority', 1, () => { throw failure; });
    const { error } = await w.settled(w.runPass());
    assertRefusal(error, failure instanceof Error ? 'unknown' : 'tp1_authority_failed');
    assert.equal(error.cause, failure);
    assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
  }
});

test('the pass holds the wallet fence until every inner signer and send it let start has settled', async (t) => {
  // After `release()` the pass may finish; before it, a second tab must neither sign nor send.
  const assertHeldUntil = async (first, second, release) => {
    await settle();
    assert.ok(await isPending(first), 'the first pass is still running');
    assert.deepEqual([second.counts.signer, second.counts.transport], [0, 0], 'the second tab has not signed or sent');
    release();
    const finished = await first;
    assert.equal((await second.settled(second.runPass())).error, undefined);
    return finished;
  };

  await t.test('a stage callback that starts the send and then throws leaves dispatch-unknown only after the send settled', async () => {
    const [first, second] = twoTabs();
    const transmission = pendingTransport(first);
    const running = first.settled(first.runPass({ stages: [{ name: 'dispatch', send: earlySend(first, { thenThrow: new Error('callback failed') }) }] }));
    const { value } = await assertHeldUntil(running, second, () => transmission.resolve({ accepted: true }));
    assert.equal(value.outcomes[0].state, 'unknown');
    assert.deepEqual(first.records.kinds(first.lane), ['signed', 'dispatch-started', 'dispatch-unknown']);
  });

  await t.test('a failed dispatch-unknown append rejects eb_persist_failed only after the pending send settled', async () => {
    const [first, second] = twoTabs();
    const transmission = pendingTransport(first);
    first.records.failures.set('dispatch-unknown', new Error('disk full'));
    const running = first.settled(first.runPass({ stages: [{ name: 'dispatch', send: earlySend(first) }] }));
    const { error } = await assertHeldUntil(running, second, () => transmission.resolve({ accepted: true }));
    assertRefusal(error, 'eb_persist_failed');
    assert.deepEqual(first.records.kinds(first.lane), ['signed', 'dispatch-started']);
  });

  await t.test('a sign callback that starts the EB signer and returns refuses eb_signed_bytes_invalid only after the inner signer settled', async () => {
    const [first, second] = twoTabs();
    const signing = createGate();
    const slowSigner = async () => { first.counts.signer += 1; await signing.promise; return new Uint8Array([1, 2]); };
    const sign = async (armed) => { ebSign(slowSigner, armed)().catch(() => undefined); await settle(); };
    const running = first.settled(first.runPass({ sign }));
    const { error } = await assertHeldUntil(running, second, signing.open);
    assertRefusal(error, 'eb_signed_bytes_invalid');
    assert.deepEqual([first.counts.signer, first.counts.transport], [1, 0]);
    assert.deepEqual(first.records.kinds(first.lane), []);
  });

  await t.test('a nested pass under a caller-held capability keeps the outer holder waiting for the pending send', async () => {
    const [first] = twoTabs();
    const transmission = pendingTransport(first);
    const outer = first.settled(first.fence.run(first.operationId, (capability) => first.boundary.runPass(first.request({ capability, stages: [{ name: 'dispatch', send: earlySend(first) }] }))));
    await settle();
    assert.ok(await isPending(outer), 'the outer holder is still inside the fence');
    transmission.resolve({ accepted: true });
    assert.equal((await outer).value.outcomes[0].state, 'unknown');
  });

  await t.test('a connection replacement requested during a pending send keeps connectionGeneration until the send settled', async () => {
    const [first] = twoTabs();
    const transmission = pendingTransport(first);
    const running = first.settled(first.runPass({ stages: [{ name: 'dispatch', send: earlySend(first) }] }));
    await settle();
    const replacement = first.fence.replaceConnection(async () => {});
    await settle();
    assert.equal(first.fence.connectionGeneration, 0, 'the replacement waits for the send');
    transmission.resolve({ accepted: true });
    await running;
    await replacement;
    assert.equal(first.fence.connectionGeneration, 1);
  });

  await t.test('an inner send that never settles keeps the pass pending and the fence held past the read deadline', async () => {
    const [first, second] = twoTabs();
    pendingTransport(first);
    const running = first.settled(first.runPass({ stages: [{ name: 'dispatch', send: earlySend(first) }] }));
    await settle();
    first.clock.advance(READ_DEADLINE_MS + 1);
    await settle();
    assert.ok(await isPending(running), 'the read budget does not refuse the pending send');
    assert.equal(await first.fenceIsFree(), false);
    assert.deepEqual([second.counts.signer, second.counts.transport], [0, 0]);
  });

  await t.test('a send that settles as the callback returns still ends acknowledged with no extra wait', async () => {
    const [first] = twoTabs();
    const { value } = await first.settled(first.runPass());
    assert.equal(value.outcomes[0].state, 'acknowledged');
    assert.ok(await first.fenceIsFree());
  });
});
