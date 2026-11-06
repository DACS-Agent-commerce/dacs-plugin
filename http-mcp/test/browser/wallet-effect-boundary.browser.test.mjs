// K0 on the browser's effect boundary (public/portal/embedded-wallet/effect-boundary.mjs):
// the actor fence, the aggregate read deadline, EB5r/EB8f final checks and the EB signer/transmitter.
// Evidence: instrumented in-process doubles (controllable clock, Web Locks manager, in-memory record store
// honouring the store contract). No real Chrome. The durable records (effect-records.mjs) run over an in-memory
// IndexedDB double that models transaction lifecycle, durability, aborts and kill cuts (test/helpers/indexeddb-double.mjs).
// K0-F10 is the test for the connection replacement below. K0-B12, F15, F19 and F7's compensation branch
// do not apply to a browser lane (no packed archive, no K1 revision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebSign, ebTransmit } from '../../public/portal/embedded-wallet/effect-boundary.mjs';
import { createDurableEffectBoundary, createDurableRecordStore, deriveDispatchHistory, MAX_LANE_RECORDS, MAX_SIGNED_BYTES } from '../../public/portal/embedded-wallet/effect-records.mjs';
import { createGate, createWorld, settle } from '../helpers/effect-boundary-doubles.mjs';
import { createFakeIndexedDb } from '../helpers/indexeddb-double.mjs';

const READ_DEADLINE_MS = 10_000;
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

const isPending = async (promise) => (await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])) === 'pending';

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
        nested.push(await world.settled(world.boundary.runPass(world.request({ lane: 'lane-nested', capability: armed.capability, stages: [] }))));
        return bytes;
      },
    }));
    assert.equal(error, undefined);
    assert.equal(nested[0].error, undefined);
    assert.equal(world.counts.lockRequests, 1);
    assert.equal(world.counts.signer, 2);
    assert.deepEqual(world.records.kinds('lane-nested'), ['signed']);
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

  await t.test('K0-B8 a release by a non-owner has no effect; the owner still holds the fence', async () => {
    const world = createWorld();
    let waiter;
    await world.fence.run('op-1', async (capability) => {
      assert.equal(world.fence.release(capability, 'op-2'), false, 'another operation');
      assert.equal(world.fence.release({ operationId: 'op-1' }, 'op-1'), false, 'a forged capability');
      waiter = world.fence.run('op-3', async () => 'acquired');
      await settle();
      assert.ok(await isPending(waiter), 'the owner still holds it');
    });
    assert.equal(await waiter, 'acquired');
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

  await t.test('a replacement that throws still bumps the generation and releases the fence', async () => {
    const world = createWorld();
    const failure = new Error('reconnect failed');
    await assert.rejects(world.fence.replaceConnection(async () => { throw failure; }), failure);
    assert.equal(world.fence.connectionGeneration, 1);
    assert.ok(await world.fenceIsFree());
  });

  await t.test('only a fenced replacement can change the generation', () => {
    const world = createWorld();
    assert.throws(() => { world.fence.connectionGeneration = 5; }, TypeError);
    assert.equal(world.fence.connectionGeneration, 0);
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

  await t.test('a send step that signs again after the bytes were persisted is refused and the signer is not called', async () => {
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
    assertRefusal(error, 'eb_signer_repeated');
    assert.deepEqual([resumed.counts.signer, resumed.counts.transport], [0, 0]);
  });

  await t.test('a sign step that sends before the bytes are persisted is refused eb_bytes_mismatch', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ sign: async (armed) => { await world.sign(armed); return world.send(armed, new Uint8Array(world.SIGNED_BYTES)); } }));
    assertRefusal(error, 'eb_bytes_mismatch');
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

// Each row leaves a lane in a state, then a second pass asks to resume that lane's retained bytes.
const laneStates = [
  { name: 'only a signed record (the crash came before the intent)', resumable: true, prepare: (w) => w.records.failures.set('dispatch-started', new Error('disk full')) },
  { name: 'signed-held (EB7 refused)', resumable: true, prepare: (w) => w.records.beforeCommit.set('signed', () => { w.state.admission = 'profile_not_admitted'; }) },
  { name: 'dispatch-withheld (EB8f refused)', resumable: true, prepare: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.killed = true; }) },
  { name: 'dispatch-started and no answer (a crash during the send)', resumable: false, prepare: (w) => w.records.failures.set('dispatch-acknowledged', new Error('tab closed')) },
  { name: 'dispatch-unknown (the answer was lost)', resumable: false, prepare: (w) => { w.behavior.transport = async () => { throw new Error('socket reset'); }; } },
  { name: 'dispatch-acknowledged', resumable: false, prepare: () => {} },
];

test('K0-F8 a lane\'s records decide whether a pass may sign or resume its retained bytes', async (t) => {
  for (const row of laneStates) {
    const verdict = row.resumable ? 'transmits the retained bytes once' : 'is refused eb_resume_not_allowed with transport 0';
    await t.test(`resuming a lane that holds ${row.name} ${verdict}`, async () => {
      const first = createWorld();
      row.prepare(first);
      await first.settled(first.runPass());
      first.records.failures.clear();
      first.records.beforeCommit.clear();
      const before = first.records.kinds('lane-1').length;
      const restarted = createWorld({ records: first.records });
      const { error } = await restarted.settled(restarted.runPass({ retained: { bytes: new Uint8Array(first.SIGNED_BYTES) }, sign: undefined }));
      if (row.resumable) {
        assert.equal(error, undefined);
        assert.equal(restarted.counts.transport, 1);
      } else {
        assertRefusal(error, 'eb_resume_not_allowed');
        assert.equal(restarted.counts.transport, 0);
        assert.equal(first.records.kinds('lane-1').length, before, 'nothing was appended');
      }
      assert.equal(restarted.counts.signer, 0);
    });
  }

  await t.test('retained bytes on an empty lane are refused eb_resume_not_allowed with signer 0 and transport 0', async () => {
    const world = createWorld();
    const { error } = await world.settled(world.runPass({ retained: { bytes: new Uint8Array([99]) }, sign: undefined }));
    assertRefusal(error, 'eb_resume_not_allowed');
    assert.deepEqual([world.counts.signer, world.counts.transport], [0, 0]);
    assert.deepEqual(world.records.kinds('lane-1'), []);
  });

  await t.test('retained bytes that differ from the lane\'s signed record are refused eb_resume_not_allowed', async () => {
    const first = createWorld();
    first.records.beforeCommit.set('dispatch-started', () => { first.state.killed = true; });
    await first.settled(first.runPass());
    first.records.beforeCommit.clear();
    const restarted = createWorld({ records: first.records });
    const { error } = await restarted.settled(restarted.runPass({ retained: { bytes: new Uint8Array([99]) }, sign: undefined }));
    assertRefusal(error, 'eb_resume_not_allowed');
    assert.equal(restarted.counts.transport, 0);
  });

  await t.test('a store head that cannot prove the last record is refused eb_persist_failed', async () => {
    const world = createWorld();
    world.records.head = async () => ({ revision: 'one' });
    const { error } = await world.settled(world.runPass());
    assertRefusal(error, 'eb_persist_failed');
    assert.equal(world.counts.signer, 0);
  });

  for (const row of laneStates) {
    await t.test(`a new signing pass on a lane that holds ${row.name} is refused eb_lane_not_empty with signer 1 in total`, async () => {
      const first = createWorld();
      row.prepare(first);
      await first.settled(first.runPass());
      first.records.failures.clear();
      first.records.beforeCommit.clear();
      const before = first.records.kinds('lane-1').length;
      const second = createWorld({ records: first.records });
      const { error } = await second.settled(second.runPass());
      assertRefusal(error, 'eb_lane_not_empty');
      assert.deepEqual([first.counts.signer + second.counts.signer, second.counts.transport], [1, 0]);
      assert.equal(first.records.kinds('lane-1').length, before);
    });
  }
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

// Each row leaves a two-stage lane at a stage that was held or withheld, then a second pass resumes it.
const heldStageLanes = [
  { name: 'confirm-acknowledged and broadcast-withheld', stages: ['confirm', 'broadcast'], held: 'broadcast', prepare: (w) => w.records.beforeCommit.set('broadcast-started', () => { w.state.killed = true; }) },
  { name: 'confirm-acknowledged and signed-held for broadcast', stages: ['confirm', 'broadcast'], held: 'broadcast', prepare: (w) => w.records.beforeCommit.set('confirm-acknowledged', () => { w.state.admission = 'profile_not_admitted'; }) },
  { name: 'confirm-withheld', stages: ['confirm', 'broadcast'], held: 'confirm', prepare: (w) => w.records.beforeCommit.set('confirm-started', () => { w.state.killed = true; }) },
  { name: 'dispatch-withheld', stages: ['dispatch'], held: 'dispatch', prepare: (w) => w.records.beforeCommit.set('dispatch-started', () => { w.state.killed = true; }) },
];

test('K0-F8 a resume starts at the stage the lane held or withheld and never re-sends a stage the lane shows as sent', async (t) => {
  for (const row of heldStageLanes) {
    const resume = async (names, check) => {
      const first = createWorld();
      row.prepare(first);
      await first.settled(first.runPass({ stages: row.stages.map((name) => ({ name, send: first.send })) }));
      first.records.beforeCommit.clear();
      const before = first.records.kinds('lane-1').length;
      const resumed = createWorld({ records: first.records });
      const { error } = await resumed.settled(resumed.runPass({
        retained: { bytes: new Uint8Array(first.SIGNED_BYTES) }, sign: undefined, stages: names.map((name) => ({ name, send: resumed.send })),
      }));
      await check({ error, resumed, records: first.records, before });
    };

    await t.test(`a lane holding ${row.name} transmits ${row.held} once when the resume starts there`, () => resume([row.held], ({ error, resumed, records }) => {
      assert.equal(error, undefined);
      assert.equal(resumed.counts.transport, 1);
      assert.equal(records.kinds('lane-1').at(-1), `${row.held}-acknowledged`);
    }));

    const others = ['dispatch', 'confirm', 'broadcast'].filter((name) => name !== row.held).map((name) => [name]);
    if (row.held === 'broadcast') others.push(['confirm', 'broadcast']);
    for (const names of others) {
      await t.test(`a lane holding ${row.name} refuses a resume of ${names.join(', ')} eb_resume_not_allowed with transport 0`, () => resume(names, ({ error, resumed, records, before }) => {
        assertRefusal(error, 'eb_resume_not_allowed');
        assert.deepEqual([resumed.counts.signer, resumed.counts.transport], [0, 0]);
        assert.equal(records.kinds('lane-1').length, before, 'nothing was appended');
      }));
    }
  }
});

// ---- P53b1b: the durable lane records (effect-records.mjs) over an in-memory IndexedDB double ----

const LANE = 'lane-1';
const SIGNED = [7, 8, 9, 10];
const TX_STAGES = ['confirm', 'broadcast'];
const onKind = (kind) => (written) => written.some((record) => record.kind === kind);
const kindsOf = (idb) => idb.committedRecords(LANE).map((record) => record.kind);
const causeMessages = (error) => {
  const messages = [];
  for (let current = error; current; current = current.cause) messages.push(String(current.message));
  return messages;
};

async function untilKilled(idb) {
  for (let turn = 0; turn < 100 && !idb.dead; turn += 1) await settle();
  assert.ok(idb.dead, 'the process was killed at the cut');
}

// One browser process: a world (its own tab, clock and Web Locks) whose pass writes to the durable records in `idb`.
let processCount = 0;
function startProcess(idb, overrides) {
  const world = createWorld(overrides);
  const processNumber = (processCount += 1);
  let passNumber = 0;
  const durable = createDurableEffectBoundary({
    indexedDB: idb, locks: world.locks, fence: world.fence, checks: world.checks, clock: world.clock, newPassId: () => `process-${processNumber}-pass-${(passNumber += 1)}`,
  });
  return { ...world, durable, store: durable.records, run: (request) => durable.runPass(world.request(request)) };
}

const stagesOf = (proc, names) => names.map((name) => ({ name, send: proc.send }));
const resume = (proc, bytes, names) => proc.settled(proc.run({ retained: { bytes: Uint8Array.from(bytes) }, sign: undefined, stages: stagesOf(proc, names) }));
const laneRecord = (kind, passId, extra = {}) => ({ operationId: 'op-1', lane: LANE, pinVersion: 'pin-1', approvalRevision: 'approval-1', passId, kind, ...extra });
const signedRecord = (passId = 'pass-a') => laneRecord('signed', passId, { bytes: new Uint8Array(SIGNED) });

const crashRows = [
  {
    name: 'K0-P1 killed after the signer returned and before the signed bytes committed: nothing retained, nothing sent, the next attempt signs again',
    arrange: (idb) => idb.cutAt(onKind('signed'), 'before'), killed: true, kinds: [], transport: 0,
    async restart(next) {
      assert.equal((await next.store.head(LANE)).signedBytes, undefined);
      return next.settled(next.run());
    },
    finalKinds: ['signed', 'dispatch-started', 'dispatch-acknowledged'], nextSigner: 1, nextTransport: 1,
  },
  {
    name: 'K0-P2 a failed signed-bytes write refuses eb_persist_failed with its cause and sends nothing',
    arrange: (idb) => idb.abortAt(onKind('signed'), new Error('EIO: write failed')), error: 'eb_persist_failed', cause: /EIO/, kinds: [], transport: 0,
    finalKinds: [],
  },
  {
    name: 'K0-P3 killed after the signed bytes committed and before the dispatch intent: a fresh pass sends the persisted bytes once',
    arrange: (idb) => idb.cutAt(onKind('dispatch-started'), 'before'), killed: true, kinds: ['signed'], transport: 0,
    async restart(next) {
      const { signedBytes } = await next.store.head(LANE);
      assert.deepEqual([...signedBytes], SIGNED);
      return resume(next, signedBytes, ['dispatch']);
    },
    finalKinds: ['signed', 'dispatch-started', 'dispatch-acknowledged'], nextTransport: 1, nextSent: SIGNED,
  },
  {
    name: 'K0-P4 a stop appearing between the signature and the dispatch intent holds the signed bytes, also after a restart',
    arrange: (idb, proc) => proc.on('stop', 4, () => { proc.state.killed = true; }), error: 'writes_stopped', kinds: ['signed', 'signed-held'], transport: 0,
    async restart(next) {
      const history = deriveDispatchHistory(await next.store.history(LANE));
      assert.equal(history.neverDispatched, true);
      assert.equal((await next.store.head(LANE)).lastKind, 'signed-held');
    },
    finalKinds: ['signed', 'signed-held'],
  },
  {
    name: 'K0-P5 killed after the dispatch intent committed and before the transport call: the intent stays unknown and nothing is sent again',
    arrange: (idb) => idb.cutAt(onKind('dispatch-started'), 'after'), killed: true, kinds: ['signed', 'dispatch-started'], transport: 0,
    async restart(next) {
      assert.equal(deriveDispatchHistory(await next.store.history(LANE)).neverDispatched, false);
      return resume(next, SIGNED, ['dispatch']);
    },
    resumeError: 'eb_resume_not_allowed', finalKinds: ['signed', 'dispatch-started'],
  },
  {
    name: 'K0-P6 the receiver took the bytes and the transport threw: dispatch-unknown with its cause, a readback records observed, transport 1 in total',
    arrange: (idb, proc) => { proc.behavior.transport = async () => { throw new Error('connection reset after the receiver took the bytes'); }; },
    outcome: 'unknown', kinds: ['signed', 'dispatch-started', 'dispatch-unknown'], transport: 1,
    async restart(next) {
      const { revision } = await next.store.head(LANE);
      await next.store.append(LANE, revision, laneRecord('observed', 'readback'));
    },
    finalKinds: ['signed', 'dispatch-started', 'dispatch-unknown', 'observed'],
  },
  {
    name: 'K0-P7 killed after the transmission and before the acknowledgement: unknown, transport 1 in total, no second send after the restart',
    arrange: (idb) => idb.cutAt(onKind('dispatch-acknowledged'), 'before'), killed: true, kinds: ['signed', 'dispatch-started'], transport: 1,
    async restart(next) {
      return resume(next, SIGNED, ['dispatch']);
    },
    resumeError: 'eb_resume_not_allowed', finalKinds: ['signed', 'dispatch-started'],
  },
  {
    name: 'K0-P8 killed after the confirmation was acknowledged and before the broadcast intent: one broadcast of the original bytes, no new signature',
    stages: TX_STAGES, arrange: (idb) => idb.cutAt(onKind('broadcast-started'), 'before'), killed: true,
    kinds: ['signed', 'confirm-started', 'confirm-acknowledged'], transport: 1,
    async restart(next) {
      assert.equal(deriveDispatchHistory(await next.store.history(LANE)).mayBroadcast, true);
      return resume(next, (await next.store.head(LANE)).signedBytes, ['broadcast']);
    },
    finalKinds: ['signed', 'confirm-started', 'confirm-acknowledged', 'broadcast-started', 'broadcast-acknowledged'], nextTransport: 1, nextSent: SIGNED,
  },
  {
    name: 'K0-P9 the confirmation answer was lost: confirm-unknown, never advanced to broadcast, never reported unsent',
    stages: TX_STAGES, arrange: (idb, proc) => { proc.behavior.transport = async () => { throw new Error('the confirmation answer was lost'); }; },
    outcome: 'unknown', kinds: ['signed', 'confirm-started', 'confirm-unknown'], transport: 1,
    async restart(next) {
      const history = deriveDispatchHistory(await next.store.history(LANE));
      assert.deepEqual([history.confirmation, history.mayBroadcast], ['unknown', false]);
      return resume(next, SIGNED, ['broadcast']);
    },
    resumeError: 'eb_resume_not_allowed', finalKinds: ['signed', 'confirm-started', 'confirm-unknown'],
  },
];

test('K0-P1 to K0-P9 on the browser boundary give the contract\'s durable states and transport counts', async (t) => {
  for (const row of crashRows) {
    await t.test(row.name, async () => {
      const idb = createFakeIndexedDb();
      const first = startProcess(idb);
      row.arrange(idb, first);
      const running = first.run({ stages: stagesOf(first, row.stages ?? ['dispatch']) });
      let outcome;
      if (row.killed) await untilKilled(idb);
      else outcome = await first.settled(running);
      assert.deepEqual(kindsOf(idb), row.kinds, 'records committed before the restart');
      assert.equal(first.counts.transport, row.transport);
      if (row.error) {
        assertRefusal(outcome.error, row.error);
        if (row.cause) assert.ok(causeMessages(outcome.error).some((message) => row.cause.test(message)), `the cause is kept: ${causeMessages(outcome.error)}`);
      }
      if (row.outcome) assert.equal(outcome.value.outcomes.at(-1).state, row.outcome);

      const next = startProcess(idb.restart());
      const resumed = await row.restart?.(next);
      if (row.resumeError) assertRefusal(resumed.error, row.resumeError);
      else if (resumed) assert.equal(resumed.error, undefined);
      assert.deepEqual(kindsOf(idb), row.finalKinds, 'records after the restart');
      assert.equal(next.counts.signer, row.nextSigner ?? 0);
      assert.equal(next.counts.transport, row.nextTransport ?? 0);
      if (row.nextSent) assert.deepEqual(next.sent.map((bytes) => [...bytes]), [row.nextSent]);
    });
  }
});

// The exact bytes and each stage's intent are committed, in completed strict transactions, before the request leaves.
function recordWhatLeaves(idb, snapshots) {
  return (armed, bytes) => ebTransmit(async (sent) => {
    const records = idb.committedRecords(LANE);
    snapshots.push({ kinds: records.map((record) => record.kind), signed: records[0]?.bytes, sent, openTransactions: idb.openTransactionCount() });
    return { accepted: true };
  }, armed)(bytes);
}

test('the exact signed transaction bytes are committed in a strict-durability transaction that has completed before the confirmation request leaves, a failed bytes or confirmation-intent commit refuses eb_persist_failed with no egress, and the confirmation\'s own intent is committed before its request leaves so a kill at that cut leaves confirm-started and never just signed', async (t) => {
  const arrange = () => {
    const idb = createFakeIndexedDb();
    const proc = startProcess(idb);
    const snapshots = [];
    const stages = TX_STAGES.map((name) => ({ name, send: recordWhatLeaves(idb, snapshots) }));
    return { idb, proc, snapshots, stages };
  };

  await t.test('both stages leave only behind committed bytes and their own committed intent', async () => {
    const { idb, proc, snapshots, stages } = arrange();
    await proc.run({ stages });
    assert.deepEqual(snapshots.map((snapshot) => snapshot.kinds), [['signed', 'confirm-started'], ['signed', 'confirm-started', 'confirm-acknowledged', 'broadcast-started']]);
    for (const snapshot of snapshots) {
      assert.deepEqual([...snapshot.signed], [...snapshot.sent], 'the persisted bytes are the bytes sent');
      assert.equal(snapshot.openTransactions, 0, 'no transaction is open while the request is out');
    }
    const writes = idb.transactions.filter((tx) => tx.mode === 'readwrite' && tx.writes.length > 0);
    assert.equal(writes.length, 5);
    assert.ok(writes.every((tx) => tx.durability === 'strict' && tx.state === 'committed'));
  });

  for (const kind of ['signed', 'confirm-started']) {
    await t.test(`a failed ${kind} commit refuses eb_persist_failed and nothing leaves`, async () => {
      const { idb, proc, snapshots, stages } = arrange();
      idb.abortAt(onKind(kind), new Error('QuotaExceededError'));
      const { error } = await proc.settled(proc.run({ stages }));
      assertRefusal(error, 'eb_persist_failed');
      assert.deepEqual(snapshots, []);
      assert.equal(proc.counts.transport, 0);
      assert.deepEqual(kindsOf(idb), kind === 'signed' ? [] : ['signed']);
    });
  }

  await t.test('a kill after the confirmation request left leaves confirm-started, which is an unknown confirmation and not just signed', async () => {
    const { idb, proc, snapshots, stages } = arrange();
    idb.cutAt(onKind('confirm-acknowledged'), 'before');
    proc.run({ stages });
    await untilKilled(idb);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(kindsOf(idb), ['signed', 'confirm-started']);
    const history = deriveDispatchHistory(await startProcess(idb.restart()).store.history(LANE));
    assert.deepEqual([history.confirmation, history.mayBroadcast], ['unknown', false]);
  });
});

test('an effect-authorizing message signature is durable before it is submitted', async () => {
  const idb = createFakeIndexedDb();
  const proc = startProcess(idb);
  const snapshots = [];
  await proc.run({ stages: [{ name: 'dispatch', send: recordWhatLeaves(idb, snapshots) }] });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].kinds, ['signed', 'dispatch-started']);
  assert.deepEqual([...snapshots[0].signed], [...snapshots[0].sent]);
  assert.deepEqual(kindsOf(idb), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
});

test('confirmation and broadcast are separate stages, an unknown confirmation including an unmatched confirm-started never advances to broadcast, and a later withheld pass never erases an earlier possible dispatch', async (t) => {
  await t.test('an acknowledged confirmation alone leaves the broadcast for a later pass', async () => {
    const idb = createFakeIndexedDb();
    const proc = startProcess(idb);
    await proc.run({ stages: stagesOf(proc, ['confirm']) });
    assert.deepEqual(kindsOf(idb), ['signed', 'confirm-started', 'confirm-acknowledged']);
    assert.deepEqual(deriveDispatchHistory(await proc.store.history(LANE)), { signed: true, neverDispatched: true, confirmation: 'acknowledged', mayBroadcast: true });
  });

  await t.test('an unmatched confirm-started is unknown, a later pass\'s acknowledgement does not clear it, and no broadcast follows', async () => {
    const store = createDurableRecordStore({ indexedDB: createFakeIndexedDb(), locks: {} });
    await store.append(LANE, 0, signedRecord('pass-a'));
    await store.append(LANE, 1, laneRecord('confirm-started', 'pass-a', { stage: 'confirm' }));
    assert.equal(deriveDispatchHistory(await store.history(LANE)).confirmation, 'unknown');
    await store.append(LANE, 2, laneRecord('confirm-started', 'pass-b', { stage: 'confirm' }));
    await store.append(LANE, 3, laneRecord('confirm-acknowledged', 'pass-b', { stage: 'confirm' }));
    const history = deriveDispatchHistory(await store.history(LANE));
    assert.deepEqual([history.confirmation, history.mayBroadcast], ['unknown', false]);
  });

  await t.test('a pass asked to broadcast over a lane that ends in confirm-started refuses and sends nothing', async () => {
    const idb = createFakeIndexedDb();
    const store = createDurableRecordStore({ indexedDB: idb, locks: {} });
    await store.append(LANE, 0, signedRecord());
    await store.append(LANE, 1, laneRecord('confirm-started', 'pass-a', { stage: 'confirm' }));
    const proc = startProcess(idb);
    const { error } = await resume(proc, SIGNED, ['broadcast']);
    assertRefusal(error, 'eb_resume_not_allowed');
    assert.equal(proc.counts.transport, 0);
  });

  await t.test('a later pass\'s withheld record does not clear an earlier dispatch intent, and an outcome from another pass is refused', async () => {
    const store = createDurableRecordStore({ indexedDB: createFakeIndexedDb(), locks: {} });
    await store.append(LANE, 0, signedRecord('pass-a'));
    await store.append(LANE, 1, laneRecord('dispatch-started', 'pass-a', { stage: 'dispatch' }));
    await assert.rejects(store.append(LANE, 2, laneRecord('dispatch-withheld', 'pass-b', { stage: 'dispatch' })), { code: 'eb_record_out_of_sequence' });
    await store.append(LANE, 2, laneRecord('dispatch-started', 'pass-b', { stage: 'dispatch' }));
    await store.append(LANE, 3, laneRecord('dispatch-withheld', 'pass-b', { stage: 'dispatch' }));
    assert.equal(deriveDispatchHistory(await store.history(LANE)).neverDispatched, false);
  });

  await t.test('intents that each have their own withheld record leave the lane never dispatched', async () => {
    const store = createDurableRecordStore({ indexedDB: createFakeIndexedDb(), locks: {} });
    await store.append(LANE, 0, signedRecord('pass-a'));
    await store.append(LANE, 1, laneRecord('dispatch-started', 'pass-a', { stage: 'dispatch' }));
    await store.append(LANE, 2, laneRecord('dispatch-withheld', 'pass-a', { stage: 'dispatch' }));
    assert.equal(deriveDispatchHistory(await store.history(LANE)).neverDispatched, true);
  });
});

test('with Web Locks or IndexedDB unavailable every effect refuses with a named error before any signer call', async (t) => {
  const erroringIndexedDb = { open() { const request = {}; queueMicrotask(() => { request.error = new Error('storage denied'); request.onerror(); }); return request; } };
  const throwingIndexedDb = { open() { throw new Error('SecurityError'); } };
  const rows = [
    { name: 'no Web Locks', options: () => ({ indexedDB: createFakeIndexedDb(), locks: null }), code: 'eb_web_locks_unavailable' },
    { name: 'no IndexedDB', options: (world) => ({ indexedDB: null, locks: world.locks }), code: 'eb_indexeddb_unavailable' },
    { name: 'IndexedDB open throws', options: (world) => ({ indexedDB: throwingIndexedDb, locks: world.locks }), code: 'eb_indexeddb_unavailable', cause: /SecurityError/ },
    { name: 'IndexedDB open fails', options: (world) => ({ indexedDB: erroringIndexedDb, locks: world.locks }), code: 'eb_indexeddb_unavailable', cause: /storage denied/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const world = createWorld();
      const durable = createDurableEffectBoundary({ fence: world.fence, checks: world.checks, clock: world.clock, ...row.options(world) });
      const { error } = await world.settled(durable.runPass(world.request()));
      assertRefusal(error, row.code);
      if (row.cause) assert.ok(causeMessages(error).some((message) => row.cause.test(message)));
      assert.deepEqual([world.counts.signer, world.counts.transport, world.counts.lockRequests], [0, 0, 0]);
    });
  }
});

test('each durable transition is its own short readwrite transaction that checks and advances the lane revision across real task-boundary awaits, no transaction is held across an authority, stop, signer or network await, and a revision conflict from another tab refuses with nothing transmitted', async (t) => {
  await t.test('every transition of a full pass is one strict transaction that adds one record and advances the head', async () => {
    const idb = createFakeIndexedDb();
    const proc = startProcess(idb);
    await proc.run({ stages: stagesOf(proc, TX_STAGES) });
    const transitions = idb.transactions.filter((tx) => tx.mode === 'readwrite' && tx.writes.length > 0);
    assert.equal(transitions.length, 5);
    for (const tx of transitions) {
      assert.deepEqual(tx.writes.map((write) => write.store), ['records', 'heads']);
      assert.equal(tx.durability, 'strict');
    }
    assert.deepEqual(idb.committedRecords(LANE).map((record) => record.seq), [1, 2, 3, 4, 5]);
  });

  await t.test('no transaction is open during any authority, stop, signer or network await', async () => {
    const idb = createFakeIndexedDb();
    const proc = startProcess(idb);
    const open = [];
    const probe = async () => { await settle(); open.push(idb.openTransactionCount()); };
    for (let call = 1; call <= 8; call += 1) { proc.on('stop', call, probe); proc.on('authority', call, probe); }
    const sign = async (armed) => { open.push(idb.openTransactionCount()); await settle(); return proc.sign(armed); };
    const send = (armed, bytes) => { open.push(idb.openTransactionCount()); return proc.send(armed, bytes); };
    await proc.run({ sign, stages: TX_STAGES.map((name) => ({ name, send })) });
    assert.ok(open.length >= 10, `probed ${open.length} awaits`);
    assert.ok(open.every((count) => count === 0), `open transactions at each await: ${open}`);
  });

  await t.test('a record written by another tab between the head read and the append is a revision conflict: eb_persist_failed, nothing transmitted, the other tab\'s record kept', async () => {
    const idb = createFakeIndexedDb();
    const tabA = startProcess(idb);
    const tabB = createDurableRecordStore({ indexedDB: idb, locks: {} });
    tabA.on('stop', 3, async () => { await tabB.append(LANE, 0, laneRecord('signed', 'other-tab', { bytes: new Uint8Array([1, 2]) })); });
    const { error } = await tabA.settled(tabA.run());
    assertRefusal(error, 'eb_persist_failed');
    assert.ok(causeMessages(error).some((message) => /expected 0/.test(message)), `cause: ${causeMessages(error)}`);
    assert.equal(tabA.counts.transport, 0);
    assert.deepEqual(idb.committedRecords(LANE).map((record) => [record.kind, record.passId]), [['signed', 'other-tab']]);
  });

  await t.test('a stale expected revision is refused eb_revision_conflict and changes nothing', async () => {
    const idb = createFakeIndexedDb();
    const store = createDurableRecordStore({ indexedDB: idb, locks: {} });
    await store.append(LANE, 0, signedRecord());
    await assert.rejects(store.append(LANE, 0, signedRecord('pass-b')), { code: 'eb_revision_conflict' });
    await assert.rejects(store.append(LANE, 5, laneRecord('observed', 'pass-b')), { code: 'eb_revision_conflict' });
    assert.deepEqual(idb.committedRecords(LANE).map((record) => record.passId), ['pass-a']);
  });

  const malformed = [
    ['an unknown kind', (record) => ({ ...record, kind: 'dispatch-done' }), 'eb_record_invalid'],
    ['a missing pass id', (record) => ({ ...record, passId: '' }), 'eb_record_invalid'],
    ['another lane', (record) => ({ ...record, lane: 'lane-2' }), 'eb_record_invalid'],
    ['a signed record without bytes', (record) => ({ ...record, bytes: undefined }), 'eb_record_invalid'],
    ['oversized signed bytes', (record) => ({ ...record, bytes: new Uint8Array(MAX_SIGNED_BYTES + 1) }), 'eb_record_invalid'],
    ['bytes on a held record', () => laneRecord('signed-held', 'pass-a', { stage: 'dispatch', bytes: new Uint8Array(SIGNED) }), 'eb_record_invalid'],
    ['a stage that differs from the kind', () => laneRecord('dispatch-started', 'pass-a', { stage: 'confirm' }), 'eb_record_invalid'],
    ['a second signed record', (record) => record, 'eb_record_out_of_sequence', true],
    ['an outcome without its intent', () => laneRecord('dispatch-acknowledged', 'pass-a', { stage: 'dispatch' }), 'eb_record_out_of_sequence', true],
  ];
  for (const [name, change, code, afterSigned] of malformed) {
    await t.test(`${name} is refused ${code} and the lane is unchanged`, async () => {
      const idb = createFakeIndexedDb();
      const store = createDurableRecordStore({ indexedDB: idb, locks: {} });
      if (afterSigned) await store.append(LANE, 0, signedRecord());
      const before = idb.committedRecords(LANE);
      await assert.rejects(store.append(LANE, before.length, change(signedRecord())), { code });
      assert.deepEqual(idb.committedRecords(LANE), before);
    });
  }

  await t.test('a record before the signed bytes is refused and a full lane refuses the next record', async () => {
    const store = createDurableRecordStore({ indexedDB: createFakeIndexedDb(), locks: {} });
    await assert.rejects(store.append(LANE, 0, laneRecord('observed', 'pass-a')), { code: 'eb_record_out_of_sequence' });
    await store.append(LANE, 0, signedRecord());
    for (let revision = 1; revision < MAX_LANE_RECORDS; revision += 1) await store.append(LANE, revision, laneRecord('observed', 'pass-a'));
    await assert.rejects(store.append(LANE, MAX_LANE_RECORDS, laneRecord('observed', 'pass-a')), { code: 'eb_lane_full' });
  });
});

test('a record whose request succeeds inside a transaction that then aborts is not counted as persisted: the pass refuses eb_persist_failed with no egress', async (t) => {
  for (const kind of ['signed', 'dispatch-started']) {
    await t.test(`${kind}`, async () => {
      const idb = createFakeIndexedDb();
      const proc = startProcess(idb);
      idb.abortAt(onKind(kind), new Error('the transaction was aborted'));
      const { error } = await proc.settled(proc.run());
      assertRefusal(error, 'eb_persist_failed');
      assert.ok(causeMessages(error).some((message) => /the transaction was aborted/.test(message)));
      const aborted = idb.transactions.find((tx) => tx.state === 'aborted');
      assert.ok(aborted.writes.some((write) => write.value.kind === kind), 'the add request had succeeded inside the aborted transaction');
      assert.equal(proc.counts.transport, 0);
      assert.deepEqual(kindsOf(idb), kind === 'signed' ? [] : ['signed']);
    });
  }
});

test('where an opened transaction does not report strict durability, every effect refuses eb_durability_unavailable before any signer call', async (t) => {
  await t.test('the pass', async () => {
    const idb = createFakeIndexedDb({ strictDurability: false });
    const proc = startProcess(idb);
    const { error } = await proc.settled(proc.run());
    assertRefusal(error, 'eb_durability_unavailable');
    assert.deepEqual([proc.counts.signer, proc.counts.transport, proc.counts.lockRequests], [0, 0, 0]);
    assert.deepEqual(kindsOf(idb), []);
  });

  await t.test('a single append', async () => {
    const idb = createFakeIndexedDb({ strictDurability: false });
    const store = createDurableRecordStore({ indexedDB: idb, locks: {} });
    await assert.rejects(store.append(LANE, 0, signedRecord()), { code: 'eb_durability_unavailable' });
    assert.deepEqual(kindsOf(idb), []);
  });
});

const COMMIT_ORDER = ['signed', 'confirm-started', 'confirm-acknowledged', 'broadcast-started', 'broadcast-acknowledged'];

test('a browser process killed before and after each record\'s commit leaves egress possible only behind committed exact bytes and a committed dispatch intent, and every earlier possible-dispatch record survives', async (t) => {
  for (const [index, kind] of COMMIT_ORDER.entries()) {
    for (const when of ['before', 'after']) {
      await t.test(`killed ${when} the commit of ${kind}`, async () => {
        const idb = createFakeIndexedDb();
        const proc = startProcess(idb);
        const snapshots = [];
        idb.cutAt(onKind(kind), when);
        proc.run({ stages: TX_STAGES.map((name) => ({ name, send: recordWhatLeaves(idb, snapshots) })) });
        await untilKilled(idb);
        const durable = COMMIT_ORDER.slice(0, index + (when === 'after' ? 1 : 0));
        assert.deepEqual(kindsOf(idb), durable);
        for (const snapshot of snapshots) {
          assert.deepEqual([...snapshot.signed], [...snapshot.sent], 'every transmission carried the committed bytes');
          assert.match(snapshot.kinds.at(-1), /-started$/, 'every transmission followed its committed intent');
        }
        const completed = COMMIT_ORDER.slice(0, index);
        assert.equal(snapshots.length, ['confirm-started', 'broadcast-started'].filter((started) => completed.includes(started)).length, 'a request leaves only after its intent\'s commit completed');

        const next = startProcess(idb.restart());
        const history = deriveDispatchHistory(await next.store.history(LANE));
        assert.equal(history.neverDispatched, !durable.includes('broadcast-started'), 'a committed broadcast intent survives as a possible dispatch');
        assert.equal(history.signed, durable.length > 0);
        assert.deepEqual([next.counts.signer, next.counts.transport], [0, 0], 'a restart sends nothing by itself');
      });
    }
  }
});
