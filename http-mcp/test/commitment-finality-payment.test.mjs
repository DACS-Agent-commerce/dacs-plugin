// Real production policy, loopback node fixture. No live network or keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agree, start } from './helpers/buyer-chain-readback-flow.mjs';
for (const buyerChainReadback of ['off', 'on']) test(`production payment holds despite a valid callback (${buyerChainReadback})`, { timeout: 120000 }, async t => {
  let calls = 0;
  const h = await start(t, { productionFinality: true, buyerChainReadback, commitOnSignature: true,
    verifyCommitmentFinality: async () => { calls++; return 'valid'; }, blockValidationData: { forged: 'no consensus proof' } });
  const f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.ok(h.transport.chain.wire.record.accepted.some(tx => tx.content.data?.[1]?.metadata?.artifactKind === 'FinalityCommitmentRecord'));
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await f.verify();
    assert.equal(result.status, 'agreement_pending');
    assert.match(f.operation().state.protocol.attempts.at(-1).reason, /finality is not established/);
    assert.match(result.next, /commitment finality is not independently established; payment remains held/);
    assert.doesNotMatch(result.next, /Awaiting the seller|approve the exact native DEM debit/);
    assert.equal(f.operation().state.protocol.commitment, undefined);
    assert.notEqual((await f.api('handoff')).httpStatus, 200);
    assert.equal(h.app.services.coordinates.get(f.id), null);
  }
  assert.equal(calls, 0, 'host callbacks are never payment authority');
  assert.equal(h.transport.chain.wire.record.accepted.filter(tx => tx.content.type === 'native').length, 0);
});
test('a native commitment saved before the hold, without finality, is held before status and approval', { timeout: 120000 }, async t => {
  const h = await start(t, { commitOnSignature: true });
  const f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal((await f.verify()).protocol.stage, 'seller-committed');
  const issued = await f.api('challenge', { address: f.address });
  assert.equal(issued.httpStatus, 200);
  const saved = f.operation();
  const { finality, ...legacyCommitment } = saved.state.protocol.commitment;
  assert.equal(finality, 'synthetic-fixture');
  h.app.services.ops.transition(f.id, 'awaiting_approval', 'awaiting_approval', { state: { protocol: { ...saved.state.protocol, commitment: legacyCommitment } } });
  const status = (await f.raw('get_purchase_status')).structuredContent;
  assert.equal(status.status, 'agreement_pending');
  assert.equal(status.protocol.stage, 'agreement-anchored');
  assert.match(status.next, /payment remains held/);
  const approved = await f.api('approve', { challengeId: issued.challengeId, signature: await f.sign(issued.message) });
  assert.notEqual(approved.httpStatus, 200);
  assert.equal(f.operation().status, 'agreement_pending');
});
