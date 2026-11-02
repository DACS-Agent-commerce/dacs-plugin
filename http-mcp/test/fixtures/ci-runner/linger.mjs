import { test } from 'node:test';
test('passes but leaves a ref-ed handle', () => { setInterval(() => {}, 1000); });
