import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name)) yield file;
  }
}

test('every SDK import in src and bin and the Demos SDK pin is a direct exact dependency', () => {
  const names = new Set(['@kynesyslabs/demosdk']);
  for (const dir of ['src', 'bin']) {
    for (const file of sources(join(root, dir))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"](@kynesyslabs\/[^'"]+)['"]/g)) {
        const specifier = match[1];
        const name = specifier.split('/').slice(0, 2).join('/');
        names.add(name);
      }
    }
  }
  for (const name of names) {
    assert.match(pkg.dependencies?.[name] ?? '', exact, `${name} must be a direct exact dependency`);
  }
});
