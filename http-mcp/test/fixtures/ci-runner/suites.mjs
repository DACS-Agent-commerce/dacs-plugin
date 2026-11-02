import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
describe('block a', () => { test('same name', () => assert.fail('known failure')); });
describe('block b', () => { test('same name', () => assert.fail('new failure')); });
