import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('reads missing deploy contract', () => {
  readFileSync(new URL('../../../deploy/env-contract.json', import.meta.url));
});
