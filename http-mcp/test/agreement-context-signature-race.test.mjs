// Gated two-provider race. The store guarantees one
// immutable byte string and deterministic signature value, not one signer call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPartyVet, deferred } from './helpers/party-vet-fixture.mjs';

test('two providers signing the same written-ahead bytes retain one signature value and at most one CREATE per party', { timeout: 180000 }, async t => {
  const s = await setupPartyVet(t, { durable: true });
  s.ctl.sellerAuto = true;
  const a = s.provider, b = s.restart(), release = deferred();
  let entered = 0;
  s.ctl.onSign = async () => {
    entered += 1;
    if (entered === 2) release.resolve();
    if (entered <= 2) await release.p;
  };
  const results = await Promise.all([
    s.plan(Date.now(), s.buyerBundle, { via: a }),
    s.plan(Date.now() + 1, s.buyerBundle, { via: b }),
  ]);
  t.diagnostic(JSON.stringify({ entered, dispositions: results.map(r => r.disposition) }));
  const buyerBytes = s.ctl.signed[0].bytes;
  const buyerCalls = s.ctl.signed.filter(entry => entry.bytes === buyerBytes);
  assert.equal(buyerCalls.length, 2, 'both providers invoke the buyer signer');
  assert.equal(entered, 3, 'two buyer calls and one seller call in this gated race');
  assert.equal(s.ctl.recordSignatures, 3);
  assert.equal(new Set(buyerCalls.map(entry => entry.signature)).size, 1, 'deterministic repeated signature');
  assert.equal(new Set(s.ctl.signed.map(entry => entry.bytes)).size, 2, 'one byte string per party');
  const rows = await s.vetState();
  assert.equal(rows.length, 1, 'one durable job row');
  for (const role of ['buyer', 'seller']) {
    assert.equal(Object.keys(rows[0].ops[role].signing).length, 1, 'one signing record per party');
    assert.ok(s.acceptedFor(s.ctl[`${role}Addr`]) <= 1, 'at most one CREATE per party');
  }
  s.restart();
  assert.equal((await s.plan(Date.now() + 1000)).disposition, 'present');
  assert.equal(s.ctl.recordSignatures, 3, 'the retained signatures need no further signer call');
  assert.equal(s.acceptedFor(s.ctl.buyerAddr), 1);
  assert.equal(s.acceptedFor(s.ctl.sellerAddr), 1);
});

test('a nondeterministic repeat signer fails closed against a concurrently stored signature, without a CREATE or a second record', { timeout: 180000 }, async t => {
  const s = await setupPartyVet(t, { durable: true });
  s.ctl.sellerAuto = true;
  const secondEntered = deferred(), stored = deferred(), finishFirst = deferred();
  t.after(() => finishFirst.resolve());
  let calls = 0;
  const signBytes = async bytes => {
    calls += 1;
    if (calls === 1) { await secondEntered.p; return s.seller.signer.signBytes(bytes); }
    assert.equal(calls, 2, 'only two buyer calls before refusal');
    secondEntered.resolve();
    await stored.p;
    const different = Buffer.from(s.seller.signer.signBytes(bytes));
    different[0] ^= 1;
    return different;
  };
  const a = s.build({ signBytes, afterStoreUpdate: async (_n, row) => {
    if (Object.values(row?.ops?.buyer?.signing ?? {}).some(entry => entry.signature)) {
      stored.resolve(); await finishFirst.p;
    }
  } });
  const b = s.build({ signBytes });
  const first = s.plan(Date.now(), s.buyerBundle, { via: a });
  const second = await s.plan(Date.now() + 1, s.buyerBundle, { via: b });
  assert.equal(calls, 2);
  assert.equal(new Set(s.ctl.signed.map(entry => entry.bytes)).size, 1, 'both calls signed the same stored bytes');
  assert.equal(new Set(s.ctl.signed.map(entry => entry.signature)).size, 2, 'the second call returned a different signature');
  assert.equal(second.disposition, 'indeterminate', JSON.stringify(second));
  assert.match(second.reason, /^DEM delivery context failed: buyer Vet record write failed \(conflict: another record is already retained for this address\); /);
  assert.ok(s.ctl.writerLog.some(line => line.includes('the signer gave another signature for the same written-ahead bytes')));
  const [row] = await s.vetState();
  const records = Object.values(row.ops.buyer.signing);
  assert.equal(records.length, 1);
  assert.equal(Object.keys(row.ops.seller.signing).length, 0);
  assert.equal((await s.vetState()).length, 1);
  assert.equal(records[0].signature, Buffer.from(s.ctl.signed[0].signature, 'hex').toString('base64url'), 'the first signature remains intact');
  assert.equal(s.acceptedFor(s.ctl.buyerAddr), 0);
  assert.equal(s.acceptedFor(s.ctl.sellerAddr), 0);
  assert.equal(s.ctl.anchorCalls.publish, 0, 'neither provider published while the first signature checkpoint was held');
  // The refused signature never becomes a record. Release the first caller
  // after cancellation so cleanup can unwind without a CREATE.
  s.ctl.writable = 'purchase is cancelled';
  finishFirst.resolve();
  await first;
  assert.equal(s.accepted(), 1, 'Listing only, even after the first caller unwinds');
});
