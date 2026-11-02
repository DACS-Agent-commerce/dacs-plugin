import { test } from 'node:test';
import assert from 'node:assert/strict';
test('exact failure # name: café', () => assert.equal(1, 2));
test('a new failure in the same file', () => assert.fail('new regression'));
