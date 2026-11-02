import { test } from 'node:test';
test('passes', () => { setTimeout(() => { throw new Error('late'); }, 50); });
