import test from 'node:test';
import assert from 'node:assert/strict';
const journal = async options => (await import('../public/portal-intent/signature-journal.mjs')).createSignatureJournal(options);
// IDB's single-store add uniqueness/serialized transaction contract, with
// separate DB handles over one retained store (reload and separate tabs).
function substrate() {
  const claims = new Map();
  return { claims, indexedDB: { open() {
    const req = {};
    queueMicrotask(() => { req.result = { transaction() {
      const tx = { objectStore: () => ({ add(value, key) {
        queueMicrotask(() => {
          if (claims.has(key)) { tx.error = new Error('ConstraintError'); tx.onabort(); }
          else {claims.set(key, value); tx.oncomplete();}
        });
      }, put(value, key) { queueMicrotask(() => {claims.set(key, value); tx.oncomplete();}); } }) }; return tx;
    } }; req.onsuccess(); }); return req;
  } } };
}
const intent = {record: 'rec_1', wallet: 'wallet', account: 'account', purchase: 'purchase', job: 'job', termsHash: 'hash'};
test('a reload cannot request the same signature again under the same Start record', async () => {
  const s = substrate(); const first = await journal(s); let requests = 0;
  await first(intent, 'agreement'); requests++;
  const reload = await journal(s);
  await assert.rejects(reload(intent, 'agreement'), e => e.field === 'journal');
  await assert.rejects(reload({...intent, termsHash: 'changed'}, 'agreement'), e => e.field === 'journal');
  assert.equal(requests, 1); assert.equal(s.claims.size, 1);
});
test('a new Start record is a new approval: it may claim the same step again, once', async () => {
  const s = substrate(); const claim = await journal(s);
  await claim(intent, 'agreement');
  const reload = await journal(s);
  await reload({...intent, record: 'rec_2'}, 'agreement');
  await assert.rejects(reload({...intent, record: 'rec_2'}, 'agreement'), e => e.field === 'journal');
  assert.equal(s.claims.size, 2);
});
test('durable storage availability is reported before any Start', async () => {
  assert.equal(await (await journal(substrate())).available(), true);
  assert.equal(await (await journal({indexedDB: null})).available(), false);
});
test('two tab journals claim a logical step only once', async () => {
  const s = substrate();
  const results = await Promise.allSettled([(await journal(s))(intent, 'identity'), (await journal(s))(intent, 'identity')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.field === 'journal').length, 1);
});
test('unavailable durable storage refuses before requesting any signature', async () => {
  let requests = 0; const claim = await journal({indexedDB: null});
  await assert.rejects(claim(intent, 'identity').then(() => requests++), e => e.field === 'journal');
  assert.equal(requests, 0);
});
