// K0 on the browser's effect boundary (public/portal/embedded-wallet/effect-boundary.mjs):
// the actor fence, the aggregate read deadline, EB5r/EB8f final checks and the EB signer/transmitter.
// Evidence: instrumented in-process doubles (controllable clock, Web Locks manager, in-memory record store
// honouring the store contract). No real Chrome and no real IndexedDB; the durable store is P53b1b's.
// K0-F10 is the test for the connection replacement below. K0-B12, F15, F19 and F7's compensation branch
// do not apply to a browser lane (no packed archive, no K1 revision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebSign, ebTransmit } from '../../public/portal/embedded-wallet/effect-boundary.mjs';
import { createWorld } from '../helpers/effect-boundary-doubles.mjs';
import { createGate, settle } from '../helpers/wallet-fence-doubles.mjs';

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

  await t.test('hostile: a first stage that returns while its transmission is still pending ends confirm-unknown and broadcast never runs', async () => {
    const world = createWorld();
    let failTransmission;
    world.behavior.transport = () => (world.counts.transport === 1 ? new Promise((resolve, reject) => { failTransmission = reject; }) : { accepted: true });
    const { value } = await world.settled(world.runPass({
      sign: (armed) => world.sign(armed),
      stages: [
        { name: 'confirm', send: async (armed, bytes) => { world.send(armed, bytes).catch(() => undefined); await settle(); return { queued: true }; } },
        { name: 'broadcast', send: world.send },
      ],
    }));
    assert.deepEqual(value.outcomes.map(({ stage, state }) => [stage, state]), [['confirm', 'unknown']]);
    assert.equal(value.outcomes[0].cause.code, 'eb_transmission_unfinished');
    assert.equal(world.counts.transport, 1);
    failTransmission(new Error('confirmation rejected after the callback returned'));
    await settle();
    assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'confirm-started', 'confirm-unknown']);
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

// The same store, but its head names the given stage (or none): the pass must not take its first stage from a head that omits it.
const withLastStage = (records, lastStage) => ({
  head: async (lane) => ({ ...(await records.head(lane)), lastStage }),
  append: (...args) => records.append(...args),
});

test('K0-F8 a resume takes the held stage from the record kind, so a store head without or with another lastStage cannot skip it', async (t) => {
  const resume = async (row, lastStage, names) => {
    const first = createWorld();
    row.prepare(first);
    await first.settled(first.runPass({ stages: row.stages.map((name) => ({ name, send: first.send })) }));
    first.records.beforeCommit.clear();
    first.records.failures.clear();
    const before = first.records.kinds('lane-1').length;
    const resumed = createWorld({ records: withLastStage(first.records, lastStage) });
    const { error } = await resumed.settled(resumed.runPass({
      retained: { bytes: new Uint8Array(first.SIGNED_BYTES) }, sign: undefined, stages: names.map((name) => ({ name, send: resumed.send })),
    }));
    return { error, resumed, appended: first.records.kinds('lane-1').length - before };
  };
  for (const row of heldStageLanes) {
    // `named` rows end in `<stage>-withheld`; the other row ends in `signed-held`, whose stage only the head carries.
    const named = row.name !== 'confirm-acknowledged and signed-held for broadcast';
    for (const name of ['dispatch', 'confirm', 'broadcast']) {
      const accepted = named && name === row.held;
      await t.test(`a lane holding ${row.name}, head without lastStage, ${accepted ? `transmits ${name} once` : `refuses a resume of ${name} eb_resume_not_allowed with transport 0`}`, async () => {
        const { error, resumed, appended } = await resume(row, undefined, [name]);
        if (accepted) {
          assert.equal(error, undefined);
          assert.equal(resumed.counts.transport, 1);
        } else {
          assertRefusal(error, 'eb_resume_not_allowed');
          assert.deepEqual([resumed.counts.signer, resumed.counts.transport, appended], [0, 0, 0]);
        }
      });
    }
    if (named) {
      await t.test(`a lane holding ${row.name}, head naming another stage, refuses a resume of ${row.held} eb_resume_not_allowed with transport 0`, async () => {
        const { error, resumed } = await resume(row, row.held === 'dispatch' ? 'confirm' : 'dispatch', [row.held]);
        assertRefusal(error, 'eb_resume_not_allowed');
        assert.deepEqual([resumed.counts.signer, resumed.counts.transport], [0, 0]);
      });
    }
  }

  const signedOnly = { name: 'only a signed record before confirm', stages: ['confirm', 'broadcast'], prepare: (w) => w.records.failures.set('confirm-started', new Error('disk full')) };
  await t.test('a lane holding only a signed record refuses a resume that starts at broadcast eb_resume_not_allowed with transport 0', async () => {
    const { error, resumed, appended } = await resume(signedOnly, undefined, ['broadcast']);
    assertRefusal(error, 'eb_resume_not_allowed');
    assert.deepEqual([resumed.counts.signer, resumed.counts.transport, appended], [0, 0, 0]);
  });
  await t.test('a lane holding only a signed record transmits confirm once when the resume starts there', async () => {
    const { error, resumed } = await resume(signedOnly, undefined, ['confirm']);
    assert.equal(error, undefined);
    assert.equal(resumed.counts.transport, 1);
  });
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

// A store whose head is the given one; appends are counted and accepted in sequence.
function craftedRecords(head) {
  const appended = [];
  return { appended, head: async () => ({ revision: 3, ...head }), append: async (lane, revision, record) => { appended.push(record.kind); return { revision: revision + 1 }; } };
}

// Written independently of the module's table: workflow, newest kind, lastStage ('-' for none), the tuple a resume runs.
const ALLOWED_RESUMES = new Set([
  'dispatch signed - dispatch', 'dispatch signed-held dispatch dispatch', 'dispatch dispatch-withheld - dispatch', 'dispatch dispatch-withheld dispatch dispatch',
  'confirm-broadcast signed - confirm', 'confirm-broadcast signed - confirm+broadcast',
  'confirm-broadcast signed-held confirm confirm', 'confirm-broadcast signed-held confirm confirm+broadcast',
  'confirm-broadcast confirm-withheld - confirm', 'confirm-broadcast confirm-withheld - confirm+broadcast',
  'confirm-broadcast confirm-withheld confirm confirm', 'confirm-broadcast confirm-withheld confirm confirm+broadcast',
  'confirm-broadcast signed-held broadcast broadcast', 'confirm-broadcast broadcast-withheld - broadcast', 'confirm-broadcast broadcast-withheld broadcast broadcast',
]);

test('K0-F8 every workflow, newest record and requested tuple outside the resume table sends nothing and appends nothing', async () => {
  const stageNames = ['dispatch', 'confirm', 'broadcast'];
  const kinds = ['signed', 'signed-held', 'refund-withheld', 'constructor', undefined, ...stageNames.flatMap((name) => ['withheld', 'started', 'unknown', 'acknowledged'].map((end) => `${name}-${end}`))];
  const mismatches = [];
  let allowedRuns = 0;
  for (const workflow of ['dispatch', 'confirm-broadcast', undefined, 'refund']) {
    for (const lastKind of kinds) {
      for (const lastStage of [undefined, ...stageNames]) {
        for (const names of [['dispatch'], ['confirm'], ['broadcast'], ['confirm', 'broadcast']]) {
          const world = createWorld({ records: craftedRecords({ lastKind, lastStage, signedWorkflow: workflow, signedBytes: new Uint8Array([7, 8, 9, 10]) }) });
          const { error } = await world.settled(world.runPass({ retained: { bytes: new Uint8Array(world.SIGNED_BYTES) }, sign: undefined, stages: stagesOf(world, names) }));
          const key = `${workflow} ${lastKind} ${lastStage ?? '-'} ${names.join('+')}`;
          const allowed = ALLOWED_RESUMES.has(key);
          const expected = allowed
            ? { code: undefined, counts: [0, names.length], appended: names.flatMap((name) => [`${name}-started`, `${name}-acknowledged`]) }
            : { code: 'eb_resume_not_allowed', counts: [0, 0], appended: [] };
          const actual = { code: error?.code, counts: [world.counts.signer, world.counts.transport], appended: world.records.appended };
          if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ key, actual, expected });
          allowedRuns += allowed ? 1 : 0;
        }
      }
    }
  }
  assert.deepEqual(mismatches, []);
  assert.equal(allowedRuns, ALLOWED_RESUMES.size, 'every allowed row was exercised');
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
  const points = [...[1, 2, 3, 4, 5].map((call) => ['stop', call]), ...[1, 2, 3].map((call) => ['authority', call]), ['commit', 'signed'], ['commit', 'dispatch-started']];
  for (const [kind, call] of points) {
    await t.test(`the request changed inside ${kind} ${call}`, async () => {
      const world = createWorld();
      let foreign = 0;
      const request = world.request({});
      const tamper = () => {
        request.stages[0].name = 'broadcast';
        request.stages[0].send = async () => { foreign += 1; };
        request.stages.push({ name: 'dispatch', send: world.send });
        request.sign = async () => { foreign += 1; };
        request.lane = 'lane-other';
      };
      if (kind === 'commit') world.records.beforeCommit.set(call, tamper); else world.on(kind, call, tamper);
      const { error } = await world.settled(world.boundary.runPass(request));
      assert.equal(error, undefined);
      assert.deepEqual([world.counts.signer, world.counts.transport, foreign], [1, 1, 0]);
      assert.deepEqual(world.records.kinds('lane-1'), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
      assert.deepEqual(world.records.kinds('lane-other'), []);
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
