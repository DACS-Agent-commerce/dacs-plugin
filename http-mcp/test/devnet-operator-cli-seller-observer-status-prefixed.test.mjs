import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicCliStatuses } from './helpers/devnet-operator-cli-issued-recovery-node2.mjs';

test('seller observer diagnostic status parser retains the public settled_verified enum',()=>{
  assert.deepEqual(readPublicCliStatuses('{"status":"settled_verified"}'),['settled_verified']);
});
