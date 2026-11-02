import { test } from 'node:test';
test('passes but sets a failing exit code', () => { process.exitCode = 3; });
