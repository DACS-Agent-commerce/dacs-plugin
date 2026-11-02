import { test } from 'node:test';
// Writes a complete summary, then dies by a signal on the way out.
test('passes', () => {});
process.on('exit', () => process.kill(process.pid, 'SIGKILL'));
