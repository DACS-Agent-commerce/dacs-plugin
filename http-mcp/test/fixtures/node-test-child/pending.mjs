import { test } from 'node:test';
test('ok', () => {});
// Never settles and holds no handle: the event loop drains with this test pending.
test('pending', () => new Promise(() => {}));
// EXIT_CODE overrides the exit code the cancelled test gives.
if (process.env.EXIT_CODE) process.on('exit', () => { process.exitCode = Number(process.env.EXIT_CODE); });
