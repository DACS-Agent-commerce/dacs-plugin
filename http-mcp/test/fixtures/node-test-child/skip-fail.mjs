import { test } from 'node:test';
// A test that skips itself and then throws: Node 22 counts it as skipped, prints `not ok … # SKIP` and exits 0.
test('skipped then fails', (t) => { t.skip('why'); throw new Error('boom'); });
test('fine', () => {});
