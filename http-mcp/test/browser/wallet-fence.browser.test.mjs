// The per-wallet actor fence (K0 EB5) of the embedded browser wallet, on a fake clock and a fake Web Locks manager.
// K0-B5 (a late grant), K0-B6 (nested reuse), K0-B7 (a foreign capability), K0-B8 (owner-only release), K0-B9 (two
// overlapping operations) and K0-F10 (a fenced connection replacement) are the fence's share of the K0 vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EffectBoundaryRefusal,
  FENCE_TIMEOUT_MS,
  SYSTEM_CLOCK,
  createWalletFence,
  refuse,
  requireFunctions,
} from '../../public/portal/embedded-wallet/wallet-fence.mjs';
import { createFakeClock, createFakeLocks, createGate, settle } from '../helpers/wallet-fence-doubles.mjs';

function assertRefusal(error, code) {
  assert.equal(error?.name, 'EffectBoundaryRefusal', `expected a refusal, got ${error}`);
  assert.ok(error instanceof EffectBoundaryRefusal);
  assert.equal(error.code, code);
}

const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const isPending = async (promise) => (await Promise.race([promise.then(() => 'settled', () => 'settled'), Promise.resolve('pending')])) === 'pending';

// True once `promise` has settled after the microtask queue has drained; unlike `isPending` it sees through a wrapper.
async function hasSettled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await settle();
  return done;
}

function createTab({ clock = createFakeClock(), locks = createFakeLocks(), walletId = 'wallet-1', ...options } = {}) {
  const fence = createWalletFence({ locks, walletId, clock, ...options });
  const background = [];
  return {
    clock,
    locks,
    fence,
    background,
    // Holds the fence as `holderId` until `release()`.
    hold(holderId = 'holder') {
      const gate = createGate();
      background.push(fence.run(holderId, () => gate.promise));
      return { release: gate.open };
    },
    async isFree() {
      const probe = fence.run('probe', async () => 'free');
      await settle();
      return (await Promise.race([probe, Promise.resolve('held')])) === 'free';
    },
  };
}

test('FENCE_TIMEOUT_MS is 10,000 ms and is the default acquisition timeout', async () => {
  assert.equal(FENCE_TIMEOUT_MS, 10_000);
  const tab = createTab();
  tab.hold();
  await settle();
  const waiting = settled(tab.fence.run('op-2', async () => 'ran'));
  await settle();
  tab.clock.advance(FENCE_TIMEOUT_MS - 1);
  assert.ok(await isPending(waiting), 'still waiting one millisecond before the timeout');
  tab.clock.advance(1);
  assertRefusal((await waiting).error, 'tp1_fence_timeout');
});

test('K0-B9 two tabs sharing one wallet never interleave their sections, and a wait past 10,000 ms refuses tp1_fence_timeout with its cause', async () => {
  const tabA = createTab();
  const tabB = createTab({ clock: tabA.clock, locks: tabA.locks });
  const tabC = createTab({ clock: tabA.clock, locks: tabA.locks });
  const events = [];
  const inFlight = createGate();
  const section = (name, gate) => async () => {
    events.push(`${name}:start`);
    await gate;
    events.push(`${name}:end`);
  };

  const sectionA = settled(tabA.fence.run('op-a', section('a', inFlight.promise)));
  await settle();
  const sectionB = settled(tabB.fence.run('op-b', section('b')));
  const sectionC = settled(tabC.fence.run('op-c', section('c')));
  await settle();
  assert.deepEqual(events, ['a:start'], 'only the first tab is inside its section');

  tabA.clock.advance(FENCE_TIMEOUT_MS);
  for (const { error } of [await sectionB, await sectionC]) {
    assertRefusal(error, 'tp1_fence_timeout');
    assert.ok(error.cause, 'the abort reason is kept as the cause');
  }
  assert.deepEqual(events, ['a:start'], 'a timed-out wait never ran its section');

  inFlight.open();
  assert.equal((await sectionA).error, undefined);
  const later = await settled(tabB.fence.run('op-b2', section('b2')));
  assert.equal(later.error, undefined, 'a timed-out wait leaves the fence usable');
  assert.deepEqual(events, ['a:start', 'a:end', 'b2:start', 'b2:end']);
});

test('K0-B5 a fence grant that arrives after tp1_fence_timeout is released at once, runs nothing, and the next waiter acquires', async () => {
  const tab = createTab();
  tab.locks.ignoreAbort = true;
  const holder = tab.hold();
  await settle();
  let sections = 0;
  const late = settled(tab.fence.run('op-late', async () => { sections += 1; }));
  await settle();
  tab.clock.advance(FENCE_TIMEOUT_MS);
  assertRefusal((await late).error, 'tp1_fence_timeout');

  const next = settled(tab.fence.run('op-next', async () => 'acquired'));
  holder.release();
  assert.equal((await next).value, 'acquired');
  await Promise.all(tab.background);
  assert.equal(sections, 0, 'the late grant ran no work');
  assert.ok(await tab.isFree(), 'the late grant did not keep the lock');
});

// A clock whose time moves while its timers are delivered late: here they never fire, as when a busy page runs them
// after the lock manager has already granted.
function createLateTimerClock() {
  let nowMs = 0;
  return { now: () => nowMs, setTimer: () => () => {}, advance: (ms) => { nowMs += ms; } };
}

test('a grant that arrives once the wait has reached the timeout, before its timer was delivered, refuses tp1_fence_timeout with its cause, runs nothing and frees the fence', async () => {
  const tab = createTab({ clock: createLateTimerClock() });
  const holder = tab.hold();
  await settle();
  let sections = 0;
  const overdue = settled(tab.fence.run('op-overdue', async () => { sections += 1; }));
  await settle();
  tab.clock.advance(FENCE_TIMEOUT_MS + 1);
  holder.release();
  const { error } = await overdue;
  assertRefusal(error, 'tp1_fence_timeout');
  assert.ok(error.cause, 'the abort reason is kept as the cause');
  await Promise.all(tab.background);
  assert.equal(sections, 0, 'the overdue grant ran no work');
  assert.ok(await tab.isFree(), 'the overdue grant did not keep the lock');
});

test('a grant at exactly 10,000 ms of waiting is refused, and a grant one millisecond earlier runs', async () => {
  for (const [waitedMs, outcome] of [[FENCE_TIMEOUT_MS - 1, 'ran'], [FENCE_TIMEOUT_MS, undefined]]) {
    const tab = createTab({ clock: createLateTimerClock() });
    const holder = tab.hold();
    await settle();
    let ran;
    const waiting = settled(tab.fence.run('op-boundary', async () => { ran = 'ran'; }));
    await settle();
    tab.clock.advance(waitedMs);
    holder.release();
    const { error } = await waiting;
    if (outcome === 'ran') assert.equal(error, undefined, `granted after ${waitedMs} ms`);
    else assertRefusal(error, 'tp1_fence_timeout');
    assert.equal(ran, outcome, `after ${waitedMs} ms`);
  }
});

test('a connection replacement granted after the timeout is refused tp1_fence_timeout, replaces nothing and does not bump the generation', async () => {
  const tab = createTab({ clock: createLateTimerClock() });
  const holder = tab.hold();
  await settle();
  let replacements = 0;
  const overdue = settled(tab.fence.replaceConnection(async () => { replacements += 1; }));
  await settle();
  tab.clock.advance(FENCE_TIMEOUT_MS);
  holder.release();
  assertRefusal((await overdue).error, 'tp1_fence_timeout');
  await Promise.all(tab.background);
  assert.equal(replacements, 0);
  assert.equal(tab.fence.connectionGeneration, 0);
  assert.ok(await tab.isFree());
});

test('a lock request that rejects refuses eb_fence_failed with that error as the cause and cancels the timeout', async () => {
  const tab = createTab();
  const failure = new Error('locks unavailable');
  tab.locks.failWith = failure;
  const { error } = await settled(tab.fence.run('op-1', async () => 'ran'));
  assertRefusal(error, 'eb_fence_failed');
  assert.equal(error.cause, failure);
  assert.equal(tab.clock.pendingTimers(), 0, 'the acquisition timer is cancelled');
});

test('a lock request that throws synchronously refuses eb_fence_failed with that error as the cause and cancels the timeout', async () => {
  const tab = createTab({ locks: { request() { throw new Error('locks threw'); } } });
  const { error } = await settled(tab.fence.run('op-1', async () => 'ran'));
  assertRefusal(error, 'eb_fence_failed');
  assert.equal(error.cause.message, 'locks threw');
  assert.equal(tab.clock.pendingTimers(), 0);
});

test('K0-B6 a nested step of the same operation reuses the capability: one acquisition, no deadlock', async () => {
  const tab = createTab();
  const result = await tab.fence.run('op-1', (capability) => tab.fence.run('op-1', async (nested) => [capability, nested], capability));
  assert.equal(result[0], result[1], 'the nested step gets the same capability');
  assert.equal(tab.locks.requests, 1);
  assert.ok(await tab.isFree(), 'the nested step did not release the fence early or keep it');
});

test('K0-B7 another operation presenting the capability is refused tp1_fence_not_owned and does not run', async () => {
  const tab = createTab();
  let foreignRuns = 0;
  await tab.fence.run('op-1', async (capability) => {
    const { error } = await settled(tab.fence.run('op-2', async () => { foreignRuns += 1; }, capability));
    assertRefusal(error, 'tp1_fence_not_owned');
  });
  assert.equal(foreignRuns, 0);
});

test('a forged capability with the right operation id is refused tp1_fence_not_owned', async () => {
  const tab = createTab();
  await tab.fence.run('op-1', async () => {
    const { error } = await settled(tab.fence.run('op-1', async () => 'ran', { operationId: 'op-1' }));
    assertRefusal(error, 'tp1_fence_not_owned');
  });
});

test('a capability kept after its section ended is refused tp1_fence_not_owned, also while another operation holds the fence', async () => {
  const tab = createTab();
  const kept = await tab.fence.run('op-1', async (capability) => capability);
  assertRefusal((await settled(tab.fence.run('op-1', async () => 'ran', kept))).error, 'tp1_fence_not_owned');
  tab.hold('op-2');
  await settle();
  assertRefusal((await settled(tab.fence.run('op-1', async () => 'ran', kept))).error, 'tp1_fence_not_owned');
});

test('K0-B8 a release by a non-owner has no effect; the owner still holds the fence', async () => {
  const tab = createTab();
  let waiter;
  await tab.fence.run('op-1', async (capability) => {
    assert.equal(tab.fence.release(capability, 'op-2'), false, 'another operation');
    assert.equal(tab.fence.release({ operationId: 'op-1' }, 'op-1'), false, 'a forged capability');
    assert.equal(tab.fence.owns(capability, 'op-1'), true);
    waiter = tab.fence.run('op-3', async () => 'acquired');
    await settle();
    assert.ok(await isPending(waiter), 'the owner still holds it');
  });
  assert.equal(await waiter, 'acquired');
});

test('the owner releases once: a second release of the same capability returns false and frees the next waiter only once', async () => {
  const tab = createTab();
  const releases = [];
  const finished = tab.fence.run('op-1', async (capability) => {
    releases.push(tab.fence.release(capability, 'op-1'), tab.fence.release(capability, 'op-1'));
  });
  await finished;
  assert.deepEqual(releases, [true, false]);
  assert.ok(await tab.isFree());
});

test('a section that throws releases the fence and rethrows its error', async () => {
  const tab = createTab();
  const failure = new Error('section failed');
  await assert.rejects(tab.fence.run('op-1', async () => { throw failure; }), failure);
  assert.ok(await tab.isFree());
});

test('two wallets have separate fences', async () => {
  const first = createTab({ walletId: 'wallet-1' });
  const second = createTab({ walletId: 'wallet-2', clock: first.clock, locks: first.locks });
  first.hold();
  await settle();
  assert.equal(await second.fence.run('op-2', async () => 'ran'), 'ran');
});

test('K0-F10 a connection replacement takes the fence, waits for a holder, and bumps connectionGeneration after it ran', async () => {
  const tab = createTab();
  const holder = tab.hold('op-1');
  await settle();
  const observed = [];
  const replacement = tab.fence.replaceConnection(async () => { observed.push(tab.fence.connectionGeneration); return 'replaced'; });
  await settle();
  assert.deepEqual([tab.fence.connectionGeneration, observed], [0, []], 'the replacement waits for the holder');
  holder.release();
  assert.equal(await replacement, 'replaced');
  assert.deepEqual([observed, tab.fence.connectionGeneration], [[0], 1]);
  assert.ok(await tab.isFree());
});

test('a replacement that throws still bumps the generation, releases the fence and rethrows', async () => {
  const tab = createTab();
  const failure = new Error('reconnect failed');
  await assert.rejects(tab.fence.replaceConnection(async () => { throw failure; }), failure);
  assert.equal(tab.fence.connectionGeneration, 1);
  assert.ok(await tab.isFree());
});

test('a replacement that times out waiting for the fence does not bump the generation', async () => {
  const tab = createTab();
  tab.hold();
  await settle();
  const replacement = settled(tab.fence.replaceConnection(async () => 'replaced'));
  await settle();
  tab.clock.advance(FENCE_TIMEOUT_MS);
  assertRefusal((await replacement).error, 'tp1_fence_timeout');
  assert.equal(tab.fence.connectionGeneration, 0);
});

test('only a fenced replacement can change the generation', () => {
  const tab = createTab();
  assert.throws(() => { tab.fence.connectionGeneration = 5; }, TypeError);
  assert.equal(tab.fence.connectionGeneration, 0);
});

test('createWalletFence refuses a missing Web Locks manager or a wallet id that is not a non-empty string with a TypeError', () => {
  const locks = createFakeLocks();
  assert.throws(() => createWalletFence({ locks: {}, walletId: 'wallet-1' }), { name: 'TypeError', message: 'locks.request must be a function' });
  assert.throws(() => createWalletFence({ locks: undefined, walletId: 'wallet-1' }), TypeError);
  for (const walletId of ['', undefined, 7]) assert.throws(() => createWalletFence({ locks, walletId }), { name: 'TypeError', message: 'walletId must be a non-empty string' });
});

test('createWalletFence refuses a clock without now or setTimer with a TypeError', () => {
  const locks = createFakeLocks();
  const { now, setTimer } = createFakeClock();
  assert.throws(() => createWalletFence({ locks, walletId: 'wallet-1', clock: { setTimer } }), { name: 'TypeError', message: 'clock.now must be a function' });
  assert.throws(() => createWalletFence({ locks, walletId: 'wallet-1', clock: { now } }), { name: 'TypeError', message: 'clock.setTimer must be a function' });
  assert.throws(() => createWalletFence({ locks, walletId: 'wallet-1', clock: null }), TypeError);
});

test('createWalletFence refuses a timeoutMs that is not an integer from 1 to 2147483647 with a TypeError', () => {
  const locks = createFakeLocks();
  const clock = createFakeClock();
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2 ** 31, '10000', null]) {
    assert.throws(() => createWalletFence({ locks, walletId: 'wallet-1', clock, timeoutMs }), { name: 'TypeError', message: 'timeoutMs must be an integer from 1 to 2147483647' }, String(timeoutMs));
  }
  for (const timeoutMs of [1, 2 ** 31 - 1]) assert.doesNotThrow(() => createWalletFence({ locks, walletId: 'wallet-1', clock, timeoutMs }));
});

test('a clock whose setTimer returns a non-function refuses eb_fence_failed with a TypeError cause and does not ask for the lock', async () => {
  const clock = { now: () => 0, setTimer: () => undefined };
  const tab = createTab({ clock });
  const run = settled(tab.fence.run('op-1', async () => 'ran'));
  assert.equal(await hasSettled(run), true, 'the run does not hang');
  const { error } = await run;
  assertRefusal(error, 'eb_fence_failed');
  assert.ok(error.cause instanceof TypeError);
  assert.equal(tab.locks.requests, 0);
});

test('replaceConnection throws a TypeError for a non-function at once, before taking the fence or changing the generation', () => {
  const tab = createTab();
  for (const replace of [undefined, 'reconnect', {}]) assert.throws(() => tab.fence.replaceConnection(replace), { name: 'TypeError', message: 'replace must be a function' });
  assert.equal(tab.fence.connectionGeneration, 0);
  assert.equal(tab.locks.requests, 0);
});

test('a replacement inside a running section with its capability runs without a second acquisition and bumps the generation', async () => {
  const tab = createTab();
  await tab.fence.run('op-1', async (capability) => {
    const nested = settled(tab.fence.replaceConnection(async () => 'replaced', capability));
    assert.equal(await hasSettled(nested), true, 'the replacement does not wait for the lock its own section holds');
    assert.equal((await nested).value, 'replaced');
  });
  assert.equal(tab.locks.requests, 1);
  assert.equal(tab.fence.connectionGeneration, 1);
  assert.ok(await tab.isFree());
});

test('a nested replacement the section does not await finishes before the next section starts, which sees the new generation', async () => {
  const tab = createTab();
  const gate = createGate();
  const order = [];
  const section = tab.fence.run('op-1', async (capability) => {
    tab.fence.replaceConnection(async () => { order.push('replace:start'); await gate.promise; order.push('replace:end'); }, capability);
  });
  const next = tab.fence.run('op-2', async () => { order.push(`next:start gen=${tab.fence.connectionGeneration}`); });
  await settle();
  assert.deepEqual(order, ['replace:start'], 'the next section waits for the running replacement');
  assert.equal(await hasSettled(section), false, 'the section does not end while its replacement runs');
  gate.open();
  await Promise.all([section, next]);
  assert.deepEqual(order, ['replace:start', 'replace:end', 'next:start gen=1']);
  assert.ok(await tab.isFree());
});

test('a nested replacement the section does not await and that fails still releases the fence and bumps the generation', async () => {
  const tab = createTab();
  let nested;
  await tab.fence.run('op-1', async (capability) => {
    nested = settled(tab.fence.replaceConnection(async () => { throw new Error('reconnect failed'); }, capability));
  });
  assert.equal((await nested).error.message, 'reconnect failed');
  assert.equal(tab.fence.connectionGeneration, 1);
  assert.ok(await tab.isFree());
});

test('a replacement with a forged or ended capability is refused tp1_fence_not_owned, replaces nothing and keeps the generation', async () => {
  const tab = createTab();
  let replacements = 0;
  const replace = async () => { replacements += 1; };
  const kept = await tab.fence.run('op-1', async (capability) => capability);
  await tab.fence.run('op-2', async () => {
    const forged = settled(tab.fence.replaceConnection(replace, { operationId: 'op-2' }));
    assert.equal(await hasSettled(forged), true, 'a forged capability is refused, not queued');
    assertRefusal((await forged).error, 'tp1_fence_not_owned');
    const ended = settled(tab.fence.replaceConnection(replace, kept));
    assert.equal(await hasSettled(ended), true, 'an ended capability is refused, not queued');
    assertRefusal((await ended).error, 'tp1_fence_not_owned');
  });
  assert.equal(replacements, 0);
  assert.equal(tab.fence.connectionGeneration, 0);
});

test('refuse builds a refusal that keeps its code and its cause, and no cause when none is given', () => {
  const cause = new Error('underlying');
  const withCause = refuse('tp1_example', cause);
  assertRefusal(withCause, 'tp1_example');
  assert.equal(withCause.cause, cause);
  assert.equal(withCause.message, 'effect boundary refused: tp1_example');
  assert.equal('cause' in refuse('tp1_example'), false);
});

test('requireFunctions names the first member that is not a function', () => {
  assert.doesNotThrow(() => requireFunctions('store', { head() {}, append() {} }, ['head', 'append']));
  assert.throws(() => requireFunctions('store', { head() {} }, ['head', 'append']), { name: 'TypeError', message: 'store.append must be a function' });
  assert.throws(() => requireFunctions('store', undefined, ['head']), { name: 'TypeError', message: 'store.head must be a function' });
});

test('the system clock reads a non-decreasing number, fires a timer, and a cancelled timer never fires', async () => {
  const first = SYSTEM_CLOCK.now();
  assert.ok(Number.isFinite(first) && SYSTEM_CLOCK.now() >= first);
  const fired = [];
  SYSTEM_CLOCK.setTimer(() => fired.push('cancelled'), 0)();
  await new Promise((resolve) => SYSTEM_CLOCK.setTimer(() => { fired.push('kept'); resolve(); }, 0));
  assert.deepEqual(fired, ['kept']);
});
