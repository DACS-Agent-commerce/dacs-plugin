import { test } from 'node:test';
test('before', () => {});
await new Promise(() => {});
test('after', () => {});
