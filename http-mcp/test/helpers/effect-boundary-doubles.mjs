// Instrumented doubles for the browser effect boundary: an in-memory record store that honours the store
// contract (head + compare-and-swap append), and a "world" that wires one tab's checks, fence and pass runner to
// the clock and Web Locks doubles of the fence tests, with call counters and barrier hooks.
import { createEffectBoundary, ebSign, ebTransmit } from '../../public/portal/embedded-wallet/effect-boundary.mjs';
import { createWalletFence } from '../../public/portal/embedded-wallet/wallet-fence.mjs';
import { createFakeClock, createFakeLocks, createGate, settle } from './wallet-fence-doubles.mjs';

// head(lane) returns {revision, signed, last}, the raw records. append uses the lane revision by CAS.
// Failures and beforeCommit hooks model failed writes and mutation barriers.
export function createMemoryRecords() {
  const lanes = new Map();
  const store = {
    failures: new Map(),
    beforeCommit: new Map(),
    async head(lane) {
      const records = lanes.get(lane) ?? [];
      const signed = records.findLast((record) => record.kind === 'signed');
      return { revision: records.length, signed: signed && structuredClone(signed), last: records.at(-1) && structuredClone(records.at(-1)) };
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
