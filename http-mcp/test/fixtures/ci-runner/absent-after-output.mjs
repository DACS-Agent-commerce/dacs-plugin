import { test } from 'node:test';
// Writes its own line to stderr, then fails to load a module that is not there.
console.error('database initialization failed');
await import('./not-carried.mjs');
test('never runs: the import above does not resolve', () => {});
