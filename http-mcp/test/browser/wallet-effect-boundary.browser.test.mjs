// K0 on the browser's effect boundary (public/portal/embedded-wallet/effect-boundary.mjs):
// the actor fence, the aggregate read deadline, EB5r/EB8f final checks and the EB signer/transmitter.
// Evidence: instrumented in-process doubles (controllable clock, Web Locks manager, in-memory record store
// honouring the store contract). No real Chrome and no real IndexedDB; the durable store is P53b1b's.
// K0-F10 is the test for the connection replacement below. K0-B12, F15, F19 and F7's compensation branch
// do not apply to a browser lane (no packed archive, no K1 revision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebSign, ebTransmit } from '../../public/portal/embedded-wallet/effect-boundary.mjs';
import { createGate, createWorld, settle } from '../helpers/effect-boundary-doubles.mjs';

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
