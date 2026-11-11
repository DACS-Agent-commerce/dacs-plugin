import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { denomination } from '@kynesyslabs/demosdk';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { DemosChain, feeFromValidity } from '../../src/chain.js';
import { SecretGuard } from '../../src/secrets.js';
import { ADDR_B, MNEMONIC } from '../helpers.js';

const FROM = '0x' + '11'.repeat(32);
const CASES = [
  ['null additional_fee is zero', { network_fee: '1', rpc_fee: '2', additional_fee: null }],
  ['absent additional_fee is zero', { network_fee: '1', rpc_fee: '2' }],
  ['decimal strings retain DEM parsing', { network_fee: '0.000000001', rpc_fee: '0.000000002', additional_fee: '0.0' }],
  ['JSON numbers are OS', { network_fee: 1, rpc_fee: 2, additional_fee: 0 }],
] as const;

for (const [name, fees] of CASES) {
  for (const source of ['gas_operation', 'transaction'] as const) {
    test(`post-fork feeFromValidity (${source}): ${name}`, () => {
      const data = source === 'gas_operation' ? { gas_operation: { fees } } : { transaction: { content: { transaction_fee: fees } } };
      assert.equal(feeFromValidity({ response: { data } }, true), 3n);
    });
  }

  test(`post-fork preparePay before broadcast: ${name}`, async (t) => {
    const content = {
      type: 'native', from: FROM, to: ADDR_B, amount: '5000000000', nonce: '4',
      data: ['native', { nativeOperation: 'send', args: [ADDR_B, '5000000000'] }],
      transaction_fee: typeof fees.network_fee === 'number' ? fees : { network_fee: '1', rpc_fee: '2', additional_fee: '0' }, gcr_edits: [],
    };
    const hash = createHash('sha256').update(denomination.serializeTransactionContent(content as any, true), 'utf8').digest('hex');
    const tx = { hash, content, signature: { data: 'signed' } };
    let confirms = 0;
    let broadcasts = 0;
    t.mock.method(Demos.prototype, 'connect', async () => true);
    t.mock.method(Demos.prototype, 'connectWallet', async function (this: any) {
      this.crypto = { getIdentity: async () => ({ privateKey: new Uint8Array(32).fill(5) }) };
      return true;
    });
    t.mock.method(Demos.prototype, 'getAddress', () => FROM);
    t.mock.method(Demos.prototype, 'getNetworkInfo', async () => ({ forks: { osDenomination: { activated: true } } }));
    t.mock.method(Demos.prototype, 'pay', async (to: string, amount: bigint) => {
      assert.equal(to, ADDR_B);
      assert.equal(amount, 5_000_000_000n);
      return tx;
    });
    t.mock.method(Demos.prototype, 'confirm', async (signed: unknown) => {
      assert.equal(signed, tx);
      confirms++;
      return { result: 200, response: { data: { valid: true, transaction: tx, gas_operation: { fees } } } };
    });
    t.mock.method(Demos.prototype, 'broadcast', async () => { broadcasts++; throw new Error('unexpected broadcast'); });
    const wallet = await new DemosChain('http://127.0.0.1:1', new SecretGuard()).openWallet(MNEMONIC);
    const prepared = await wallet.preparePay(ADDR_B, 5_000_000_000n, 3n);
    assert.equal(prepared.hash, hash);
    assert.equal(prepared.feeOs, 3n);
    assert.equal(confirms, 1);
    assert.equal(broadcasts, 0);
  });
}

test('post-fork feeFromValidity retains trimmed strings, leading zeros and bigint fees', () => {
  const fees = { network_fee: ' 01 ', rpc_fee: 2n, additional_fee: null };
  assert.equal(feeFromValidity({ response: { data: { gas_operation: { fees } } } }, true), 3n);
});
