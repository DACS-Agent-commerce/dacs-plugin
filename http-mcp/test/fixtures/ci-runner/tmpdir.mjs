import { test } from 'node:test';
import { appendFileSync, statSync } from 'node:fs';
test('records the TMPDIR it was given', () => {
  const dir = process.env.TMPDIR;
  const stats = dir && statSync(dir);
  appendFileSync(process.env.CI_RUNNER_TMPDIR_FILE, `${dir ?? '(unset)'}\t${stats ? `${(stats.mode & 0o777).toString(8)}\t${stats.uid}` : ''}\n`);
});
