// Effect-boundary regression: a purchase cancelled while the exact bytes to
// sign are being stored ahead of the signature (the write-ahead store change,
// after the write mark) gets no Vet signature. Pins "no await between the
// synchronous purchase check and the signer" (a mutant that moves the check
// before that store change fails it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPartyVet as setup } from './helpers/party-vet-fixture.mjs';

for (const role of ['buyer', 'seller']) {
  test(`cancelled while the ${role} record's bytes are written ahead: no ${role} signature`, { timeout: 120000 }, async (t) => {
    const s = await setup(t, { durable: true });
    const { ctl } = s;
    ctl.sellerAuto = true;
    let cancelledAt = null;
    // After the store change that first records signedBytes for this role,
    // before that change's await returns to the signer path.
    ctl.afterStoreUpdate = (n, row) => {
      const signing = Object.values(row?.ops?.[role]?.signing ?? {});
      if (cancelledAt === null && signing.some((entry) => entry.signedBytes !== undefined && entry.signature === undefined)) { cancelledAt = n; ctl.writable = 'purchase is cancelled'; }
    };
    const before = ctl.recordSignatures;
    const out = await s.plan(Date.now());
    t.diagnostic(JSON.stringify({ cancelledAt, out: out.disposition, reason: out.reason, signatures: ctl.recordSignatures - before }));
    assert.ok(cancelledAt !== null, 'the write-ahead change was reached');
    assert.notEqual(out.disposition, 'present');
    assert.equal(ctl.recordSignatures - before, role === 'buyer' ? 0 : 1, `no ${role} record signature after the cancellation`);
    assert.equal(s.acceptedFor(role === 'buyer' ? ctl.buyerAddr : ctl.sellerAddr), 0, `no ${role} CREATE`);
  });
}
