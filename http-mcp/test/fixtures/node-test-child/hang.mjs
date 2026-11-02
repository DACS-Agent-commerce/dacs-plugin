import { test } from 'node:test';
import './hang-deadline.mjs';
// Ignores SIGTERM and keeps a handle until SIGKILL or the orphan deadline.
process.on('SIGTERM', () => {});
test('hangs', () => new Promise(() => { setInterval(() => {}, 1000); }));
