import { test } from 'node:test';
// A failing test, and an exit code other than the 1 a failure gives: set on exit, after the runner sets 1.
test('fails', () => { throw new Error('fails'); });
process.on('exit', () => { process.exitCode = 3; });
