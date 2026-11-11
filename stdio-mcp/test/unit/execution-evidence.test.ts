/**
 * A payment is reported successful only after its execution is read back. Inclusion is a location hint.
 * The stored transaction (getTxByHash: hash, blockNumber, status) is the evidence, matched to the requested hash,
 * the inclusion block and, for a prepared operation, its approved sender, recipient, amount, nonce, data and fee.
 * The real DemosChain.getTx and DemosWallet.broadcast run over a recording double of the SDK; no network.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { DemosChain, type PreparedTx } from '../../src/chain.js';
import { SecretGuard } from '../../src/secrets.js';
import { verifyArtifact, verifyTxRefs, type Check } from '../../src/dacs/verify.js';
import { ADDR_B, MNEMONIC, harness } from '../helpers.js';

const HASH = 'ab'.repeat(32);
const BLOCK = 7;
const FROM = '0x' + '11'.repeat(32);
const DATA = ['native', { nativeOperation: 'send', args: [ADDR_B, '5'] }];
const FEE = { network_fee: '1', rpc_fee: '1', additional_fee: '0' };

const included = { state: 'included', blockNumber: BLOCK };
const content = { type: 'native', from: FROM, to: ADDR_B, amount: '5', nonce: 4, data: DATA, transaction_fee: FEE, gcr_edits: [] };
const stored = (over: Record<string, unknown> = {}) => ({ hash: HASH, blockNumber: BLOCK, status: 'confirmed', content, ...over });
const storedWith = (c: Record<string, unknown>) => stored({ content: { ...content, ...c } });

const prepared: PreparedTx = {
  hash: HASH,
  valid: true,
  message: 'ok',
  feeOs: 2n,
  referenceBlock: 1,
  content: { type: 'native', from: FROM, to: ADDR_B, amountOs: 5n, nonce: '4', data: DATA },
  opaque: { validity: true },
};

/** Drive mocked timers (setTimeout and Date) until `p` settles; returns the mocked time that passed. */
async function settle<T>(t: TestContext, p: Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  const start = Date.now();
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(1_000);
  }
  await new Promise((r) => setImmediate(r));
  if (!done) throw new Error(`still pending after ${Date.now() - start} ms of mocked time: nothing bounded it`);
  return { value: await p, elapsedMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// DemosChain.getTx (receipt checks and demos_tx_get)

function chainReading(status: unknown, tx: () => Promise<unknown>) {
  const calls = { status: 0, tx: 0, send: 0 };
  const c = new DemosChain('http://127.0.0.1:1', new SecretGuard());
  (c as any).demos = {
    nodeCall: async () => { calls.status++; return status; },
    getTxByHash: async () => { calls.tx++; return tx(); },
    broadcast: async () => { calls.send++; },
    confirm: async () => { calls.send++; },
  };
  return { chain: c, calls };
}
const reading = (status: unknown, tx: unknown) => chainReading(status, async () => tx);

test('getTx: included whose execution failed is failed, never success', async () => {
  const { chain, calls } = reading(included, stored({ status: 'failed' }));
  const r = await chain.getTx(HASH);
  assert.equal(r.state, 'failed');
  assert.equal(r.executed, false);
  assert.equal(calls.send, 0);
});

for (const [name, tx] of [
  ['no stored transaction', null],
  ['stored status absent', stored({ status: undefined })],
  ['stored status still pending', stored({ status: 'pending' })],
  ['a non-object answer', 'error'],
  ['another hash', stored({ hash: 'cd'.repeat(32) })],
  ['another block', stored({ blockNumber: BLOCK + 1 })],
  ['no block', stored({ blockNumber: null })],
] as const) {
  test(`getTx: included with execution evidence ${name} stays pending`, async () => {
    const { chain, calls } = reading(included, tx);
    const r = await chain.getTx(HASH);
    assert.equal(r.state, 'pending');
    assert.equal(r.executed, false);
    assert.match(r.detail ?? '', /execution not established/);
    assert.equal(calls.send, 0);
  });
}

test('getTx: included without a block number in the status stays pending', async () => {
  const r = await reading({ state: 'included' }, stored()).chain.getTx(HASH);
  assert.equal(r.state, 'pending');
});

test('getTx: executed and matching is success, unchanged', async () => {
  const r = await reading(included, stored()).chain.getTx(HASH);
  assert.equal(r.state, 'included');
  assert.equal(r.blockNumber, BLOCK);
  assert.equal(r.content?.amount, '5');
});

test('getTx: executed is set only for established execution', async () => {
  assert.equal((await reading(included, stored()).chain.getTx(HASH)).executed, true);
  assert.equal((await reading(included, null).chain.getTx(HASH)).executed, false);
});

test('getTx: an execution read error is pending with a bounded cause', async () => {
  const { chain, calls } = chainReading(included, async () => { throw new Error('socket hang up '.repeat(100)); });
  const r = await chain.getTx(HASH);
  assert.equal(r.state, 'pending');
  assert.equal(r.executed, false);
  assert.match(r.detail ?? '', /execution read failed/);
  assert.ok((r.detail ?? '').length < 400);
  assert.equal(calls.send, 0);
});

test('getTx: an oversized execution answer is refused and stays pending', async () => {
  const big = stored({ content: { ...content, gcr_edits: [], pad: 'x'.repeat(1024 * 1024 + 1) } });
  const r = await reading(included, big).chain.getTx(HASH);
  assert.equal(r.state, 'pending');
  assert.match(r.detail ?? '', /size cap/);
});

test('getTx: an execution read that never answers ends at the shared deadline as pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chain, calls } = chainReading(included, () => new Promise(() => {}));
  const { value: r, elapsedMs } = await settle(t, chain.getTx(HASH));
  assert.equal(r.state, 'pending');
  assert.match(r.detail ?? '', /timed out|deadline/);
  assert.ok(elapsedMs <= 11_000, `ended at ${elapsedMs} ms, the deadline is 10 s`);
  assert.equal(calls.tx, 1);
  assert.equal(calls.send, 0);
});

// ---------------------------------------------------------------------------
// DemosWallet.broadcast: the real wallet over an SDK double

function sdk(t: TestContext, status: () => Promise<unknown>, tx: () => Promise<unknown>) {
  const calls = { status: 0, tx: 0, send: 0, confirm: 0 };
  t.mock.method(Demos.prototype, 'connect', async () => true);
  t.mock.method(Demos.prototype, 'connectWallet', async function (this: any) {
    this.crypto = { getIdentity: async () => ({ privateKey: new Uint8Array(32).fill(5) }) };
    return true;
  });
  t.mock.method(Demos.prototype, 'getAddress', () => FROM);
  t.mock.method(Demos.prototype, 'getNetworkInfo', async () => ({ forks: { osDenomination: { activated: true } } }));
  t.mock.method(Demos.prototype, 'confirm', async () => { calls.confirm++; return {}; });
  t.mock.method(Demos.prototype, 'broadcast', async () => { calls.send++; return { result: 200 }; });
  t.mock.method(Demos.prototype, 'nodeCall', async (name: string) => {
    assert.equal(name, 'getTransactionStatus');
    calls.status++;
    return status();
  });
  t.mock.method(Demos.prototype, 'getTxByHash', async () => { calls.tx++; return tx(); });
  return calls;
}

async function broadcastWith(t: TestContext, status: () => Promise<unknown>, tx: () => Promise<unknown>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = sdk(t, status, tx);
  const wallet = await new DemosChain('http://127.0.0.1:1', new SecretGuard()).openWallet(MNEMONIC);
  const { value, elapsedMs } = await settle(t, wallet.broadcast(prepared));
  return { r: value, calls, elapsedMs };
}

test('broadcast wait: included with no execution read is never success', async (t) => {
  const { r, calls } = await broadcastWith(t, async () => included, async () => null);
  assert.equal(r.state, 'pending');
  assert.ok(calls.tx >= 1, 'the execution was read for the same hash');
  assert.match(r.detail ?? '', /execution not established/);
  assert.match(r.detail ?? '', /do not resubmit/);
  assert.equal(calls.send, 1, 'sent once by the wallet, never again');
  assert.equal(calls.confirm, 0);
});

test('broadcast wait: included whose execution failed is failed', async (t) => {
  const { r, calls } = await broadcastWith(t, async () => included, async () => stored({ status: 'failed' }));
  assert.equal(r.state, 'failed');
  assert.equal(r.txHash, HASH);
  assert.equal(calls.send, 1);
});

test('broadcast wait: executed and matching is success, unchanged', async (t) => {
  const { r, calls } = await broadcastWith(t, async () => included, async () => stored());
  assert.deepEqual(r, { txHash: HASH, state: 'included', blockNumber: BLOCK });
  assert.equal(calls.send, 1);
  assert.equal(calls.confirm, 0);
});

test('broadcast wait: execution that appears on a later poll is still success', async (t) => {
  let n = 0;
  const { r, calls } = await broadcastWith(t, async () => included, async () => (++n < 3 ? null : stored()));
  assert.equal(r.state, 'included');
  assert.equal(calls.tx, 3);
  assert.equal(calls.send, 1);
});

for (const [name, tx] of [
  ['another hash', stored({ hash: 'cd'.repeat(32) })],
  ['another block', stored({ blockNumber: BLOCK + 1 })],
  ['another amount', storedWith({ amount: '6' })],
  ['another recipient', storedWith({ to: FROM })],
  ['another sender', storedWith({ from: ADDR_B })],
  ['another nonce', storedWith({ nonce: 5 })],
  ['another type', storedWith({ type: 'identity' })],
  ['another fee', storedWith({ transaction_fee: { ...FEE, rpc_fee: '2' } })],
  ['no fee', storedWith({ transaction_fee: undefined })],
  ['other data', storedWith({ data: ['native', { nativeOperation: 'send', args: [ADDR_B, '6'] }] })],
  ['no data', storedWith({ data: undefined })],
  ['no content', stored({ content: undefined })],
  ['more edits than the collection limit', storedWith({ gcr_edits: new Array(257).fill({ type: 'balance' }) })],
] as const) {
  test(`broadcast wait: included with execution evidence for ${name} is never success`, async (t) => {
    const { r, calls } = await broadcastWith(t, async () => included, async () => tx);
    assert.notEqual(r.state, 'included');
    assert.equal(r.state, 'pending');
    assert.equal(calls.send, 1);
  });
}

test('broadcast wait: the same data in another key order still matches', async (t) => {
  const reordered = storedWith({ data: ['native', { args: [ADDR_B, '5'], nativeOperation: 'send' }] });
  const { r } = await broadcastWith(t, async () => included, async () => reordered);
  assert.equal(r.state, 'included');
});

test('broadcast wait: a failing execution read ends pending at the shared deadline, with nothing sent again', async (t) => {
  const { r, calls, elapsedMs } = await broadcastWith(t, async () => included, async () => { throw new Error('node unavailable'); });
  assert.equal(r.state, 'pending');
  assert.match(r.detail ?? '', /execution read failed/);
  assert.ok(elapsedMs <= 62_000, `ended at ${elapsedMs} ms, the deadline is 60 s`);
  assert.equal(calls.send, 1);
  assert.equal(calls.confirm, 0);
});

test('broadcast wait: an execution read that never answers ends at the deadline as pending', async (t) => {
  const { r, calls, elapsedMs } = await broadcastWith(t, async () => included, () => new Promise(() => {}));
  assert.equal(r.state, 'pending');
  assert.ok(elapsedMs <= 62_000, `ended at ${elapsedMs} ms, the deadline is 60 s`);
  assert.equal(calls.tx, 1, 'the hung read is not retried or stacked');
  assert.equal(calls.send, 1);
});

test('broadcast wait: a status read that never answers ends at the deadline as pending', async (t) => {
  const { r, calls, elapsedMs } = await broadcastWith(t, () => new Promise(() => {}), async () => stored());
  assert.equal(r.state, 'pending');
  assert.ok(elapsedMs <= 62_000);
  assert.equal(calls.tx, 0, 'no execution read without inclusion');
  assert.equal(calls.send, 1);
});

// ---------------------------------------------------------------------------
// verify.ts

test('verifyTxRefs: an included but unexecuted payment is not receipt evidence', async () => {
  const h = await harness();
  const ref = { kind: 'demos', txHash: HASH, blockNumber: 77 };
  for (const executed of [undefined, false]) {
    h.chain.txs.set(HASH, { hash: HASH, found: true, state: 'included', blockNumber: 77, ...(executed === undefined ? {} : { executed }) });
    const checks: Check[] = [];
    await verifyTxRefs([ref], h.chain, checks, 'paymentTxRefs');
    assert.equal(checks[0]?.decision, 'indeterminate');
    assert.match(checks[0]?.detail ?? '', /execution is not established/);
  }
  h.chain.txs.set(HASH, { hash: HASH, found: true, state: 'included', executed: true, blockNumber: 77 });
  const checks: Check[] = [];
  await verifyTxRefs([ref], h.chain, checks, 'paymentTxRefs');
  assert.equal(checks[0]?.decision, 'pass');
});

test('verifyArtifact: a receipt whose payment is included but unexecuted is not accepted', async () => {
  const h = await harness();
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  const real = (await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code })).json.receipt;
  const issuer = (await h.call('demos_network_info')).json.safety.receipt_issuer;
  const tx = { hash: real.chain.tx_hash, found: true, state: 'included', content: { from: real.chain.from, to: real.chain.to, amount: real.chain.amount_os } };
  h.chain.txs.set(real.chain.tx_hash, tx);
  const unexecuted = await verifyArtifact(real, h.chain, { expectedSigner: issuer });
  assert.notEqual(unexecuted.decision, 'accept');
  assert.equal(unexecuted.checks.find((c) => c.check === 'chain-tx')?.decision, 'indeterminate');
  h.chain.txs.set(real.chain.tx_hash, { ...tx, executed: true });
  assert.equal((await verifyArtifact(real, h.chain, { expectedSigner: issuer })).decision, 'accept');
});

test('verifyArtifact: a receipt whose payment failed on execution is rejected end to end through getTx', async () => {
  const h = await harness();
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  const real = (await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code })).json.receipt;
  const issuer = (await h.call('demos_network_info')).json.safety.receipt_issuer;
  const h2 = real.chain.tx_hash;
  const c = { type: 'native', from: real.chain.from, to: real.chain.to, amount: real.chain.amount_os };
  const failed = reading(included, { hash: h2, blockNumber: BLOCK, status: 'failed', content: c }).chain;
  const r = await verifyArtifact(real, failed, { expectedSigner: issuer });
  assert.equal(r.decision, 'reject');
  const ok = reading(included, { hash: h2, blockNumber: BLOCK, status: 'confirmed', content: c }).chain;
  assert.equal((await verifyArtifact(real, ok, { expectedSigner: issuer })).decision, 'accept');
});
