import test from 'node:test';
import assert from 'node:assert/strict';
import { devnetAgreementTransportFlow } from './helpers/devnet-agreement-transport-flow.mjs';

test('source broker journals buyer authorization before seller signs and overlaps the pending buyer broadcast', async t => {
  let signed, resolve, check, w, reachedBroadcast = false;
  const signature = new Promise(r => { resolve = r; });
  w = await devnetAgreementTransportFlow(t, { commitOnSignature: true,
    beforeNativeBroadcast: async () => {
      reachedBroadcast = true;
      await Promise.race([signature, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('no early seller signature')), 10000); timer.unref(); })]);
    },
    sellerOptions: { onSign(bytes) {
      if (!bytes.toString().startsWith('dacs-finality-commitment:v1:')) return;
      signed = true;
      check = w.h.journal.entries().then(entries => {
        const rows = entries.filter(([key, r]) => key.startsWith('sr2/wallet/') && r.approved?.logicalAddress === w.op().state.protocol.walletAnchor.logicalAddress);
        assert.equal(rows.length, 1); assert.ok(rows[0][1].signedTransaction);
      }).catch(error => ({ error }));
      resolve();
    } } });
  await w.agreement({ beforeWalletApproval: () => {
    assert.equal(signed, undefined, 'no seller signing before wallet approval');
    assert.equal(w.seller.anchorWrites.length, 0);
  } });
  assert.equal(await check, undefined, 'journal is durable before seller signing'); assert.equal(signed, true); assert.equal(reachedBroadcast, true);
  assert.equal(w.seller.anchorWrites.length, 1);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1);
  await w.seller.restart();
  assert.equal((await w.seller.agent.commit({ jobId: w.op().terms.protocol.jobId })).status, 'committed', 'seller can reauthenticate retained CREATE bytes without buyer-supplied evidence after restart');
  assert.equal(w.seller.anchorWrites.length, 1);
});
