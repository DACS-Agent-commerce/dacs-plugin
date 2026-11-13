import { test } from 'node:test';
// Writes its own line to stdout, then fails to load a module that is not there.
console.log('database initialization started');
await import('./not-carried.mjs');
test('never runs: the import above does not resolve', () => {});
