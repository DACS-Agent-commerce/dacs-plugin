import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('wording token status: the small-heap child has a two-minute deadline', () => {
  // Intercept the real test's launch in a separate process so the builtin patch
  // cannot affect other test files. A deliberately stuck child exercises the
  // timeout path with a shorter deadline after checking the production value.
  const target = new URL('./wording-token-status.test.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = childProcess.execFileSync;
    let launches = 0;
    childProcess.execFileSync = (file, args, options) => {
      if (!args.includes('--max-old-space-size=128')) return original(file, args, options);
      launches += 1;
      assert.equal(options.timeout, 120000);
      assert.throws(() => original(file,
        ['--max-old-space-size=128', '--input-type=module', '-e', 'setInterval(() => {}, 1000)'],
        { ...options, timeout: 100 }), (error) => error.code === 'ETIMEDOUT');
      return '[0,0,1]';
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(target)});
    process.on('exit', () => assert.equal(launches, 1));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 10000, env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
