import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCrashWorld } from './settlement-crash-world.mjs';
const [dir, boundary, scenario] = process.argv.slice(2);
const w = await openCrashWorld(dir, { initialize: true, scenario, interrupt(at) {
  if (at !== boundary) return;
  // Synchronous interruption inside DatabaseSync.exec, never an exception that
  // the production transaction helper could catch and roll back for the test.
  writeFileSync(join(dir, 'interrupted.json'), JSON.stringify({ boundary: at, scenario }));
  process.kill(process.pid, 'SIGKILL');
} });
w.arm();
await w.verify();
throw new Error('TEST child missed the requested process-death boundary');
