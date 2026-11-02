import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// A grandchild in the run's own group, with no pipes, outlives the file unless the group is killed.
test('leaves a grandchild', () => {
  const grandchild = spawn(process.execPath, ['--import', new URL('./hang-deadline.mjs', import.meta.url).href,
    '-e', 'setInterval(() => {}, 1000)', 'node-test-child-fixture'], { stdio: 'ignore' });
  writeFileSync(process.env.PID_FILE, String(grandchild.pid));
  grandchild.unref();
});
