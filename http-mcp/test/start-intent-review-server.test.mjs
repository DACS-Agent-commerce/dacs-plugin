import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartIntents } from '../src/portal/start-intent.mjs';
import { fixturePurchase } from './helpers/start-intent.mjs';
const address = '0x' + 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function server() {
  const p = fixturePurchase({ address, devnet: true });
  const operation = { id: p.id, accountId: 'acct_test_1', terms: p.terms, termsHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86400000).toISOString(), state: { protocol: { listing: p.listing, identity: { bundle: {} } } } };
  let linked = true; const reads = [];
  const chain = { async getAddressNonce() { const d = deferred(); reads.push(d); return d.promise; } };
  const purchases = { portalOperation: () => operation, agreementIdentity: async () => ({ operation }), agreementPlan: async () => ({ operation }) };
  const records = createStartIntents({ purchases, accounts: { walletOwner: () => linked ? operation.accountId : null }, chain });
  const routes = new Map(); records.mount({ post: (path, _json, handler) => routes.set(path.split('/').at(-1), handler) }, { api: x => x, json: null, purchaseView: (_op, extra) => extra, address: x => x });
  return { operation, reads, records, unlink() { linked = false; }, start: () => routes.get('start')({ params: { id: p.id }, body: { address, token: 'token' } }) };
}
const tick = () => new Promise(r => setImmediate(r));
test('unlink during the Start nonce read issues no record', async () => {
  const s = server(); const pending = s.start(); const rejected = assert.rejects(pending, e => e.code === 'intent_refused');
  await tick(); assert.equal(s.reads.length, 1); s.unlink(); s.reads[0].resolve(0); await rejected;
});
test('concurrent Starts use arrival order even when the older nonce finishes last', async () => {
  const s = server(); const older = s.start(); await tick(); const newer = s.start(); await tick();
  const rejected = assert.rejects(older, e => e.code === 'intent_refused');
  s.reads[1].resolve(0); const issued = await newer; s.reads[0].resolve(0); await rejected;
  assert.equal(s.records.admit(s.operation.id, 'token', issued.start.intent.id).id, s.operation.id);
});
test('arrival of a newer pending Start revokes the earlier issued record immediately', async () => {
  const s = server(); const first = s.start(); await tick(); s.reads[0].resolve(0); const issued = await first;
  const second = s.start(); await tick();
  try { assert.throws(() => s.records.admit(s.operation.id, 'token', issued.start.intent.id), e => e.code === 'intent_refused'); }
  finally { s.reads[1].resolve(0); await second; }
});
