import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
describe('payment', () => { test('settles', () => assert.fail('known failure')); });
test('payment', () => assert.fail('known failure'));
test('same name', () => assert.fail('known failure'));
test('same name', () => assert.fail('known failure'));
describe('a', () => { test('b', () => {}); });
test('a > b', () => assert.fail('known failure'));
