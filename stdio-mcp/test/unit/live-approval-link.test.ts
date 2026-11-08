/** The live write cycle (test/live/testnet-write-cycle.ts) finds the approval link in the banner the server prints. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage } from '../../src/confirm.js';
import { approvalLinkFromLine } from '../live/approval-link.js';

const URL = 'http://127.0.0.1:43123/a/' + 'A'.repeat(21) + '_-' + 'z'.repeat(20);

test('the live link collector finds the approval link in the printed confirmation banner', () => {
  const banner = formatMessage({ preparedId: 'p1', code: '', digest: 'f'.repeat(64), title: 'Pay', lines: ['to x'], expiresAt: Date.now() + 120_000, approveUrl: URL });
  const links = banner.split('\n').map(approvalLinkFromLine).filter((l): l is string => l !== null);
  assert.deepEqual(links, [URL]);
});

test('the collector ignores the fallback code line and a non-local link', () => {
  const banner = formatMessage({ preparedId: 'p1', code: '123456', digest: 'f'.repeat(64), title: 'Pay', lines: [], expiresAt: Date.now() + 120_000, approveUrl: URL.replace('127.0.0.1', 'example.com') });
  assert.deepEqual(banner.split('\n').map(approvalLinkFromLine).filter(Boolean), []);
});
