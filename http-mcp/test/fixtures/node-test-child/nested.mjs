import { test } from 'node:test';
// 'outer > inner' runs only without SKIP_INNER; 'outer' fails with a message holding a fake 'ok N - inner' line.
test('outer', async (t) => {
  if (!process.env.SKIP_INNER) await t.test('inner', () => {});
  else throw new Error('x\nok 1 - inner');
});
