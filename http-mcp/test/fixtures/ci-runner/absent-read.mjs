import { test } from 'node:test';
import { readFileSync } from 'node:fs';
// As a doc test does: read a file that is not carried while the module is evaluated.
const text = readFileSync(new URL('./not-carried.txt', import.meta.url), 'utf8');
test('never runs: the read above throws ENOENT', () => text);
