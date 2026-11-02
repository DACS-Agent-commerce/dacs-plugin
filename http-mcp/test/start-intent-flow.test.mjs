// One Start approval through the plugin (DACS_INTENT_APPROVAL=on): MCP
// prepare_purchase, the intent routes and the real embedded SDK wallet behind
// its intent gate, against the offline DACS fixture seller and SR-2 fixture.
import http from 'node:http';
import { createApp } from '../src/app.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { gatedWallet, signedMessages } from './helpers/start-intent.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';

let h;
let skew = 0;
let n = 0;
before(async () => {
  h = await startProtocolHarness({ now: () => Date.now() + skew, env: { DACS_INTENT_APPROVAL: 'on', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '50', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '50', DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR: '500' } });
});
after(async () => h.close());

async function api(path, body) {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `request failed (${response.status})`), { code: data.error, status: response.status });
  return data;
}
const raw = async (path, body) => {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
};

async function buyer() {
  const w = await gatedWallet();
  const user = await linkPackagedWallet(h, w.session);
  return { ...w, user };
}
async function purchase(b, seller) {
  const p = await tool(h, b.user, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `intent-${++n}-${Date.now()}`, protocol: 'dacs-pay-dem' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  return { id: p.operationId, token: tokenFrom(p.approvalUrl) };
}
const start = (b, p, options = {}) => runStart({ id: p.id, token: p.token, address: b.address, gate: b.gate, api, origin: h.origin, ...options });
const op = (b, p) => h.app.services.ops.get(h.app.services.accounts.walletOwner(b.address), p.id);

test('switch on, happy path: one Start dialog, then identity, Agreement and anchor signatures with no further dialog', async () => {
  const b = await buyer();
  const seller = await addSeller(h, { listingId: `intent-happy-${++n}` });
  const p = await purchase(b, seller);
  const dialogs = b.dialogs.length, signed = signedMessages.length;
  const next = await start(b, p);
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next.evidence?.protocol?.lastAttempt));
  assert.equal(next.evidence.protocol.stage, 'committed');
  assert.deepEqual(b.dialogs.slice(dialogs).map((d) => d.method), ['approvePurchaseIntent'], 'exactly one wallet dialog');
  assert.equal(signedMessages.length, signed + 3, 'identity, Agreement and anchor authorization');
  const state = op(b, p).state.protocol;
  assert.equal(signedMessages[signed], state.identity.message, 'identity bytes as the server built them');
  assert.equal(signedMessages[signed + 1], state.planned.agreementMessage, 'Agreement bytes as the SDK planned them');
  assert.equal(signedMessages[signed + 2], state.planned.anchorMessage);
  assert.equal(b.gate.active, false, 'the intent ends with the Start');
  // Payment is untouched: its approval signature still gets the normal dialog.
  const challenge = await api(`/portal/api/purchase/${p.id}/challenge`, { token: p.token, address: b.address });
  const answer = await b.session.request({ method: 'sign', params: [challenge.message] });
  assert.equal(answer.success, true);
  assert.equal(b.dialogs.at(-1).method, 'sign');
  assert.equal(b.dialogs.at(-1).message, challenge.message);
});

test('a Start record replayed for another purchase or account, after expiry, after unlink or after a new Start is refused', async () => {
  const b = await buyer();
  const c = await buyer();
  const seller = await addSeller(h, { listingId: `intent-replay-${++n}` });
  const a = await purchase(b, seller);
  const other = await purchase(b, seller);
  const foreign = await purchase(c, seller);
  const begin = (who, p) => api(`/portal/api/purchase/${p.id}/intent/start`, { token: p.token, address: who.address });
  const plan = (p, record) => raw(`/portal/api/purchase/${p.id}/intent/plan`, { token: p.token, intent: record, signature: '' });
  const recordA = (await begin(b, a)).start.intent.id;
  await begin(b, other);
  await begin(c, foreign);
  for (const [name, target] of [['another purchase', other], ['another account', foreign]]) {
    const refused = await plan(target, recordA);
    assert.equal(refused.status, 409, name);
    assert.equal(refused.error, 'intent_refused', name);
    assert.match(refused.message, /belongs to another purchase or account/, name);
  }
  // A new Start replaces the old record.
  const recordA2 = (await begin(b, a)).start.intent.id;
  assert.equal((await plan(a, recordA)).error, 'intent_refused');
  assert.match((await plan(a, recordA)).message, /unknown or was replaced/);
  // After expiry.
  skew = 11 * 60 * 1000;
  try {
    const expired = await plan(a, recordA2);
    assert.equal(expired.error, 'intent_refused');
    assert.match(expired.message, /expired/);
  } finally { skew = 0; }
  // After the stored terms change under the record (defensive: terms are immutable).
  const recordT = (await begin(b, a)).start.intent.id;
  const hash = h.app.db.prepare('SELECT terms_hash FROM operations WHERE id = ?').get(a.id).terms_hash;
  h.app.db.prepare('UPDATE operations SET terms_hash = ? WHERE id = ?').run('0'.repeat(64), a.id);
  try {
    const changed = await plan(a, recordT);
    assert.equal(changed.error, 'intent_refused');
    assert.match(changed.message, /terms changed/);
  } finally { h.app.db.prepare('UPDATE operations SET terms_hash = ? WHERE id = ?').run(hash, a.id); }
  // After the wallet is unlinked from the account.
  const recordA3 = (await begin(b, a)).start.intent.id;
  const account = h.app.services.accounts.walletOwner(b.address);
  const row = h.app.db.prepare('SELECT * FROM wallets WHERE address = ?').get(b.address);
  h.app.db.prepare('DELETE FROM wallets WHERE address = ?').run(b.address);
  try {
    const unlinked = await plan(a, recordA3);
    assert.equal(unlinked.error, 'intent_refused');
    assert.match(unlinked.message, /no longer linked/);
    assert.equal((await raw(`/portal/api/purchase/${a.id}/intent/start`, { token: a.token, address: b.address })).error, 'wrong_wallet');
  } finally {
    h.app.db.prepare('INSERT INTO wallets (address, account_id, scheme, linked_at, link_challenge_id) VALUES (?, ?, ?, ?, ?)').run(row.address, account, row.scheme, row.linked_at, row.link_challenge_id);
  }
  // The wallet itself refuses another purchase's drafts under this intent.
  const signed = signedMessages.length;
  const swapped = (path, body) => (path.endsWith('/intent/start') ? api(path.replace(a.id, other.id), { ...body, token: other.token }).then((s) => ({ ...s, id: a.id, terms: s.terms, termsHash: s.termsHash })) : api(path, body));
  await assert.rejects(runStart({ id: a.id, token: a.token, address: b.address, gate: b.gate, api: swapped, origin: h.origin }), (error) => error.code === 'intent_mismatch' && error.field === 'job');
  assert.equal(signedMessages.length, signed, 'nothing signed for another purchase’s identity draft');
});

test('a server that changes the Agreement after the Start gets nothing signed, and the buyer is told why', async () => {
  const b = await buyer();
  const seller = await addSeller(h, { listingId: `intent-tamper-${++n}` });
  const p = await purchase(b, seller);
  const tampering = async (path, body) => {
    const r = await api(path, body);
    if (path.endsWith('/intent/plan')) r.plan.draft.terms.price.amount = '0.5';
    return r;
  };
  const signed = signedMessages.length;
  await assert.rejects(start(b, p, { api: tampering }), (error) => error.code === 'intent_mismatch' && error.field === 'price' && /Nothing was signed: the Agreement price is 0\.5 DEM/.test(error.message));
  assert.equal(signedMessages.length, signed + 1, 'only the identity presentation was signed');
  const state = op(b, p).state.protocol;
  assert.equal(state.stage, 'agreement-signing');
  assert.equal(state.signatures, undefined, 'no Agreement signature reached the server');
});

test('a reload in the middle asks again and resumes from the server state; nothing signs without a new approval', async () => {
  const b = await buyer();
  const seller = await addSeller(h, { listingId: `intent-reload-${++n}` });
  const p = await purchase(b, seller);
  // The page goes away right after the plan is saved.
  const reloadAfterPlan = async (path, body) => {
    const r = await api(path, body);
    if (path.endsWith('/intent/plan')) throw new Error('page reloaded');
    return r;
  };
  await assert.rejects(start(b, p, { api: reloadAfterPlan }), /page reloaded/);
  assert.equal(op(b, p).state.protocol.stage, 'agreement-signing');
  const mnemonic = b.session.exportMnemonicForUser();
  b.session.lock();
  const again = await gatedWallet({ mnemonic });
  assert.equal(again.address, b.address);
  // A fresh page has no approved intent: nothing signs.
  const draft = op(b, p).state.protocol.planned.draft;
  await assert.rejects(again.gate.signAgreement(draft), (error) => error.code === 'intent_mismatch' && error.field === 'intent');
  await assert.rejects(again.gate.signIdentity(op(b, p).state.protocol.identity.bundle), (error) => error.field === 'intent');
  const signed = signedMessages.length;
  const next = await runStart({ id: p.id, token: p.token, address: again.address, gate: again.gate, api, origin: h.origin });
  assert.deepEqual(again.dialogs.map((d) => d.method), ['approvePurchaseIntent'], 'asked again, once');
  assert.equal(signedMessages.length, signed + 2, 'Agreement and anchor only; the saved identity is checked, not re-signed');
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next.evidence?.protocol?.lastAttempt));
});

test('switch on, other wallets: the per-step routes and dialogs are unchanged', async () => {
  const b = await buyer();
  const seller = await addSeller(h, { listingId: `intent-perstep-${++n}` });
  const p = await purchase(b, seller);
  const sign = async (message) => { const r = await b.session.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const dialogs = b.dialogs.length;
  const identity = await api(`/portal/api/purchase/${p.id}/agreement/identity`, { token: p.token, address: b.address });
  const planned = await api(`/portal/api/purchase/${p.id}/agreement/plan`, { token: p.token, signature: await sign(identity.signRequest.message) });
  const next = await api(`/portal/api/purchase/${p.id}/agreement/sign`, { token: p.token, agreementSignature: await sign(planned.signRequest.agreementMessage), anchorSignature: await sign(planned.signRequest.anchorMessage) });
  assert.equal(next.status, 'awaiting_approval');
  assert.deepEqual(b.dialogs.slice(dialogs).map((d) => [d.method, d.message]), [['sign', identity.signRequest.message], ['sign', planned.signRequest.agreementMessage], ['sign', planned.signRequest.anchorMessage]], 'one dialog per signature, showing the exact bytes');
});

test('the intent routes keep main’s checks: wrong wallet, unsupported terms and unknown records are refused', async () => {
  const b = await buyer();
  const c = await buyer();
  const seller = await addSeller(h, { listingId: `intent-checks-${++n}` });
  const p = await purchase(b, seller);
  assert.equal((await raw(`/portal/api/purchase/${p.id}/intent/start`, { token: p.token, address: c.address })).error, 'wrong_wallet');
  assert.equal((await raw(`/portal/api/purchase/${p.id}/intent/start`, { token: 'x', address: b.address })).status, 404);
  assert.equal((await raw(`/portal/api/purchase/${p.id}/intent/sign`, { token: p.token, intent: 'nope', agreementSignature: 'aa' })).error, 'intent_refused');
  const started = await api(`/portal/api/purchase/${p.id}/intent/start`, { token: p.token, address: b.address });
  // main's plan check: a bad identity signature is refused with the intent too.
  assert.equal((await raw(`/portal/api/purchase/${p.id}/intent/plan`, { token: p.token, intent: started.start.intent.id, signature: '00'.repeat(64) })).error, 'bad_signature');
  const legacy = await tool(h, b.user, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `intent-legacy-${++n}` });
  assert.equal((await raw(`/portal/api/purchase/${legacy.operationId}/intent/start`, { token: tokenFrom(legacy.approvalUrl), address: b.address })).error, 'intent_unsupported');
});

test('closed access refuses intent start, plan and sign before any chain read', async (t) => {
  const b = await buyer(), seller = await addSeller(h, { listingId: 'intent-closed-access' });
  t.after(() => b.session.lock());
  const p = await purchase(b, seller);
  const started = await api(`/portal/api/purchase/${p.id}/intent/start`, { token: p.token, address: b.address });
  const before = op(b, p);
  // A second app reads the same durable purchase with the real closed-access
  // capability. No Start records survive reopening; access must be checked
  // before even the unknown-record refusal, signature checks or nonce reads.
  let reads = 0;
  const closed = await createApp({ config: h.config, dacsProtocol: {
    anchorUrl: h.anchors.url, sellerEndpoint: claim => h.endpoints.get(claim) ?? null,
    buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: seller.wallet.claim }),
  }, fetchImpl: (...args) => { reads++; return fetch(...args); } });
  const server = http.createServer(closed.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await closed.close(); });
  reads = 0;
  const dialogs = b.dialogs.length, signed = signedMessages.length;
  for (const step of ['start', 'plan', 'sign']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/portal/api/purchase/${p.id}/intent/${step}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: p.token, address: b.address, intent: started.start.intent.id }),
    });
    const data = await response.json();
    assert.equal(response.status, 409, step);
    assert.equal(data.error, 'buyer_access_closed', step);
    assert.match(data.message, /configured custody buyer/, step);
    assert.equal(data.start, undefined, step);
    assert.equal(data.plan, undefined, step);
    assert.equal(data.signRequest, undefined, step);
    assert.equal(reads, 0, `${step}: no chain, directory or seller read`);
    assert.deepEqual(op(b, p), before, `${step}: no saved purchase change`);
  }
  assert.equal(b.dialogs.length, dialogs);
  assert.equal(signedMessages.length, signed);
});
