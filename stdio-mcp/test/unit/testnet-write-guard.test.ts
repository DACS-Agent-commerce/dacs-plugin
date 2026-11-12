import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_TESTNET_HOSTS, loadConfig } from '../../src/config.js';

test('testnet write hosts stay empty until buyer tools take testnet writes', () => {
  assert.equal(KNOWN_TESTNET_HOSTS.size, 0,
    'The set stays empty until buyer tools take testnet writes; the change that fills it must replace this test with its own host rule');
});

test('faucet defaults use reserved invalid hosts', () => {
  const config = loadConfig({});
  assert.equal(config.faucetApiUrl, 'https://faucet-api.invalid/api/request');
  assert.equal(config.faucetPageUrl, 'https://faucet.invalid');
});
