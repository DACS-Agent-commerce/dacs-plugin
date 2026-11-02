import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('hangs with an owned descendant', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.CI_RUNNER_PID_FILE) writeFileSync(process.env.CI_RUNNER_PID_FILE, String(child.pid));
  await new Promise(() => {});
});
