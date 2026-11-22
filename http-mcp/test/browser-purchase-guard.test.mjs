// The browser tests that drive a purchase stop at requireSdkPurchases while SDK purchases are off. This file needs no
// browser: it checks the guard against the off app and that the guarded tests and their expected-until-card entries
// are the same set, so a guarded test without an entry, or an entry for a test that no longer stops there, fails here
// before a browser run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './helpers/harness.mjs';
import { requireSdkPurchases, SDK_PURCHASES_OFF } from './helpers/sdk-purchases.mjs';
import { judge, readExpected } from '../scripts/run-test-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Top-level test titles of a browser file whose body calls requireSdkPurchases, or whose file calls it in a hook.
function guardedTests(file) {
  const source = readFileSync(join(root, file), 'utf8');
  const starts = [...source.matchAll(/^test\((['`])((?:\\.|(?!\1).)*)\1/gm)];
  const hook = /^(?:before|beforeEach)\([\s\S]*?^\}\);/gm;
  if ([...source.matchAll(hook)].some(([body]) => body.includes('requireSdkPurchases('))) return starts.map((m) => m[2].replace(/\\'/g, "'"));
  return starts.filter((m, i) => source.slice(m.index, starts[i + 1]?.index ?? source.length).includes('requireSdkPurchases('))
    .map((m) => m[2].replace(/\\'/g, "'"));
}

test('requireSdkPurchases refuses with its one listed line while the app runs with SDK purchases off', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const health = await (await fetch(`${h.origin}/health`)).json();
  assert.equal(health.sdkPurchases.switch, 'off');
  await assert.rejects(requireSdkPurchases(h.origin), (error) => error.message === SDK_PURCHASES_OFF);
  assert.ok(!SDK_PURCHASES_OFF.includes('\n'), 'one line');
});

test('every browser test that stops at requireSdkPurchases has one expected entry with that line, and every such entry names one', () => {
  const files = readdirSync(join(root, 'test/browser')).filter((name) => name.endsWith('.browser.test.mjs')).map((name) => `test/browser/${name}`);
  const guarded = files.flatMap((file) => guardedTests(file).map((name) => JSON.stringify([file, name])));
  assert.ok(guarded.length > 0, 'the purchase-driving browser tests call the guard');
  const expected = readExpected(join(root, 'test/expected-until-card.json'));
  const listed = [...expected.values()].filter((entry) => entry.expect === SDK_PURCHASES_OFF);
  assert.deepEqual(listed.map((entry) => JSON.stringify([entry.file, entry.test])).sort(), [...guarded].sort());
  assert.equal(new Set(listed.map((entry) => `${entry.card} ${entry.issue}`)).size, 1, 'one card composes purchases again for all of them');
  for (const entry of listed) {
    // The runner takes the guard's failure as expected, from the test itself or from a hook (as the cause).
    for (const failure of [{ error: SDK_PURCHASES_OFF, cause: SDK_PURCHASES_OFF }, { error: 'failed running before hook', cause: SDK_PURCHASES_OFF }]) {
      const result = judge(entry.file, { failures: [{ test: entry.test, ...failure }], passing: [], seen: [entry.test], exit: 1 }, new Map(), expected, root);
      assert.deepEqual([result.expectedUntilCard, result.newFailures], [[entry.test], []], `${entry.file}: ${entry.test}`);
    }
  }
});
