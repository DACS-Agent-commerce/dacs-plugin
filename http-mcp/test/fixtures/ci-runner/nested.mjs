import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
describe('outer', () => {
  describe('inner a', () => { test('leaf', () => assert.fail('a')); });
  describe('inner b', () => { test('leaf', () => assert.fail('b')); });
  test('after', () => assert.fail('c'));
});
test('top', () => assert.fail('d'));
