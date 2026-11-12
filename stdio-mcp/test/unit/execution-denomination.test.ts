import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { DemosChain, type PreparedTx } from '../../src/chain.js';
import { SecretGuard } from '../../src/secrets.js';
import { ADDR_B, MNEMONIC } from '../helpers.js';

const HASH = 'ab'.repeat(32);
const FROM = '0x' + '11'.repeat(32);
const BLOCK = 7;
const DATA = ['native', { nativeOperation: 'send', args: [ADDR_B, '5000000000'] }];
const FEES = { network_fee: 1_000_000_000, rpc_fee: 2_000_000_000, additional_fee: 0 };
const CONTENT = { type: 'native', from: FROM, to: ADDR_B, amount: 5_000_000_000, nonce: '4', data: DATA, transaction_fee: FEES, gcr_edits: [] };
const APPROVED: PreparedTx = {
  hash: HASH, valid: true, message: 'ok', feeOs: 3_000_000_000n,
  content: { type: 'native', from: FROM, to: ADDR_B, amountOs: 5_000_000_000n, nonce: '4', data: DATA },
  opaque: { validity: true },
};

async function waitForExecution(t: TestContext, content: unknown, osActive = true, approved = APPROVED) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = { send: 0, confirm: 0, lookup: 0 };
  t.mock.method(Demos.prototype, 'connect', async () => true);
  t.mock.method(Demos.prototype, 'connectWallet', async function (this: any) {
    this.crypto = { getIdentity: async () => ({ privateKey: new Uint8Array(32).fill(5) }) };
    return true;
  });
  t.mock.method(Demos.prototype, 'getAddress', () => FROM);
  t.mock.method(Demos.prototype, 'getNetworkInfo', async () => ({ forks: { osDenomination: { activated: osActive } } }));
  t.mock.method(Demos.prototype, 'confirm', async () => { calls.confirm++; return {}; });
  t.mock.method(Demos.prototype, 'broadcast', async (opaque: unknown) => {
    assert.equal(opaque, approved.opaque);
    calls.send++;
    return { result: 200 };
  });
  t.mock.method(Demos.prototype, 'nodeCall', async (name: string, args: unknown) => {
    assert.equal(name, 'getTransactionStatus');
    assert.deepEqual(args, { hash: HASH });
    return { state: 'included', blockNumber: BLOCK };
  });
  t.mock.method(Demos.prototype, 'getTxByHash', async (hash: string) => {
    assert.equal(hash, approved.hash);
    calls.lookup++;
    return { hash, blockNumber: BLOCK, status: 'confirmed', content };
  });
  const wallet = await new DemosChain('http://127.0.0.1:1', new SecretGuard()).openWallet(MNEMONIC);
  let done = false;
  const result = wallet.broadcast(approved);
  result.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 65 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done, 'the wait ends within its existing deadline');
  const value = await result;
  assert.equal(calls.send, 1);
  assert.equal(calls.confirm, 0);
  assert.ok(calls.lookup >= 1);
  return value;
}

test('broadcast wait: confirmed post-fork OS number amount and all number fees are included', async (t) => {
  assert.deepEqual(await waitForExecution(t, CONTENT), { txHash: HASH, state: 'included', blockNumber: BLOCK });
});

test('prepared execution lookup: confirmed JSON content with post-fork OS numbers matches approval', async (t) => {
  assert.deepEqual(await waitForExecution(t, JSON.stringify(CONTENT)), { txHash: HASH, state: 'included', blockNumber: BLOCK });
});

// Use canonical strings for the other fields so each rejection tests one field alone.
const STRINGS = { ...CONTENT, amount: '5000000000', transaction_fee: { network_fee: '1000000000', rpc_fee: '2000000000', additional_fee: '0' } };
for (const field of ['network_fee', 'rpc_fee', 'additional_fee'] as const) {
  for (const [name, fee] of [
    ['one OS higher', FEES[field] + 1],
    ['fractional number', FEES[field] + 0.25],
    ['negative number', -1],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['non-finite number', Infinity],
    ['leading zero string', `0${FEES[field]}`],
    ['signed string', `+${FEES[field]}`],
    ['negative string', '-1'],
    ['decimal string', `${FEES[field]}.0`],
    ['whitespace string', ` ${FEES[field]} `],
    ['null', null],
    ['missing', undefined],
    ['boolean', false],
    ['object', {}],
  ] as const) {
    test(`post-fork ${field}: ${name} stays pending`, async (t) => {
      const r = await waitForExecution(t, { ...STRINGS, transaction_fee: { ...STRINGS.transaction_fee, [field]: fee } });
      assert.equal(r.state, 'pending');
      assert.match(r.detail ?? '', /stored fee differs/);
    });
  }
}

for (const [name, amount] of [
  ['one OS higher', 5_000_000_001], ['fractional number', 5_000_000_000.25], ['negative number', -1],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['leading zero string', '05000000000'],
  ['signed string', '+5000000000'], ['decimal string', '5000000000.0'], ['boolean', false],
] as const) {
  test(`post-fork amount: ${name} stays pending`, async (t) => {
    const r = await waitForExecution(t, { ...STRINGS, amount });
    assert.equal(r.state, 'pending');
    assert.match(r.detail ?? '', /stored amount differs/);
  });
}

test('post-fork unsafe number amount cannot match a rounded approval', async (t) => {
  const amount = Number.MAX_SAFE_INTEGER + 1;
  const approved = { ...APPROVED, content: { ...APPROVED.content, amountOs: BigInt(amount) } };
  assert.equal((await waitForExecution(t, { ...STRINGS, amount }, true, approved)).state, 'pending');
});

for (const nonce of [4, '4']) {
  test(`post-fork nonce: exact ${typeof nonce} matches`, async (t) => {
    assert.equal((await waitForExecution(t, { ...STRINGS, nonce })).state, 'included');
  });
}

for (const nonce of [5, 4.25, -1, '04', '+4', '4.0', null]) {
  test(`post-fork nonce: ${JSON.stringify(nonce)} stays pending`, async (t) => {
    const r = await waitForExecution(t, { ...STRINGS, nonce });
    assert.equal(r.state, 'pending');
    assert.match(r.detail ?? '', /stored nonce differs/);
  });
}

test('post-fork unsafe number nonce cannot match a rounded approval', async (t) => {
  const nonce = Number.MAX_SAFE_INTEGER + 1;
  const approved = { ...APPROVED, content: { ...APPROVED.content, nonce: String(nonce) } };
  assert.equal((await waitForExecution(t, { ...STRINGS, nonce }, true, approved)).state, 'pending');
});

test('post-fork data: nested amount string changed to a number stays pending', async (t) => {
  const data = ['native', { nativeOperation: 'send', args: [ADDR_B, 5_000_000_000] }];
  const r = await waitForExecution(t, { ...STRINGS, data });
  assert.equal(r.state, 'pending');
  assert.match(r.detail ?? '', /stored data differs/);
});

test('post-fork canonical OS strings remain included', async (t) => {
  assert.equal((await waitForExecution(t, STRINGS)).state, 'included');
});

test('pre-fork DEM number amount and fees remain included', async (t) => {
  const content = { ...CONTENT, amount: 5, nonce: 4, transaction_fee: { network_fee: 1, rpc_fee: 2, additional_fee: 0 } };
  assert.equal((await waitForExecution(t, content, false)).state, 'included');
});

test('pre-fork decimal DEM string fees remain included', async (t) => {
  const content = { ...CONTENT, amount: 5, nonce: 4, transaction_fee: { network_fee: '1.0', rpc_fee: '2.0', additional_fee: '0.0' } };
  assert.equal((await waitForExecution(t, content, false)).state, 'included');
});
