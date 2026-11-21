// Portal answers built from the client's saved state go through one projection: listed members only, signing
// and replay material omitted at any depth, and every saved string bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.mjs';
import { SAVED_STRING_LIMIT } from '../src/portal/saved-state-view.mjs';
import { purchaseOperation, purchaseService, startPortal } from './helpers/portal-world.mjs';

const SECRET_NAMES = ['signature', 'signedTransaction', 'signedBytes', 'privateKey', 'seed', 'mnemonic', 'capability', 'token', 'replay'];

function memberNames(value, names = new Set()) {
  if (value && typeof value === 'object') for (const [name, member] of Object.entries(value)) { names.add(name); memberNames(member, names); }
  return names;
}
function strings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object') for (const member of Object.values(value)) strings(member, found);
  return found;
}

test('a purchase view, status and readback answer built from saved state holding nested replay or signing material and a 70,000-character string omit the first and truncate the second, with a fixed member list', async (t) => {
  const long = 'L'.repeat(70_000);
  const base = purchaseOperation('op-relay', 'payment_handoff');
  const operation = {
    ...base,
    terms: { ...base.terms, listing: { listingId: 'listing-1', title: long, anchor: { signature: 'sig-in-terms' } }, unlistedMember: 'dropped',
      protocol: { jobId: 'job-1', replay: { body: 'replayable request' }, agreement: { signedBytes: 'aa', parts: [{ signedTransaction: { content: 'tx' }, note: long }] } } },
  };
  const evidence = { listingMode: 'simulated-fixture', next: long, protocol: { stage: 'paid', bundle: { buyerSignature: 'kept-name', signature: 'sig-in-evidence', token: 'tok' } }, unlistedEvidence: 'dropped' };
  const { service } = purchaseService({ operation, answers: { protocolRecheck: { operation }, reportWalletResult: { operation, verification: { outcome: 'pending' } } } });
  service.portalEvidence = () => evidence;
  const db = openDatabase(':memory:');
  const portal = await startPortal({ db, purchases: service });
  t.after(async () => { await portal.close(); db.close(); });

  for (const path of ['view', 'report', 'protocol/recheck']) {
    const answer = await portal.post(path, { txHash: 'a'.repeat(64) });
    assert.equal(answer.status, 200, path);
    const { terms, evidence: shown } = answer.body;
    for (const name of SECRET_NAMES) assert.equal(memberNames({ terms, shown }).has(name), false, `${path}: ${name}`);
    assert.equal(Object.hasOwn(terms, 'unlistedMember'), false);
    assert.equal(Object.hasOwn(shown, 'unlistedEvidence'), false);
    assert.equal(terms.buyer.wallet, base.terms.buyer.wallet);
    assert.equal(terms.protocol.jobId, 'job-1');
    assert.equal(shown.protocol.bundle.buyerSignature, 'kept-name');
    for (const value of strings({ terms, shown })) assert.ok(value.length <= SAVED_STRING_LIMIT + 32, `${path}: a ${value.length}-character string`);
    assert.ok(terms.listing.title.startsWith('LLLL') && terms.listing.title.length < long.length);
    assert.ok(shown.next.length < long.length);
    assert.doesNotMatch(JSON.stringify(answer.body), /sig-in-terms|sig-in-evidence|replayable request/);
  }
});
