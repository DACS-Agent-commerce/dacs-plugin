import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { harness, readLedgerFile, ADDR_B } from '../helpers.js';
import { SpendLedger } from '../../src/spend.js';

const DEM = 1_000_000_000n;
const WARNING = 'The transaction was sent and its receipt is below, but closing the spend-cap reservation failed, so the cap accounting for this action is unconfirmed. Do not resubmit; check the spend ledger before preparing another write.';
const NOW = () => new Date('2026-10-05T12:00:00Z');

async function exercise(state: 'included' | 'failed' | 'pending' | 'unknown', fault: 'before' | 'after' | 'lock' | 'none') {
  const h = await harness();
  h.wallet.feeOs = DEM;
  let sends = 0;
  let releases = 0;
  const lock = join(h.config.stateDir, 'spend-ledger.json.lock');
  const originalBroadcast = h.wallet.broadcast.bind(h.wallet);
  h.wallet.broadcast = async (p) => {
    sends++;
    const result = await originalBroadcast(p);
    if (fault === 'lock') writeFileSync(lock, 'test-owned lock', { flag: 'wx', mode: 0o600 });
    return { ...result, state };
  };
  const release = h.ledger.release.bind(h.ledger);
  h.ledger.release = (...args) => {
    releases++;
    assert.equal(sends, 1, 'fault must happen after exactly one broadcast');
    if (fault === 'before') throw new Error('INJECTED-310 before ledger write');
    release(...args);
    if (fault === 'after') throw new Error('INJECTED-310 after ledger write');
  };
  const prepared = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(prepared.isError, false);
  const args = { prepared_id: prepared.json.prepared_id, confirmation_code: h.channel.last().code };
  const r = await h.call('demos_tx_submit', args);
  if (fault === 'lock' && existsSync(lock)) unlinkSync(lock);
  const persistedPath = join(h.config.stateDir, 'receipts.jsonl');
  const persisted = existsSync(persistedPath) ? readFileSync(persistedPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const retry = await h.call('demos_tx_submit', args);
  const disk = readLedgerFile(h.config.stateDir);
  const reloaded = new SpendLedger(h.config.stateDir, h.config.dailyCapOs, NOW);
  console.log(JSON.stringify({ case: `${state}/${fault}`, sends, releases, error: r.isError, returnedReceipt: !!r.json?.receipt, persistedReceipts: persisted.length, retryError: retry.isError, debitAfterRestart: reloaded.spentToday().toString(), openReservations: disk.reservations?.length ?? 0, warningPresent: typeof r.json?.warning === 'string' }));
  assert.equal(sends, 1, 'same-ID retry must not broadcast again');
  assert.equal(retry.isError, true);
  assert.match(retry.text, /already-used prepared_id/);
  assert.equal(releases, state === 'included' || state === 'failed' ? 1 : 0);
  const settled = (state === 'included' || state === 'failed') && (fault === 'after' || fault === 'none');
  assert.equal(reloaded.spentToday(), settled ? 2n * DEM : 3n * DEM);
  assert.equal(disk.reservations?.length ?? 0, settled ? 0 : 1);
  assert.equal(r.isError, false, `sent-but-receipt-lost: ${r.text}`);
  assert.equal(r.json.status, state);
  assert.equal(r.json.receipt.chain.tx_hash, h.wallet.broadcasts[0]!.hash);
  assert.equal(r.json.receipt.chain.state, state);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], r.json.receipt, 'persisted receipt equals returned receipt');
  if ((state === 'included' || state === 'failed') && fault !== 'none') {
    assert.equal(r.json.warning, WARNING, 'assert the warning field itself, including accounting uncertainty');
  } else {
    assert.equal(r.json.warning, undefined, 'healthy and unsettled outcomes must not gain the release warning');
  }
  await h.client.close();
}

for (const state of ['included', 'failed'] as const) {
  for (const fault of ['before', 'after'] as const) {
    test(`DACS-Agent-commerce/dacs-plugin#310 ${state}: ${fault}-write release fault preserves receipt and does not resend`, () => exercise(state, fault));
  }
}
test('DACS-Agent-commerce/dacs-plugin#310 real ledger lock timeout after broadcast preserves receipt', () => exercise('included', 'lock'));
test('DACS-Agent-commerce/dacs-plugin#310 healthy included control closes reservation without warning', () => exercise('included', 'none'));
test('DACS-Agent-commerce/dacs-plugin#310 pending keeps reservation and skips release', () => exercise('pending', 'before'));
test('DACS-Agent-commerce/dacs-plugin#310 unknown keeps reservation and skips release', () => exercise('unknown', 'before'));

test('DACS-Agent-commerce/dacs-plugin#310 pre-send failure remains an error with no receipt or broadcast', async () => {
  const h = await harness();
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(p.isError, false);
  h.wallet.preparePay = async () => { throw new Error('INJECTED before transmission'); };
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.isError, true);
  assert.match(r.text, /INJECTED before transmission/);
  assert.equal(h.wallet.broadcasts.length, 0);
  assert.equal(existsSync(join(h.config.stateDir, 'receipts.jsonl')), false);
  assert.equal(h.ledger.spentToday(), 0n);
  await h.client.close();
});
