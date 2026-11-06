// Instrumented doubles for the browser effect boundary: a controllable monotonic
// clock, a Web Locks manager, an in-memory record store that honours the store
// contract (head + compare-and-swap append), and a "world" that wires one tab's
// checks, fence and pass runner to them with call counters and barrier hooks.
import { createEffectBoundary, createWalletFence, ebSign, ebTransmit } from '../../public/portal/embedded-wallet/effect-boundary.mjs';

export const settle = () => new Promise((resolve) => setImmediate(resolve));

export function createGate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

export function createFakeClock() {
  let nowMs = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimer(callback, ms) {
      const id = nextId++;
      timers.set(id, { due: nowMs + ms, callback });
      return () => timers.delete(id);
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]);
        nowMs = Math.max(nowMs, next[1].due);
        next[1].callback();
      }
      nowMs = target;
    },
  };
}

// navigator.locks.request for exclusive locks: FIFO, held until the callback's
// promise settles, abortable while queued. `ignoreAbort` models a grant that
// races the abort and still reaches the callback.
export function createFakeLocks() {
  const queues = new Map();
  const locks = { requests: 0, ignoreAbort: false, request };

  function grantNext(name, queue) {
    if (queue.held || queue.waiters.length === 0) return;
    const waiter = queue.waiters.shift();
    queue.held = true;
    const finish = (settleWaiter) => (value) => { queue.held = false; settleWaiter(value); grantNext(name, queue); };
    Promise.resolve().then(() => waiter.callback({ name })).then(finish(waiter.resolve), finish(waiter.reject));
  }

  function request(name, options, callback) {
    locks.requests += 1;
    const queue = queues.get(name) ?? { held: false, waiters: [] };
    queues.set(name, queue);
    return new Promise((resolve, reject) => {
      const waiter = { callback, resolve, reject };
      queue.waiters.push(waiter);
      options.signal?.addEventListener('abort', () => {
        const index = queue.waiters.indexOf(waiter);
        if (locks.ignoreAbort || index < 0) return;
        queue.waiters.splice(index, 1);
        reject(options.signal.reason);
      });
      grantNext(name, queue);
    });
  }
  return locks;
}

// head(lane) -> {revision, lastKind, lastStage, signedBytes}; append(lane, expectedRevision, record) -> {revision}.
// `lastKind` and `lastStage` are the newest record's kind and stage and `signedBytes` the newest `signed` record's
// bytes (each undefined when there is none). `failures` makes a kind's commit throw; `beforeCommit` runs a hook while a kind is being persisted.
export function createMemoryRecords() {
  const lanes = new Map();
  const store = {
    failures: new Map(),
    beforeCommit: new Map(),
    async head(lane) {
      const records = lanes.get(lane) ?? [];
      const signed = records.findLast((record) => record.kind === 'signed');
      return { revision: records.length, lastKind: records.at(-1)?.kind, lastStage: records.at(-1)?.stage, signedBytes: signed && Uint8Array.from(signed.bytes) };
    },
    async append(lane, expectedRevision, record) {
      await store.beforeCommit.get(record.kind)?.(record);
      const failure = store.failures.get(record.kind);
      if (failure) throw failure;
      const records = lanes.get(lane) ?? [];
      lanes.set(lane, records);
      if (records.length !== expectedRevision) throw new Error(`revision conflict: have ${records.length}, expected ${expectedRevision}`);
      records.push(structuredClone(record));
      return { revision: records.length };
    },
    records: (lane) => lanes.get(lane) ?? [],
    kinds: (lane) => (lanes.get(lane) ?? []).map((record) => record.kind),
  };
  return store;
}

const SIGNED_BYTES = [7, 8, 9, 10];

// One tab: checks that read mutable `state`, call counters, numbered barrier
// hooks (`on('authority', 2, fn)` runs inside the second authority read), a
// fence, and a boundary. Tabs share `clock`, `locks`, `records` and `events`.
export function createWorld({ clock = createFakeClock(), locks = createFakeLocks(), records = createMemoryRecords(), events = [], walletId = 'wallet-1', operationId = 'op-1', lane = 'lane-1', stoppedCode } = {}) {
  const state = { killed: false, stopAnswer: undefined, admission: true, approval: true, digest: 'digest-1' };
  const counts = { signer: 0, transport: 0, stop: 0, authority: 0, lockRequests: 0 };
  const hooks = { stop: new Map(), authority: new Map() };
  const sent = [];
  const behavior = { transport: async () => ({ accepted: true }) };
  const background = [];
  let passNumber = 0;

  const checks = {
    admission: () => { events.push('admission'); return state.admission; },
    approval: () => { events.push('approval'); return state.approval; },
    connectionDigest: () => { events.push('digest'); queueMicrotask(() => events.push('tick')); return state.digest; },
    async stopped() {
      counts.stop += 1;
      await hooks.stop.get(counts.stop)?.();
      events.push('stop-read');
      return state.stopAnswer !== undefined ? state.stopAnswer : state.killed;
    },
    async readAuthority() {
      counts.authority += 1;
      const before = { lockRequests: counts.lockRequests, signer: counts.signer };
      await hooks.authority.get(counts.authority)?.();
      if (counts.lockRequests !== before.lockRequests || counts.signer !== before.signer) throw new Error('authority read touched the fence or the signer');
    },
  };

  const tabLocks = { request: (...args) => { counts.lockRequests += 1; return locks.request(...args); } };
  const fence = createWalletFence({ locks: tabLocks, walletId, clock });
  const boundary = createEffectBoundary({ fence, checks, records, clock, newPassId: () => `pass-${operationId}-${++passNumber}`, stoppedCode });

  const innerSign = async () => { counts.signer += 1; events.push('inner-sign', `${operationId}:sign`); return new Uint8Array(SIGNED_BYTES); };
  const innerSend = async (bytes) => { counts.transport += 1; events.push('inner-send', `${operationId}:send`); sent.push(bytes); return behavior.transport(bytes); };
  const sign = (armed) => ebSign(innerSign, armed)();
  const send = (armed, bytes) => ebTransmit(innerSend, armed)(bytes);

  const world = {
    clock, locks, records, events, fence, boundary, state, counts, sent, behavior, background, lane, operationId, sign, send, SIGNED_BYTES,
    on: (kind, call, hook) => hooks[kind].set(call, hook),
    request: (overrides) => ({ operationId, lane, pinVersion: 'pin-1', approvalRevision: 'approval-1', sign, stages: [{ name: 'dispatch', send }], ...overrides }),
    runPass: (overrides) => boundary.runPass(world.request(overrides)),
    // Holds the fence as another operation until `release()`.
    holdFence(holderId = 'holder') {
      const gate = createGate();
      const held = fence.run(holderId, () => gate.promise);
      background.push(held);
      return { release: gate.open };
    },
    async fenceIsFree() {
      const probe = fence.run('probe', async () => 'free');
      await settle();
      return (await Promise.race([probe, Promise.resolve('held')])) === 'free';
    },
    settled: (promise) => promise.then((value) => ({ value }), (error) => ({ error })),
  };
  return world;
}
