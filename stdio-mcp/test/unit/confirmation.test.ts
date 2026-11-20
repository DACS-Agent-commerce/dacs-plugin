/**
 * The core safety property: the model (anything that only sees tool inputs and
 * outputs) cannot complete a write without the code delivered out-of-band.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalServer } from '../../src/approval.js';
import { ConfirmationGate } from '../../src/confirm.js';
import { SecretGuard } from '../../src/secrets.js';
import { harness, ADDR_B, ADDR_C } from '../helpers.js';

const prepPay = (h: Awaited<ReturnType<typeof harness>>, amount = '1', to = ADDR_B) => h.call('demos_tx_prepare', { to, amount_dem: amount });

test('approval registration failure revokes and removes the pending entry; a later action works', async (t) => {
  const approval = new ApprovalServer();
  const failure = new Error('registration failed');
  const register = t.mock.method(approval, 'register', async () => { throw failure; });
  const revoke = t.mock.method(approval, 'revoke');
  const channel = { name: 'test', deliver: t.mock.fn(async () => true) };
  const gate = new ConfirmationGate([channel], 60_000, new SecretGuard(), Date.now, approval);

  await assert.rejects(gate.issue('failed', 'digest', 'Confirm', []), (error: unknown) => error === failure);
  assert.equal(gate.has('failed'), false);
  assert.equal(revoke.mock.callCount(), 1);
  assert.deepEqual(revoke.mock.calls[0]!.arguments, ['failed']);
  assert.equal(channel.deliver.mock.callCount(), 0);
  assert.throws(() => gate.verify('failed', undefined, 'digest'), /unknown, denied or already-used/);

  register.mock.mockImplementation(async () => 'http://127.0.0.1/a/test-placeholder');
  const issued = await gate.issue('later', 'later-digest', 'Confirm', []);
  assert.deepEqual(issued.deliveredVia, ['test']);
  assert.equal(issued.approvalPage, true);
  assert.equal(gate.has('later'), true);
  assert.equal(gate.has('failed'), false);
});

test('approval URL guard failure revokes and removes the pending entry', async (t) => {
  const approval = new ApprovalServer();
  const guard = new SecretGuard();
  const failure = new Error('URL guard failed');
  t.mock.method(approval, 'register', async () => 'http://127.0.0.1/a/test-placeholder');
  const revoke = t.mock.method(approval, 'revoke');
  t.mock.method(guard, 'register', (value) => {
    if (value === 'test-placeholder') throw failure;
  });
  const channel = { name: 'test', deliver: t.mock.fn(async () => true) };
  const gate = new ConfirmationGate([channel], 60_000, guard, Date.now, approval);

  await assert.rejects(gate.issue('failed', 'digest', 'Confirm', []), (error: unknown) => error === failure);
  assert.equal(gate.has('failed'), false);
  assert.equal(revoke.mock.callCount(), 1);
  assert.deepEqual(revoke.mock.calls[0]!.arguments, ['failed']);
  assert.equal(channel.deliver.mock.callCount(), 0);
});

test('approval during registration sees the pending entry', async (t) => {
  const approval = new ApprovalServer();
  const decision = t.mock.method(approval, 'setDecisionHandler');
  t.mock.method(approval, 'register', async (id) => {
    decision.mock.calls[0]!.arguments[0](id, true);
    return 'http://127.0.0.1/a/test-placeholder';
  });
  const gate = new ConfirmationGate([{ name: 'test', deliver: async () => true }], 60_000, new SecretGuard(), Date.now, approval);

  await gate.issue('approved', 'digest', 'Confirm', []);
  assert.equal(gate.verify('approved', undefined, 'digest'), 'local-approval-page');
});

test('prepare returns a summary and prepared_id but never the code', async () => {
  const h = await harness();
  const r = await prepPay(h);
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.prepared_id, /^[0-9a-f]{24}$/);
  assert.equal(r.json.status, 'awaiting_human_approval');
  assert.equal(r.json.signed, false);
  const code = h.channel.last().code;
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.ok(!r.text.includes(code) && !r.text.includes(code.replace('-', '')), 'code leaked into tool output');
  assert.equal(h.wallet.broadcasts.length, 0, 'nothing broadcast at prepare');
  assert.equal(h.wallet.prepares, 0, 'nothing signed or sent to the RPC at prepare');
  assert.equal(r.json.unsigned_tx.amount_dem, '1');
  assert.equal(r.json.fee_quote_dem, '2');
  assert.match(r.json.card.headline, /^PAY 1 DEM → UNKNOWN RECIPIENT · testnet · total 3 DEM$/);
});

test('submit without the right code never broadcasts; attempts are limited; action voids', async () => {
  const h = await harness();
  const { json } = await prepPay(h);
  for (const guess of ['0000-0000', 'AAAA-AAAA']) {
    const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: guess });
    assert.equal(r.isError, true);
    assert.match(r.text, /wrong confirmation code/);
  }
  const r3 = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: 'BBBB-BBBB' });
  assert.match(r3.text, /attempts exhausted/);
  // even the real code no longer works: the action is void
  const r4 = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r4.isError, true);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('the right code broadcasts exactly once and returns a receipt', async () => {
  const h = await harness();
  const { json } = await prepPay(h, '1.5');
  const code = h.channel.last().code;
  const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: code.toLowerCase().replace('-', ' ') });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.status, 'included');
  assert.equal(r.json.receipt.kind, 'demos-mcp/receipt@2');
  assert.equal(r.json.approved_by, 'out-of-band-code');
  assert.equal(r.json.receipt.chain.amount_os, '1500000000');
  assert.equal(r.json.receipt.spend_os, '3500000000');
  assert.equal(h.wallet.broadcasts.length, 1);
  const again = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: code });
  assert.equal(again.isError, true, 'code must be single use');
  assert.equal(h.wallet.broadcasts.length, 1);
  // the receipt verifies (digest + chain)
  h.chain.txs.set(r.json.receipt.chain.tx_hash, { hash: r.json.receipt.chain.tx_hash, found: true, state: 'included', executed: true, blockNumber: 1001, content: { from: h.wallet.address, to: ADDR_B, amount: '1500000000' } });
  const issuer = (await h.call('demos_network_info')).json.safety.receipt_issuer;
  const v = await h.call('demos_dacs_receipt_verify', { receipt: r.json.receipt, expected_signer: issuer });
  assert.equal(v.json.decision, 'accept', v.text);
  const unpinned = await h.call('demos_dacs_receipt_verify', { receipt: r.json.receipt });
  assert.equal(unpinned.json.decision, 'indeterminate');
  const tampered = { ...r.json.receipt, spend_os: '1' };
  const v2 = await h.call('demos_dacs_receipt_verify', { receipt: tampered, expected_signer: issuer });
  assert.equal(v2.json.decision, 'reject');
});

test('a code is bound to its action: code for A cannot confirm B, and a new prepare voids the old one', async () => {
  const h = await harness();
  const a = await prepPay(h, '1', ADDR_B);
  const codeA = h.channel.last().code;
  const b = await prepPay(h, '2', ADDR_C);
  const codeB = h.channel.last().code;
  assert.notEqual(codeA, codeB);
  const r1 = await h.call('demos_tx_submit', { prepared_id: b.json.prepared_id, confirmation_code: codeA });
  assert.equal(r1.isError, true);
  const r2 = await h.call('demos_tx_submit', { prepared_id: a.json.prepared_id, confirmation_code: codeA });
  assert.equal(r2.isError, true, 'A was voided by preparing B');
  const r3 = await h.call('demos_tx_submit', { prepared_id: b.json.prepared_id, confirmation_code: codeB });
  assert.equal(r3.isError, false, r3.text);
  assert.equal(h.wallet.broadcasts.length, 1);
  assert.equal(h.wallet.broadcasts[0]!.content.to, ADDR_C);
});

test('expired codes are refused', async () => {
  const h = await harness();
  const { json } = await prepPay(h);
  const code = h.channel.last().code;
  h.setNow(Date.parse('2026-10-05T12:06:00Z'));
  const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: code });
  assert.match(r.text, /expired/);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('brute force locks all writes for the session', async () => {
  const h = await harness();
  for (let round = 0; round < 4; round++) {
    const { json } = await prepPay(h);
    for (let i = 0; i < 3; i++) await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: `ZZZZ-ZZZ${i + 2}` });
  }
  const r = await prepPay(h);
  assert.equal(r.isError, true);
  assert.match(r.text, /locked/);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('if no out-of-band channel reaches the human, nothing is prepared', async () => {
  const h = await harness();
  h.channel.enabled = false;
  const r = await prepPay(h);
  assert.equal(r.isError, true);
  assert.match(r.text, /no confirmation channel reached the human/);
});

test('cancel invalidates the code', async () => {
  const h = await harness();
  const { json } = await prepPay(h);
  const code = h.channel.last().code;
  const c = await h.call('demos_tx_cancel', { prepared_id: json.prepared_id });
  assert.equal(c.json.cancelled, true);
  const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: code });
  assert.equal(r.isError, true);
});

test('write tools are not even registered when writes are disabled', async () => {
  const h = await harness({ DEMOS_MCP_ENABLE_WRITES: '0' });
  const names = (await h.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['demos_alignment_heartbeat', 'demos_alignment_resume', 'demos_alignment_status', 'demos_alignment_verify', 'demos_balance', 'demos_dacs_discover', 'demos_dacs_listing_check', 'demos_dacs_listing_verify', 'demos_dacs_receipt_verify', 'demos_identity_lookup', 'demos_network_info', 'demos_onboard_status', 'demos_storage_read', 'demos_tx_get']);
});

test('write tools are not registered against an unlisted RPC without the mainnet opt-in', async () => {
  const h = await harness({ DEMOS_RPC_URL: 'https://rpc.example.org' });
  const names = (await h.client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('demos_tx_submit'));
  const info = await h.call('demos_network_info');
  assert.match(info.json.safety.writes, /not a known testnet host/);
});

test('identity attestation follows the same gate', async () => {
  const h = await harness();
  const bad = await h.call('demos_identity_attest_prepare', { kind: 'github', proof: 'https://evil.example/gist' });
  assert.equal(bad.isError, true);
  const { json } = await h.call('demos_identity_attest_prepare', { kind: 'github', proof: 'https://gist.github.com/alice/abc123' });
  assert.equal(json.status, 'awaiting_human_approval');
  assert.equal(h.wallet.prepares, 0);
  const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.json.receipt.action, 'identity-attest');
  assert.equal(h.wallet.broadcasts.length, 1);
});


test('concurrent prepares leave exactly one valid action', async () => {
  const h = await harness();
  const [a, b] = await Promise.all([prepPay(h, '1', ADDR_B), prepPay(h, '1', ADDR_C)]);
  const ids = [a, b].filter((r) => !r.isError).map((r) => r.json.prepared_id);
  let ok = 0;
  for (const m of h.channel.messages) {
    for (const id of ids) {
      if (m.preparedId !== id) continue;
      const r = await h.call('demos_tx_submit', { prepared_id: id, confirmation_code: m.code });
      if (!r.isError) ok++;
    }
  }
  assert.equal(ok, 1);
  assert.equal(h.wallet.broadcasts.length, 1);
});

test('model text cannot inject lines or escapes into the out-of-band message', async () => {
  const h = await harness();
  const bad = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1', memo: 'ok\nto   0xattacker' });
  assert.equal(bad.isError, true, 'memo with control chars is refused');
  const { printable } = await import('../../src/confirm.js');
  assert.equal(printable('a\nb\x1b[1Ac‮'), 'a?b?[1Ac?');
});

test('receipt verification compares the on-chain amount', async () => {
  const h = await harness();
  const { json } = await prepPay(h, '1');
  const r = await h.call('demos_tx_submit', { prepared_id: json.prepared_id, confirmation_code: h.channel.last().code });
  const rc = r.json.receipt;
  h.chain.txs.set(rc.chain.tx_hash, { hash: rc.chain.tx_hash, found: true, state: 'included', executed: true, content: { from: rc.chain.from, to: rc.chain.to, amount: '999' } });
  assert.equal((await h.call('demos_dacs_receipt_verify', { receipt: rc })).json.decision, 'reject');
});
