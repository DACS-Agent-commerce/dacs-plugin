import { test } from 'node:test';
import assert from 'node:assert/strict';
test('todo with an empty reason', { todo: '' }, () => assert.fail('expected while todo'));
test('skipped with an empty reason', (t) => { t.skip(''); });
test('failing test skipped with an empty reason', { skip: '' }, () => assert.fail('expected while skipped'));
