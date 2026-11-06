// Doubles for the browser wallet fence: a controllable clock with timers and a Web Locks manager.
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
    pendingTimers: () => timers.size,
  };
}

// navigator.locks.request for exclusive locks: FIFO, held until the callback's promise settles, abortable while
// queued. `ignoreAbort` models a grant that races the abort and still reaches the callback. `failWith` makes
// every request reject with that error.
export function createFakeLocks() {
  const queues = new Map();
  const locks = { requests: 0, ignoreAbort: false, failWith: undefined, request };

  function grantNext(name, queue) {
    if (queue.held || queue.waiters.length === 0) return;
    const waiter = queue.waiters.shift();
    queue.held = true;
    const finish = (settleWaiter) => (value) => { queue.held = false; settleWaiter(value); grantNext(name, queue); };
    Promise.resolve().then(() => waiter.callback({ name })).then(finish(waiter.resolve), finish(waiter.reject));
  }

  function request(name, options, callback) {
    locks.requests += 1;
    if (locks.failWith !== undefined) return Promise.reject(locks.failWith);
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
