// Embedded wallet: when the node refuses to confirm a transaction, the
// confirm_rejected message carries the node's reason, cut to a fixed length and
// stripped of control characters. Offline: the Demos node is replaced by an
// in-process subclass of the SDK class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkWalletSession, TRANSPORT_PROFILE } from '../public/portal/embedded-wallet/sdk-provider.mjs';

globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/' };
globalThis.location = new URL('http://127.0.0.1/');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const PAYEE = `0x${'71'.repeat(32)}`;
const AMOUNT_OS = '2000000000';
const RPC_URL = 'http://127.0.0.1/portal/api/wallet-rpc';
const REFUSAL_PREFIX = 'the node refused to validate this transaction; it was not broadcast';

function nativeSend(from) {
  return {
    content: { type: 'native', from, to: PAYEE, amount: AMOUNT_OS, nonce: 1, data: ['native', { nativeOperation: 'send', args: [PAYEE, AMOUNT_OS] }] },
    signature: null, hash: '', status: '', blockNumber: null,
  };
}

const NETWORK_INFO = { chainId: 7, forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } } };
const NETWORK_PARAMETERS = { networkFee: 1, rpcFee: 0 };

// The real SDK class with its node calls replaced: the node reports the
// post-denomination network and refuses to confirm with the given message.
function demosRefusingConfirm(message) {
  return class extends Demos {
    async connect(url) { this.rpc_url = url; return true; }
    async nodeCall(name) { return name === 'getNetworkParameters' ? NETWORK_PARAMETERS : null; }
    async getNetworkInfo() { return NETWORK_INFO; }
    async confirm() { throw new Error(message); }
  };
}

async function sendRefusedByNode(t, confirmMessage) {
  const wallet = createSdkWalletSession({
    DemosCtor: demosRefusingConfirm(confirmMessage),
    IdentitiesCtor: Identities,
    validateMnemonic,
    approve: async () => true,
    transactionTransport: { profile: TRANSPORT_PROFILE, network: 'simulated-test', rpcUrl: RPC_URL },
  });
  await wallet.create();
  t.after(() => wallet.lock());
  return wallet.request({ method: 'sendTransaction', params: [nativeSend(wallet.getPublicAccount().address)] });
}

test('a confirm refusal keeps the node reason in the confirm_rejected message', async (t) => {
  const res = await sendRefusedByNode(t, '[Confirm] Transaction is not valid: nonce too low');
  assert.equal(res.error.code, 'confirm_rejected');
  assert.equal(res.error.message, `${REFUSAL_PREFIX}: Transaction is not valid: nonce too low`);
});

test('a long confirm refusal reason is cut to 200 characters', async (t) => {
  const res = await sendRefusedByNode(t, `[Confirm] ${'x'.repeat(5000)}`);
  assert.equal(res.error.code, 'confirm_rejected');
  assert.equal(res.error.message, `${REFUSAL_PREFIX}: ${'x'.repeat(200)}`);
});

test('control characters are removed from a confirm refusal reason', async (t) => {
  const res = await sendRefusedByNode(t, '[Confirm] bad\u0000 nonce\r\n\u001b[31mred\u007f\u0085\u202e end');
  assert.equal(res.error.code, 'confirm_rejected');
  assert.equal(res.error.message, `${REFUSAL_PREFIX}: bad nonce[31mred end`);
});

test('a confirm refusal with no reason text keeps the fixed message', async (t) => {
  const res = await sendRefusedByNode(t, '[Confirm]  \u0007 ');
  assert.equal(res.error.code, 'confirm_rejected');
  assert.equal(res.error.message, REFUSAL_PREFIX);
});

test('an error that is not a confirm refusal is not echoed', async (t) => {
  const res = await sendRefusedByNode(t, 'socket hang up with internal detail');
  assert.equal(res.error.code, 'upstream_unavailable');
  assert.ok(!res.error.message.includes('internal detail'));
});
