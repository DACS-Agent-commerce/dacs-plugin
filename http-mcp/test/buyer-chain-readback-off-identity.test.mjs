// DACS_BUYER_CHAIN_READBACK=off (the default) preserves the base capture after
// asserting the two intended commitment safety metadata changes below, and
// except for the MCP tool descriptions, which now state that payment is held
// (the tools digest is the only recorded digest that differs from the base):
// tool output, routes, Agreement and artifact
// bytes, transport bindings, seller answers and every journal and database row.
// The expected digests are written by scripts/buyer-chain-readback-identity.mjs
// from the merge base's src/ with this test overlaid, and only once the base
// and merged-tree captures are byte-identical. The purchase runs twice, with
// fresh keys, ids and clocks: values both runs share are kept literally and
// only run-random ones are replaced, relation-preservingly; every request and
// row is kept in wire order (buyer-chain-readback-identity.mjs).
// DACS_TEST_RECORD_IDENTITY=<file> writes the normalized capture instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { agree, handoff, payAndDeliver, start } from './helpers/buyer-chain-readback-flow.mjs';
import { captureIdentity, normalizeRuns, sectionDigests } from './helpers/buyer-chain-readback-identity.mjs';

// The fixture keeps one SHA-256 per section. Record mode writes the whole
// capture so a mismatch can be diffed.
const EXPECTED = new URL('./fixtures/buyer-chain-readback-off-identity.json', import.meta.url);

// Preserve the original digests. Only the commitment's old substrate label and
// newly added finality field differ under the explicit TEST finality authority.
// Check those exact values before projecting them back to the base contract;
// every other field, string and row must still compare byte for byte.
function baseIdentity(capture) {
  let commitments = 0;
  function visit(value) {
    if (typeof value === 'string') {
      let parsed;
      try { parsed = JSON.parse(value); } catch { return value; }
      const before = commitments;
      const projected = visit(parsed);
      return commitments === before ? value : JSON.stringify(projected);
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    const copy = Object.fromEntries(Object.entries(value).map(([key, part]) => [key, visit(part)]));
    const commitment = copy.commitment;
    if (commitment && typeof commitment === 'object' && Object.hasOwn(commitment, 'verifiedAt')) {
      assert.deepEqual(Object.keys(commitment), ['address', 'ref', 'contentHash', 'signer', 'committedAt', 'verifiedAt', 'substrate', 'finality']);
      assert.equal(commitment.substrate, 'source-native-one-node');
      assert.equal(commitment.finality, 'synthetic-fixture', 'only the isolated TEST finality policy permits the synthetic purchase');
      commitment.substrate = 'simulated-fixture';
      delete commitment.finality;
      commitments += 1;
    }
    return copy;
  }
  const result = visit(capture);
  assert.ok(commitments > 0, 'the safety metadata was present and checked');
  return result;
}

// One full switch-off purchase on its own harness, captured raw.
async function purchase(t) {
  // A long seller timeout keeps a loaded host from adding retry rows to either run.
  const h = await start(t, { sellerRequestTimeoutMs: 120000 });
  assert.notEqual(h.config.buyerChainReadback, 'on');
  const commitAnswers = []; h.testHooks.afterSellerCommit = (answer) => commitAnswers.push(answer);
  const f = await agree(t, h);
  const committed = await f.raw('verify_deal');
  assert.equal(committed.structuredContent?.protocol?.stage, 'seller-committed', JSON.stringify(committed.structuredContent));
  const { txHash } = await payAndDeliver(h, f, await handoff(f));
  const repeated = await f.raw('verify_deal'), status = await f.raw('get_purchase_status');
  assert.equal(repeated.structuredContent?.protocol?.stage, 'delivery-ready');
  const sellerAnswer = await h.composition.sellerAgent.submitPayment({ jobId: f.operation().terms.protocol.jobId, txHash, payerPayingKey: f.buyerActor.signer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
  return captureIdentity(h, { tools: await f.listTools(), toolOutputs: { prepare: f.preparedRaw, committed, delivered: repeated, status }, commitAnswers, sellerAnswer, operation: f.operation() });
}

test('switch off: only the enumerated commitment safety metadata differs from the base tree', { timeout: 840000 }, async (t) => {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK; delete process.env.DACS_BUYER_CHAIN_READBACK;
  t.after(() => { if (previous !== undefined) process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  const capture = normalizeRuns([baseIdentity(await purchase(t)), baseIdentity(await purchase(t))]);
  if (process.env.DACS_TEST_RECORD_IDENTITY) { writeFileSync(process.env.DACS_TEST_RECORD_IDENTITY, `${JSON.stringify(capture, null, 1)}\n`); return; }
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8')).sections, actual = sectionDigests(capture);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) assert.equal(actual[key], expected[key], `${key} differs from the base tree (record with DACS_TEST_RECORD_IDENTITY and diff)`);
});
