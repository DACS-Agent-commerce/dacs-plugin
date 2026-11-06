import { test } from 'node:test';
import './not-carried.mjs';
test('never runs: the import above does not resolve', () => {});
