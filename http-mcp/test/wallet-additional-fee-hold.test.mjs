// The packaged wallet with in-process RPC doubles. No network or submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { anchorRequest, memoryAnchorJournal, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
for (const kind of ['native transfer', 'storage anchor']) for (const additionalFee of [0, 1, 4, '4', null, -1]) test(`${kind} additionalFee ${JSON.stringify(additionalFee)} ${additionalFee === 0 ? 'approves and signs' : 'holds before approval and signing'}`, async () => {
  let approvals = 0, signatures = 0, confirmations = 0, broadcasts = 0;
  class OfflineDemos extends Demos {
    async connect(url) { this.rpc_url = url; return true; }
    async nodeCall(message) {
      if (message === 'getNetworkParameters') return { networkFee: 1, rpcFee: 1, additionalFee };
      if (message === 'getAddressNonce') return 0;
      if (message === 'getNetworkInfo') return { simulated: true, chainIdentity: FIXTURE_IDENTITY, forks: { osDenomination: { activated: true } } };
      throw new Error(`unexpected RPC: ${message}`);
    }
    async sign(tx, options) { signatures++; return super.sign(tx, options); }
    async confirm(tx) { confirmations++; return { result: 200, response: { data: { valid: true, transaction: structuredClone(tx) } } }; }
    async broadcast() { broadcasts++; return { result: 200 }; }
  }
  const session = createSdkWalletSession({ DemosCtor: OfflineDemos, validateMnemonic, anchorJournal: memoryAnchorJournal(),
    transactionTransport: { profile: 'simulated-loopback', network: 'demos-testnet', rpcUrl: 'http://127.0.0.1:9/portal/api/wallet-rpc' },
    approve: async () => { approvals++; return true; } });
  try {
    const account = await session.create();
    const tx = kind === 'storage anchor' ? anchorRequest(account.address, 'demos-testnet') : buildNativeTransferPayload({ from: account.address, to: `0x${'aa'.repeat(32)}`, amountOs: '2500000000', nonce: 1, timestamp: 1791144000000, encoding: 'os-string' });
    const result = await session.request({ method: 'sendTransaction', params: [tx] });
    if (additionalFee === 0) {
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual([approvals, signatures, confirmations, broadcasts], [1, 1, 1, 1]);
    } else {
      assert.equal(result.success, false, JSON.stringify(result));
      const positiveFee = typeof additionalFee === 'number' && additionalFee > 0;
      assert.equal(result.error.code, positiveFee ? 'unsupported_node_fee' : 'unsupported');
      if (positiveFee) assert.match(result.error.message, /additional transaction fee.*wallet version cannot sign.*compatible wallet version/i);
      assert.deepEqual([approvals, signatures, confirmations, broadcasts], [0, 0, 0, 0]);
    }
  } finally { session.lock(); }
});
