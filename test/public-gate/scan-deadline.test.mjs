import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, runTreeRules } from '../../scripts/public-gate/gate.mjs';
import { PRIVATE_RULE_ID, scanPrivate } from '../../scripts/public-gate/rules-private.mjs';
import { scanWording, WORDING_RULE_ID } from '../../scripts/public-gate/rules-text.mjs';

const config = loadConfig();
const SCAN_DEADLINE_MS = config.limits.scanDeadlineMs;
const MATCHER_CHECKPOINT_STEPS = 65_536;
const LISTED_VALUE = 'listed-value';

const privateRule = { id: PRIVATE_RULE_ID, completeOnly: true, run: scanPrivate };
const wordingRule = { id: WORDING_RULE_ID, completeOnly: true, run: scanWording };
/** A blob with no listed value whose scan makes the matcher reach its deadline checkpoint many times. */
const largeEntry = (name) => ({ path: name, position: 0, bytes: Buffer.from('word '.repeat(8 * MATCHER_CHECKPOINT_STEPS)) });
const lists = { listEntries: [LISTED_VALUE], wordingList: { entries: [LISTED_VALUE] } };

/** A rule that finds nothing and takes `milliseconds` on `clock.now`. */
const slowRule = (clock, milliseconds) => ({ id: 'R-SLOW', run: () => { clock.now += milliseconds; return []; } });

test('time spent in rules before R-PRIVATE does not count against the private-list scan deadline', () => {
  const clock = { now: 0 };
  const findings = runTreeRules({
    entries: [largeEntry('large.txt')], ...lists, config, clock: () => clock.now, rules: [slowRule(clock, 2 * SCAN_DEADLINE_MS), privateRule],
  });
  assert.deepEqual(findings, []);
});

test('time spent in rules before R-WORDING, R-PRIVATE included, does not count against the wording-list scan deadline', () => {
  const clock = { now: 0 };
  const findings = runTreeRules({
    entries: [largeEntry('large.md')], ...lists, config, clock: () => clock.now, rules: [slowRule(clock, 2 * SCAN_DEADLINE_MS), wordingRule],
  });
  assert.deepEqual(findings, []);
});

test('the private-list scan stops with limit:scanDeadlineMs once it alone has run past the deadline', () => {
  let now = 0;
  const ticking = () => { now += SCAN_DEADLINE_MS / 10; return now; };
  assert.throws(
    () => runTreeRules({ entries: [largeEntry('large.txt')], ...lists, config, clock: ticking, rules: [privateRule] }),
    { cause: 'limit:scanDeadlineMs' },
  );
});

test('the wording-list scan stops with limit:scanDeadlineMs once it alone has run past the deadline', () => {
  let now = 0;
  const ticking = () => { now += SCAN_DEADLINE_MS / 10; return now; };
  assert.throws(
    () => runTreeRules({ entries: [largeEntry('large.md')], ...lists, config, clock: ticking, rules: [wordingRule] }),
    { cause: 'limit:scanDeadlineMs' },
  );
});

test('without a private list the rules that need it are skipped and the others still run', () => {
  let ran = false;
  const marker = { id: 'R-MARKER', run: () => { ran = true; return []; } };
  assert.deepEqual(runTreeRules({ entries: [], listEntries: null, wordingList: null, config, rules: [marker, privateRule, wordingRule] }), []);
  assert.ok(ran);
});
