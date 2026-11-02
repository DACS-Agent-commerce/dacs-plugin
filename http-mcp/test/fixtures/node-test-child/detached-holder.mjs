import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// A grandchild in its own group inherits the run's stdout/stderr and outlives the file.
test('leaves a holder', () => {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'node-test-child-fixture'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  writeFileSync(process.env.PID_FILE, String(holder.pid));
  holder.unref();
});
