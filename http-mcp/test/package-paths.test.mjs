import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPackagePaths } from '../scripts/package-paths.mjs';

test('ordinary public runtime manifest is allowed by the release file-list checker', () => {
  assert.deepEqual(forbiddenPackagePaths([
    'public/portal/embedded-wallet/runtime-manifest.json',
    'public/portal/embedded-wallet/demos-runtime.mjs',
    'public/portal/embedded-wallet/runtime-chunks/chunk-ABC.mjs',
    'src/app.mjs', '.env.example',
  ]), []);
});

test('the public manifest exemption is exact, not a directory-wide wallet JSON allowance', () => {
  const paths = ['wallet.json', 'public/portal/embedded-wallet/wallet.json',
    'public/portal/embedded-wallet/runtime-chunks/wallet-state.json',
    'public/portal/embedded-wallet/another-manifest.json',
    'other/embedded-wallet/runtime-manifest.json',
    'public/portal/embedded-wallet/runtime-manifest.json.backup',
    'public/portal/embedded-wallet/RUNTIME-MANIFEST.JSON'];
  assert.deepEqual(forbiddenPackagePaths(paths), paths);
});

test('the pre-existing non-wallet exclusions are retained independently', () => {
  const paths = ['test/control.mjs', 'references/spec.md', 'scripts/package-paths.mjs',
    '.env', 'data/state.sqlite', '.data/cache', 'AGENTS.md',
    'STATUS.md', 'ACCEPTANCE.md'];
  assert.deepEqual(forbiddenPackagePaths(paths), paths);
});
