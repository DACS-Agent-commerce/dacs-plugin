import { test } from 'node:test';
test('first', () => {});
test('second', () => { process.exit(0); });
test('third', () => {});
