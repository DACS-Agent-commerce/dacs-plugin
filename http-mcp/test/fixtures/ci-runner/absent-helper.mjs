import { test } from 'node:test';
import { helper } from './absent-helper-support.mjs';
test('never runs: the helper cannot load', () => helper);
