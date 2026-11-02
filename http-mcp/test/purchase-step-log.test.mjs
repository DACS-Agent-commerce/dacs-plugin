import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/util/log.mjs';
import { createPurchaseStepLog } from '../src/util/purchase-step-log.mjs';
import { purchaseTimeline, formatTimeline } from '../scripts/purchase-timeline.mjs';

function fakeTimers() {
  const timers = new Set();
  return {
    timers,
    setTimer(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    fire() { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } },
  };
}
const parsed = (lines) => lines.map((line) => JSON.parse(line));
// One purchase: the portal polls the recheck route five times, then a write goes through and the stage changes.
function purchase(steps, at = 1770000000000) {
  for (let i = 0; i < 5; i++) steps.record({ purchaseId: 'pur_one', jobId: 'job-1', timestampMs: at + i * 1000, step: 'page-action-received', phase: 'complete', durationMs: 0, action: 'protocol/recheck' });
  steps.record({ purchaseId: 'pur_one', jobId: 'job-1', timestampMs: at + 5000, step: 'sign', phase: 'complete', durationMs: 40, hash: 'a'.repeat(64), artifactKind: 'Deliverable' });
  steps.record({ purchaseId: 'pur_one', jobId: 'job-1', timestampMs: at + 5500, step: 'broadcast', phase: 'complete', durationMs: 300, hash: 'a'.repeat(64), artifactKind: 'Deliverable' });
  steps.record({ purchaseId: 'pur_one', jobId: 'job-1', timestampMs: at + 6000, step: 'stage-change', phase: 'complete', durationMs: 0, stage: 'delivery-ready', status: 'payment_confirmed' });
}

test('at info a purchase writes one timeline line per stage, not one line per step; repeated polls are coalesced', () => {
  const lines = [], timers = fakeTimers();
  const steps = createPurchaseStepLog({ logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }), ...timers });
  purchase(steps);
  const logged = parsed(lines);
  assert.equal(logged.filter((line) => line.event === 'purchase_step').length, 0, 'no per-step lines at info');
  assert.equal(logged.length, 1, 'the stage change writes the buffered steps as one line');
  const [summary] = logged;
  assert.equal(summary.event, 'purchase_timeline'); assert.equal(summary.level, 'info'); assert.equal(summary.purchaseId, 'pur_one'); assert.equal(summary.jobId, 'job-1');
  assert.deepEqual(summary.steps.map((step) => step.step), ['page-action-received', 'sign', 'broadcast', 'stage-change']);
  assert.equal(summary.steps[0].count, 5); assert.equal(summary.steps[0].lastTimestampMs, 1770000004000);
  assert.equal(timers.timers.size, 0, 'a flushed purchase leaves no timer');
  // The timeline script reads the info log.
  const events = purchaseTimeline(lines.join('\n')).get('pur_one');
  assert.deepEqual(events.map((event) => event.step), ['page-action-received', 'sign', 'broadcast', 'stage-change']);
  assert.equal(events[1].gapMs, 1000 - 40, 'gaps run from the last coalesced poll');
  assert.match(formatTimeline(lines.join('\n')), /page-action-received complete protocol\/recheck x5 over 4000 ms/);
});

test('at debug every step is its own line as well, and the timeline script counts each step once', () => {
  const lines = [];
  const steps = createPurchaseStepLog({ logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }), ...fakeTimers() });
  purchase(steps);
  const logged = parsed(lines);
  assert.equal(logged.filter((line) => line.event === 'purchase_step' && line.level === 'debug').length, 8);
  assert.equal(logged.filter((line) => line.event === 'purchase_timeline').length, 1);
  const events = purchaseTimeline(lines.join('\n')).get('pur_one');
  assert.equal(events.length, 8, 'per-step lines are used, not added to the summary');
});

test('buffered steps are written after the flush interval, when the buffer is full, when too many purchases are buffered, and on close', () => {
  const lines = [], timers = fakeTimers();
  const steps = createPurchaseStepLog({ logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }), maxSteps: 3, limit: 2, flushMs: 15000, ...timers });
  const step = (purchaseId, n, action = `a${n}`) => steps.record({ purchaseId, timestampMs: 1770000000000 + n, step: 'page-action-received', phase: 'complete', action });
  step('pur_a', 1);
  assert.equal(lines.length, 0); assert.equal(timers.timers.size, 1); assert.equal([...timers.timers][0].ms, 15000);
  timers.fire();
  assert.deepEqual(parsed(lines).map((line) => [line.purchaseId, line.steps.length]), [['pur_a', 1]], 'the interval writes a quiet purchase');
  lines.length = 0;
  step('pur_a', 2); step('pur_a', 3); step('pur_a', 4);
  assert.deepEqual(parsed(lines).map((line) => [line.purchaseId, line.steps.length]), [['pur_a', 3]], 'a full buffer is written');
  lines.length = 0;
  step('pur_a', 5); step('pur_b', 6); step('pur_c', 7);
  assert.deepEqual(parsed(lines).map((line) => line.purchaseId), ['pur_a'], 'the oldest purchase is written to make room');
  lines.length = 0;
  steps.close();
  assert.deepEqual(parsed(lines).map((line) => line.purchaseId), ['pur_b', 'pur_c']);
  assert.equal(timers.timers.size, 0);
  steps.close(); assert.equal(lines.length, 2, 'nothing is written twice');
  steps.record({ timestampMs: 1, step: 'sign', phase: 'complete' }); assert.equal(lines.length, 2, 'a step without a purchase is ignored');
});
