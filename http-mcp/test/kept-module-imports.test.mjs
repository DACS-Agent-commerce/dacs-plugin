import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const specifiers = (file) => [...readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]);
const unresolved = (file) => specifiers(file).filter((spec) => spec.startsWith('.') && !existsSync(resolve(dirname(file), spec)));

const SWITCHED = ['src/mcp/seller-content.mjs', 'src/ops/health.mjs', 'src/portal/purchase-receipt.mjs', 'src/identities.mjs'];
const SDK_ENTRIES = new Set(['@kynesyslabs/dacs', '@kynesyslabs/dacs-client', '@kynesyslabs/dacs-client/wallet/durable-journal']);

test('seller-content, ops/health, purchase-receipt and identities take SDK names only from @kynesyslabs/dacs, @kynesyslabs/dacs-client and its ./wallet/durable-journal subpath', async () => {
  for (const path of SWITCHED) {
    const file = join(root, path);
    const packages = specifiers(file).filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'));
    assert.deepEqual(packages.filter((spec) => !SDK_ENTRIES.has(spec)), [], path);
    assert.ok(packages.some((spec) => spec.startsWith('@kynesyslabs/dacs-client')), `${path} takes its SDK names from the client`);
    assert.deepEqual(unresolved(file), [], path);
    await import(new URL(`../${path}`, import.meta.url));
  }
});
