// One in-flight protocol workflow per purchase, answered in short polls.
//
// A poll waits up to `waitMs` for the purchase's workflow and otherwise
// answers with the current (pending) view. Concurrent or retried polls share
// the in-flight workflow and never start another copy. A workflow that settles
// while no poll is waiting (between two polls) keeps its outcome, success or
// failure, for `keepMs` or until the next poll for that purchase consumes it,
// so that poll answers with it instead of starting a whole new workflow.
// Nothing here retries or resends: `work` runs once per started workflow.
export const PURCHASE_POLL_WAIT_MS = 1000;
export const PURCHASE_POLL_KEEP_MS = 30000;
export const PURCHASE_POLL_DRAIN_MS = 10000;

export function createPurchasePoll({ waitMs = PURCHASE_POLL_WAIT_MS, keepMs = PURCHASE_POLL_KEEP_MS, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // id -> { task, outcome: null | { ok:true, value } | { ok:false, error }, settledAt }
  const entries = new Map();
  const deliver = (outcome) => { if (!outcome.ok) throw outcome.error; return { result: outcome.value, pending: false }; };
  // Forget settled outcomes nobody collected in time; they are never served
  // stale, and the next poll starts a fresh workflow instead.
  function sweep() {
    const at = now();
    for (const [id, entry] of entries) if (entry.outcome && at - entry.settledAt > keepMs) entries.delete(id);
  }
  function start(id, work) {
    const entry = { task: null, outcome: null, settledAt: 0 };
    entry.task = Promise.resolve().then(work).then(
      (value) => { entry.outcome = { ok: true, value }; },
      (error) => { entry.outcome = { ok: false, error }; },
    ).then(() => { entry.settledAt = now(); });
    entries.set(id, entry);
    return entry;
  }
  // The poll that delivers an outcome consumes it; a later poll starts anew.
  function consume(id, entry) {
    if (entries.get(id) === entry) entries.delete(id);
    return deliver(entry.outcome);
  }
  return {
    async poll(id, work, current) {
      sweep();
      const retained = entries.get(id);
      if (retained?.outcome) return consume(id, retained);
      const entry = retained ?? start(id, work);
      let timer;
      try {
        const settled = await Promise.race([
          entry.task.then(() => true),
          new Promise((resolve) => { timer = setTimer(() => resolve(false), waitMs); }),
        ]);
        return settled ? consume(id, entry) : { result: current(), pending: true };
      } finally { clearTimer(timer); }
    },
    // Wait for in-flight workflows, but never longer than `timeoutMs`; a
    // timed-out drain leaves them running exactly as a shutdown without a
    // drain would. Resolves true when everything settled in time.
    async drain({ timeoutMs = PURCHASE_POLL_DRAIN_MS } = {}) {
      const tasks = [...entries.values()].filter((entry) => !entry.outcome).map((entry) => entry.task);
      if (!tasks.length) return true;
      let timer;
      try {
        return await Promise.race([
          Promise.allSettled(tasks).then(() => true),
          new Promise((resolve) => { timer = setTimer(() => resolve(false), timeoutMs); timer?.unref?.(); }),
        ]);
      } finally { clearTimer(timer); }
    },
  };
}
