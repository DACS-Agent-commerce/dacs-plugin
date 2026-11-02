// Purchase timeline logging without per-step noise at the default level.
//
// Every step (page action, wallet signature, validate, broadcast, inclusion,
// readback, stage change) is logged at debug as `purchase_step`. At info the
// steps are buffered per purchase and written as one `purchase_timeline` line
// carrying them, when the purchase changes stage, when `flushMs` has passed
// since the first buffered step, when `maxSteps` are buffered, or on close.
// Consecutive identical page actions (for example the portal's 1 s recheck
// polls) are coalesced into one step with a count. scripts/purchase-timeline.mjs
// reads both line kinds, so a timeline is available at info and at debug.
// Logging never affects a purchase: errors here are swallowed by callers.
export const PURCHASE_STEP_FLUSH_MS = 15000;

export function createPurchaseStepLog({ logger, flushMs = PURCHASE_STEP_FLUSH_MS, maxSteps = 100, limit = 256, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // purchaseId -> { jobId, steps, timer }
  const buffers = new Map();
  function flush(purchaseId) {
    const entry = buffers.get(purchaseId);
    if (!entry) return;
    buffers.delete(purchaseId);
    clearTimer(entry.timer);
    if (entry.steps.length) logger?.info('purchase_timeline', { purchaseId, jobId: entry.jobId, steps: entry.steps });
  }
  function record(fields) {
    const { purchaseId, jobId = null, ...step } = fields ?? {};
    if (typeof purchaseId !== 'string') return;
    logger?.debug('purchase_step', fields);
    let entry = buffers.get(purchaseId);
    if (!entry) {
      if (buffers.size >= limit) flush(buffers.keys().next().value);
      entry = { jobId: null, steps: [], timer: null };
      buffers.set(purchaseId, entry);
    }
    entry.jobId ??= jobId;
    const last = entry.steps.at(-1);
    if (step.step === 'page-action-received' && last?.step === 'page-action-received' && last.action === step.action) {
      last.count = (last.count ?? 1) + 1;
      last.lastTimestampMs = step.timestampMs;
    } else entry.steps.push(step);
    if (step.step === 'stage-change' || entry.steps.length >= maxSteps) flush(purchaseId);
    else if (!entry.timer) { entry.timer = setTimer(() => flush(purchaseId), flushMs); entry.timer?.unref?.(); }
  }
  return {
    record,
    flush,
    close() { for (const purchaseId of [...buffers.keys()]) flush(purchaseId); },
  };
}
