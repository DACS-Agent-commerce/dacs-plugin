import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// LOAD selects one failing test: a module that does not parse or is missing, or an assertion
// whose message only mentions those errors.
const tests = {
  syntax: async () => { await import('data:text/javascript,export const x = ;'); },
  missing: async () => { await import('./no-such-module.mjs'); },
  json: () => { JSON.parse('{'); },
  mention: () => { assert.equal('SyntaxError ERR_MODULE_NOT_FOUND', 'expected'); },
  // The compared values hold the name two levels down, where a nested result's own fields sit.
  deep: () => { assert.deepStrictEqual({ a: { name: 'SyntaxError' } }, { a: { name: 'TypeError' } }); },
  // Loader-looking text nested in an assertion value must not become the failure's own stack.
  'deep-stack': () => { assert.deepStrictEqual({ a: { name: 'SyntaxError', stack: 'node:internal/modules/esm/utils:1:1' } }, {}); },
};
// A load error in a test inside a suite; an assertion that fails, then a failing TODO's load error.
if (process.env.LOAD === 'nested') describe('suite', () => { test('syntax', tests.syntax); });
else if (process.env.LOAD === 'todo') { test('real', () => { assert.equal(1, 2); }); test('todo', { todo: 'unrelated' }, tests.syntax); }
else test(process.env.LOAD, tests[process.env.LOAD]);
