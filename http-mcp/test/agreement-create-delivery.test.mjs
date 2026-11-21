import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { DEVNET_AGREEMENT_KIND, DEVNET_AGREEMENT_PROFILE } from '@kynesyslabs/dacs-client';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { PURPOSES } from '../src/wallet/challenges.mjs';
import { transaction } from '../src/store/database.mjs';
import { deriveDispatchHistory } from '../public/portal/embedded-wallet/effect-records.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { deliveryWorld, serveDelivery, signedClaim, installedProtocol, hashOf, SIGNED_HASH, signedHistory, HOUR } from './helpers/create-delivery-world.mjs';
import { openHeldTransport, seedPurchase } from './helpers/relay-world.mjs';

let held, journalDir;
before(async () => {
  held = await openHeldTransport();
  journalDir = mkdtempSync(join(tmpdir(), 'create-client-journal-'));
  held.journal = openDurableWalletJournal({ path: join(journalDir, 'journal.db'), mode: 'create' });
});
after(async () => { held?.journal.close(); await held?.close(); if (journalDir) rmSync(journalDir, { recursive: true, force: true }); });
function worldFor(t, options) { const world = deliveryWorld(options); t.after(() => world.close()); return world; }
function fileFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'create-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'app.db');
}
const row = w => w.db.prepare('SELECT * FROM agreement_create_deliveries').get();
const count = w => w.db.prepare('SELECT count(*) AS n FROM agreement_create_deliveries').get().n;
const relayMint = w => () => w.relayAccess.mint({ operationId: 'purchase', phases: ['rpc'], expiresAt: w.starts.current('purchase').expiresAt });
const claimDirect = (w, start = w.start(), consume = () => {}, mintRelay = relayMint(w)) => {
  w.delivery.bindStart({ operationId: 'purchase', start });
  return transaction(w.db, () => w.delivery.claim({ operationId: 'purchase', start, consume, mintRelay }));
};
async function claimedWorld(t, options) {
  const w = worldFor(t, options); await w.send(); const post = await serveDelivery(t, w);
  const answer = await post('claim', await signedClaim(post, w)); assert.equal(answer.status, 200);
  return { w, post, answer: answer.body };
}
const passBody = (w, history = signedHistory, hash = SIGNED_HASH) => {
  const start = { ...w.start(), recovery: true };
  const get = w.starts.get;
  w.starts.get = id => id === start.id ? start : get(id);
  w.starts.current = () => start;
  return { token: 'purchase', start: start.id, hash, history };
};
async function clientAction(work) {
  try { return await work(); } catch (error) {
    if (error.code !== 'profile_not_admitted') throw error;
    throw new Error('profile_not_admitted from @kynesyslabs/dacs-client@0.1.0-alpha.0', { cause: error });
  }
}
async function killAt(t, w, point, challenge) {
  const child = fork(new URL('./fixtures/create-delivery-worker.mjs', import.meta.url), [JSON.stringify({ path: w.path, point, wallet: w.wallet.address,
    journalPath: join(w.path, '..', 'child-journal.db'), ...challenge })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(() => { throw new Error(stderr || 'child exited before crash point'); })]);
  assert.equal(message.point, point); assert.equal(message.journalCalls, 0);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

test("a purchase at agreement-signing gets exactly one CREATE delivery holding the client's exact request bytes, kind and request hash", async t => {
  const w = worldFor(t); const answer = await w.send();
  assert.equal(answer.error.code, 'outcome_unknown'); assert.equal(count(w), 1);
  assert.equal(Buffer.from(row(w).request_bytes).toString(), canonicalize(w.request));
  assert.equal(row(w).request_hash, hashOf(canonicalize(w.request))); assert.equal(row(w).kind, DEVNET_AGREEMENT_KIND);
  assert.equal(Buffer.from(row(w).delivery_id, 'base64url').length, 16);
  for (const patch of [{ kind: 'unrecognized' }, { profile: 'unrecognized' }, { transaction: 'x'.repeat(65536) }]) assert.equal((await w.send({ ...w.request, ...patch })).error.code, 'delivery_refused');
  assert.equal((await w.delivery.walletFactoryFor('purchase')({}).request({ method: 'sign', params: [] })).error.code, 'delivery_refused');
  assert.equal(count(w), 1);
});

test("a claim needs the purchase's handoff token and the bound wallet's signature over a challenge from the real challenge service, and another account, wallet or operation is refused not_found with nothing handed out", async t => {
  const w = worldFor(t); await w.send(); const post = await serveDelivery(t, w);
  for (const token of ['wrong', 'another-account', '']) assert.deepEqual((await post('challenge', { token, start: w.start().id })).body, { error: 'not_found', message: 'not_found' });
  seedPurchase(w.db, { operationId: 'other-purchase', accountId: 'other-account', wallet: createEphemeralWallet().address });
  assert.deepEqual((await post('challenge', { token: 'purchase', start: w.start().id }, { id: 'other-purchase' })).body, { error: 'not_found', message: 'not_found' });
  const body = await signedClaim(post, w);
  assert.equal((await post('claim', { ...body, signature: createEphemeralWallet().signHex('different message') })).body.error, 'bad_signature');
  w.db.prepare('DELETE FROM wallets').run();
  assert.deepEqual((await post('claim', body)).body, { error: 'not_found', message: 'not_found' }); assert.equal(row(w).state, 'issued');
});

test("a second claim of the same delivery returns its state and no request bytes, also after a restart", async t => {
  const path = fileFor(t), first = deliveryWorld({ path }); await first.send(); const original = claimDirect(first), wallet = first.wallet; first.close();
  const w = worldFor(t, { path, seed: false, wallet }), post = await serveDelivery(t, w);
  const repeated = await post('claim', { token: 'purchase', challengeId: 'unused', signature: 'unused' });
  assert.deepEqual(repeated.body, { delivery: { id: original.delivery.id, state: 'claimed' } }); assert.equal(count(w), 1);
});

test("a claim past its Start's expiry or for a closed purchase is refused with the delivery's state and no bytes", async t => {
  for (const closed of [false, true]) {
    const w = worldFor(t); await w.send(); const start = w.start(); w.delivery.bindStart({ operationId: 'purchase', start });
    if (closed) w.db.prepare("UPDATE operations SET status = 'cancelled'").run(); else w.clock.at = start.expiresAt;
    let consumed = 0; const answer = transaction(w.db, () => w.delivery.claim({ operationId: 'purchase', start, consume: () => consumed++, mintRelay: relayMint(w) }));
    assert.equal(answer.delivery.state, closed ? 'closed' : 'expired'); assert.equal(answer.request, undefined); assert.equal(consumed, 0);
  }
});

test("two concurrent claims of one delivery hand the request to exactly one of them", async t => {
  const w = worldFor(t); await w.send(); const post = await serveDelivery(t, w), start = w.start();
  const first = await signedClaim(post, w, start), second = await signedClaim(post, w, start);
  const answers = await Promise.all([post('claim', first), post('claim', second)]);
  assert.equal(answers.filter(a => a.body.request).length, 1);
  assert.equal(w.db.prepare('SELECT count(*) AS n FROM challenges WHERE consumed_at IS NOT NULL').get().n, 1);
});

test("the journal capability minted at claim is stored hashed and grants no claim, challenge or pass on its own", async t => {
  const { w, post, answer } = await claimedWorld(t);
  assert.notEqual(row(w).journal_capability_hash, answer.journalCapability);
  assert.equal(w.delivery.admitJournal({ operationId: 'purchase', presented: answer.journalCapability }).id, answer.delivery.id);
  assert.throws(() => w.delivery.admitJournal({ operationId: 'purchase', presented: 'wrong' }), { code: 'not_found' });
  for (const action of ['challenge', 'claim', 'pass']) {
    const body = action === 'challenge' ? { token: 'wrong', start: w.start().id } : action === 'claim' ? { token: 'wrong', challengeId: 'none', signature: 'none' } : passBody(w);
    if (action === 'pass') body.token = 'wrong';
    assert.equal((await post(action, body, { journal: answer.journalCapability })).status, 404);
  }
});

test("the claim returns the relay capability before the wallet's first relay call", async t => {
  const { w, answer } = await claimedWorld(t);
  assert.equal(w.relayAccess.admit({ presented: answer.relayAccess.capability, wallet: w.wallet.address, phase: 'rpc' }).live, true);
  assert.ok(Date.parse(answer.relayAccess.expiresAt) <= row(w).claim_expires_at);
});

test("challenge, claim and pass bodies over 64 KiB, extra or missing members and non-canonical JSON are refused before any state is read", async t => {
  const w = worldFor(t); const post = await serveDelivery(t, w);
  const valid = { challenge: { token: 'purchase', start: 'start' }, claim: { token: 'purchase', challengeId: 'challenge', signature: 'signature' }, pass: { token: 'purchase', start: 'start', hash: SIGNED_HASH, history: [] } };
  w.purchases.portalOperation = () => { throw new Error('state was read'); };
  for (const [action, body] of Object.entries(valid)) for (const raw of [JSON.stringify(body, null, 2), canonicalize({ ...body, extra: true }), '{}', '{"padding":"' + 'x'.repeat(65536) + '"}', 'null', '[]', Buffer.concat([Buffer.from('{"token":"'), Buffer.from([255]), Buffer.from('","start":"start"}')])]) {
    const result = await post(action, raw, { raw: true }); assert.equal(result.status, 400); assert.equal(result.body.error, 'invalid_request');
  }
});

test("the delivery, challenge, claim and pass routes log no capability, challenge signature or request bytes", async t => {
  const { w, post, answer } = await claimedWorld(t); await post('claim', { token: 'purchase', challengeId: 'bad', signature: 'signature-private-value' });
  await post('pass', passBody(w), { journal: answer.journalCapability });
  const logs = w.logger.lines.join('\n');
  for (const value of [answer.journalCapability, answer.relayAccess.capability, answer.request, 'signature-private-value']) assert.equal(logs.includes(value), false);
});

test("a crash after the claim and before the wallet's answer leaves the delivery claimed, with no second claim and no second request delivery", async t => {
  const path = fileFor(t), before = worldFor(t, { path }); before.path = path; await before.send();
  const challenge = before.challenges.issue({ purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, address: before.wallet.address, accountId: 'acct-relay', binding: {} });
  await killAt(t, before, 'committed', { challengeId: challenge.challengeId, signature: before.wallet.signHex(challenge.message) });
  before.close(); const w = worldFor(t, { path, seed: false, wallet: before.wallet });
  assert.equal(row(w).state, 'claimed'); assert.equal(claimDirect(w).request, undefined); assert.equal(count(w), 1);
});

test("the wallet-request seam records the delivery and returns outcome_unknown at once, and Agreement submission through the installed client resolves to the queued pending operation and its delivery id while every challenge and claim call is withheld", async t => {
  const w = worldFor(t); const protocol = installedProtocol(w, held);
  const operation = await clientAction(() => protocol.submitAgreement(w.load()));
  assert.equal(operation.state.protocol.stage, 'agreement-pending'); assert.ok(w.delivery.forOperation(operation.id));
});

test("after submission has resolved, the same delivery is claimed sequentially through the installed client, and a later explicit recheck reconciles it by readback with exactly one delivery", async t => {
  const w = worldFor(t), protocol = installedProtocol(w, held);
  await clientAction(() => protocol.submitAgreement(w.load()));
  const post = await serveDelivery(t, w); const claimed = await post('claim', await signedClaim(post, w)); assert.ok(claimed.body.request);
  await protocol.recheck(w.load()); assert.equal(count(w), 1);
});

test("after a lost Agreement-submit response, with no process killed, /view readback with only the account session and the handoff token returns the same retained delivery id, and a resubmission records no second delivery", async t => {
  const w = worldFor(t); await w.send(); const post = await serveDelivery(t, w); const view = await post('view', { token: 'purchase' });
  assert.deepEqual(view.body.delivery, { id: row(w).delivery_id, state: 'issued' });
  await w.send(); assert.deepEqual((await post('view', { token: 'purchase' })).body.delivery, view.body.delivery); assert.equal(count(w), 1);
});

test("the challenge route issues an agreement-create-claim challenge binding account, purchase, wallet, terms hash, Agreement hash, current Start, delivery, request hash and expiry, and refuses another account, another purchase or a dead Start", async t => {
  const w = worldFor(t); await w.send(); const post = await serveDelivery(t, w), start = w.start();
  const answer = await post('challenge', { token: 'purchase', start: start.id }); assert.equal(answer.status, 200);
  for (const value of ['purpose: agreement-create-claim', 'account: acct-relay', 'operation: purchase', `address: ${w.wallet.address}`, 'terms-hash: terms', 'agreement-hash: agreement-hash', `start: ${start.id}`, `delivery: ${row(w).delivery_id}`, `request-hash: ${row(w).request_hash}`, `delivery-expires: ${row(w).claim_expires_at}`]) assert.ok(answer.body.message.includes(value), value);
  const newer = w.start(); assert.equal((await post('challenge', { token: 'purchase', start: start.id })).body.error, 'start_not_live');
  assert.equal((await post('challenge', { token: 'purchase', start: newer.id }, { id: 'foreign' })).status, 404);
});

test("a claim whose challenge names another delivery, request hash or Start, an expired challenge, a replayed challenge and the loser of two concurrent claims each fail before any bytes are handed out, and a challenge is consumed only together with the claim's CAS", async t => {
  const w = worldFor(t); await w.send(); const post = await serveDelivery(t, w), start = w.start();
  const body = await signedClaim(post, w, start);
  const stored = JSON.parse(w.db.prepare('SELECT binding FROM challenges WHERE id = ?').get(body.challengeId).binding);
  for (const key of ['delivery', 'request-hash', 'start']) {
    w.db.prepare('UPDATE challenges SET binding = ? WHERE id = ?').run(JSON.stringify({ ...stored, [key]: 'foreign' }), body.challengeId);
    assert.equal((await post('claim', body)).body.error, 'binding_mismatch');
    assert.equal(w.db.prepare('SELECT consumed_at FROM challenges WHERE id = ?').get(body.challengeId).consumed_at, null);
  }
  w.db.prepare('UPDATE challenges SET binding = ? WHERE id = ?').run(JSON.stringify(stored), body.challengeId);
  w.clock.at += 60000; assert.equal((await post('claim', body)).body.error, 'challenge_expired');
  const replayed = await signedClaim(post, w, start);
  w.challenges.verifyAndConsume({ challengeId: replayed.challengeId, purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, expectedBinding: {}, signature: replayed.signature, consumedBy: 'purchase' });
  assert.equal((await post('claim', replayed)).body.error, 'challenge_replayed');
  const fresh = await signedClaim(post, w, start); assert.ok((await post('claim', fresh)).body.request);
  assert.equal((await post('claim', fresh)).body.request, undefined);
});

test("an unclaimed delivery follows the purchase's newer live Start for the same account, wallet and terms, and a claimed delivery never moves to another Start", async t => {
  const w = worldFor(t); await w.send(); const start = w.start(); w.delivery.bindStart({ operationId: 'purchase', start });
  const next = w.start(); assert.equal(w.starts.get(start.id)?.id, start.id);
  assert.equal(w.delivery.bindStart({ operationId: 'purchase', start }), false);
  assert.equal(w.delivery.bindStart({ operationId: 'purchase', start: next }), true); claimDirect(w, next);
  const claimed = row(w); assert.equal(w.delivery.bindStart({ operationId: 'purchase', start: w.start() }), false);
  assert.equal(row(w).start_record_id, claimed.start_record_id);
});

test("a child process killed after the delivery commit and before any response restarts, /view with only the account session and the handoff token returns the retained delivery id, and the challenge and claim then succeed for that one delivery with no replacement delivery", async t => {
  const path = fileFor(t), before = worldFor(t, { path }); before.path = path;
  await killAt(t, before, 'delivery'); before.close();
  const w = worldFor(t, { path, seed: false, wallet: before.wallet });
  const post = await serveDelivery(t, w); const view = await post('view', { token: 'purchase' }); assert.equal(view.body.delivery.id, row(w).delivery_id);
  assert.ok((await post('claim', await signedClaim(post, w))).body.request); assert.equal(count(w), 1);
});

test("with the real app store and the installed public journal, a failure injected after challenge consumption and after the delivery CAS, and a process kill at each commit boundary, leave the consumption, the claimed state and the capability hashes all committed or all rolled back, also for two concurrent claims, and the claim makes no client-journal call", async t => {
  for (const point of ['consumed', 'claimed', 'capabilities', 'committed']) {
    const path = fileFor(t), w = worldFor(t, { path }); w.path = path; await w.send();
    const challenge = w.challenges.issue({ purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, address: w.wallet.address, accountId: 'acct-relay', binding: {} });
    await killAt(t, w, point, { challengeId: challenge.challengeId, signature: w.wallet.signHex(challenge.message) });
    const committed = point === 'committed';
    w.close(); const restarted = worldFor(t, { path, seed: false, wallet: w.wallet });
    assert.equal(row(restarted).state, committed ? 'claimed' : 'issued'); assert.equal(Boolean(row(restarted).journal_capability_hash), committed);
    assert.equal(Boolean(restarted.db.prepare('SELECT consumed_at FROM challenges WHERE id = ?').get(challenge.challengeId).consumed_at), committed);
    assert.equal(restarted.db.prepare('SELECT count(*) AS n FROM relay_capabilities').get().n, committed ? 1 : 0);
  }
  const w = worldFor(t); await w.send(); const start = w.start();
  for (const point of ['consume', 'mint']) {
    const failure = new Error('injected claim failure');
    const challenge = w.challenges.issue({ purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, address: w.wallet.address, accountId: 'acct-relay', binding: {} });
    const consume = () => {
      w.challenges.verifyAndConsume({ challengeId: challenge.challengeId, purpose: PURPOSES.AGREEMENT_CREATE_CLAIM, expectedBinding: {}, signature: w.wallet.signHex(challenge.message), consumedBy: 'purchase' });
      if (point === 'consume') throw failure;
    };
    assert.throws(() => claimDirect(w, start, consume, () => { throw failure; }), error => error === failure);
    assert.equal(row(w).state, 'issued'); assert.equal(row(w).journal_capability_hash, null);
    assert.equal(w.db.prepare('SELECT consumed_at FROM challenges WHERE id = ?').get(challenge.challengeId).consumed_at, null);
  }
});

test("after a server restart, a claimed delivery whose history proves no possible earlier broadcast gets one pass binding from a new live Start with its journal capability, effect authority holds again, a fresh relay capability is returned, and no request bytes, claim or change to the claim binding follow, a delivery whose only browser-stage record is broadcast-started with a wholly withheld broadcast history gets that pass too, and each pass event binds the retained hash and the canonical presented-history digest also when no dispatch intent exists", async t => {
  for (const history of [signedHistory, [...signedHistory, { seq: 2, kind: 'broadcast-started', stage: 'broadcast', passId: 'pass' }, { seq: 3, kind: 'broadcast-withheld', stage: 'broadcast', passId: 'pass' }]]) {
    const path = fileFor(t);
    const first = await claimedWorld(t, { path }); const answer = first.answer, wallet = first.w.wallet;
    const binding = row(first.w).start_record_id; first.w.close();
    const w = worldFor(t, { path, wallet, seed: false }), post = await serveDelivery(t, w);
    assert.equal(w.delivery.effectAuthority('purchase').reason, 'expired');
    w.delivery.appendEvent({ deliveryId: answer.delivery.id, kind: 'browser-stage', body: { stage: 'broadcast-started', hash: SIGNED_HASH } });
    const body = passBody(w, history); const passed = await post('pass', body, { journal: answer.journalCapability });
    assert.equal(passed.status, 200, JSON.stringify(passed.body)); assert.equal(passed.body.request, undefined); assert.equal(row(w).start_record_id, binding);
    const event = w.delivery.events(answer.delivery.id).at(-1);
    assert.equal(event.body.hash, SIGNED_HASH); assert.equal(event.body.withheldDigest, hashOf(canonicalize(history))); assert.deepEqual(w.delivery.effectAuthority('purchase'), { ok: true });
    assert.equal(w.relayAccess.admit({ presented: passed.body.relayAccess.capability, wallet: w.wallet.address, phase: 'rpc' }).live, true);
  }
});

test("a delivery whose events hold a browser-stage broadcast-accepted or whose presented history holds an earlier possible broadcast, including an unmatched intent followed by a different pass's withheld record, an unknown or unmatched confirmation, a malformed or other-hash history, a pass without the journal capability (a lost claim response), a dead, foreign or other-terms Start, a closed operation and a ninth pass are each refused with nothing appended", async t => {
  const { w, post, answer } = await claimedWorld(t); const body = passBody(w);
  assert.equal((await post('pass', body)).status, 404);
  const options = { journal: answer.journalCapability };
  assert.equal((await post('pass', { ...body, start: 'dead' }, options)).body.error, 'start_not_live');
  const recovery = w.starts.current('purchase');
  for (const patch of [{ accountId: 'another-account' }, { operationId: 'another-operation' }, { termsHash: 'another-terms' }, { wallet: createEphemeralWallet().address }, { expiresAt: w.clock.now() }]) {
    assert.throws(() => w.delivery.appendPass({ operationId: 'purchase', start: { ...recovery, ...patch }, hash: SIGNED_HASH, history: signedHistory, mintRelay: relayMint(w) }), { code: 'start_not_live' });
  }
  assert.throws(() => w.delivery.appendPass({ operationId: 'purchase', start: { ...recovery, recovery: false }, hash: SIGNED_HASH, history: signedHistory, mintRelay: relayMint(w) }), { code: 'start_not_recovery' });
  w.db.prepare("UPDATE operations SET status = 'cancelled'").run();
  assert.equal((await post('pass', body, options)).body.error, 'closed');
  w.db.prepare("UPDATE operations SET status = 'agreement_pending'").run();
  const unclaimed = worldFor(t); await unclaimed.send();
  assert.throws(() => unclaimed.delivery.appendPass({ operationId: 'purchase', start: unclaimed.start(), hash: SIGNED_HASH, history: signedHistory, mintRelay: relayMint(unclaimed) }), { code: 'not_claimed' });
  const histories = [[...signedHistory, { seq: 2, kind: 'broadcast-started', stage: 'broadcast', passId: 'old' }, { seq: 3, kind: 'broadcast-withheld', stage: 'broadcast', passId: 'other' }],
    [...signedHistory, { seq: 2, kind: 'confirm-started', stage: 'confirm', passId: 'old' }], [...signedHistory, { seq: 2, kind: 'confirm-acknowledged', stage: 'confirm', passId: 'old' }], [], Array(65).fill(signedHistory[0]), [{ ...signedHistory[0], hash: 'another' }]];
  for (const history of histories) assert.ok((await post('pass', { ...body, history }, { journal: answer.journalCapability })).status >= 400);
  for (let i = 0; i < 8; i++) assert.equal((await post('pass', body, { journal: answer.journalCapability })).status, 200);
  assert.equal((await post('pass', body, { journal: answer.journalCapability })).body.error, 'pass_limit');
  const eventCount = w.delivery.events(answer.delivery.id).length;
  w.delivery.appendEvent({ deliveryId: answer.delivery.id, kind: 'browser-stage', body: { stage: 'broadcast-accepted' } });
  assert.equal((await post('pass', body, { journal: answer.journalCapability })).body.error, 'readback_only');
  assert.equal(w.delivery.events(answer.delivery.id).length, eventCount + 1);
});

test('the wallet-request seam records the delivery and returns outcome_unknown at once', async t => {
  const w = worldFor(t); let settled = false; const pending = w.send().then(answer => { settled = true; return answer; });
  assert.equal(count(w), 1); await Promise.resolve(); assert.equal(settled, true); assert.equal((await pending).error.code, 'outcome_unknown');
});

test('another buyer or job gets delivery_unbound and nothing is recorded', async t => {
  const w = worldFor(t), factory = w.delivery.walletFactoryFor('purchase');
  assert.equal(factory({}).getPublicAccount().address, w.wallet.address);
  assert.deepEqual(factory({}).getWriteProfile(), { profile: DEVNET_AGREEMENT_PROFILE, network: 'testnet', transactionKinds: [DEVNET_AGREEMENT_KIND] });
  for (const patch of [{ owner: createEphemeralWallet().claim }, { jobId: 'another-job' }]) assert.equal((await w.send({ ...w.request, ...patch })).error.code, 'delivery_unbound');
  assert.equal(count(w), 0); assert.throws(() => w.delivery.walletFactoryFor('unknown'), { code: 'delivery_unbound' });
});

test('two purchases with different buyers each get their own protocol object', t => {
  const w = worldFor(t), other = createEphemeralWallet(); seedPurchase(w.db, { operationId: 'other', wallet: other.address });
  const a = w.delivery.walletFactoryFor('purchase'), b = w.delivery.walletFactoryFor('other');
  assert.notEqual(installedProtocol(w, held, a), installedProtocol(w, held, b));
  assert.equal(a({}).getPublicAccount().address, w.wallet.address); assert.equal(b({}).getPublicAccount().address, other.address);
});

test('a wallet without getPublicAccount or getWriteProfile fails construction with wallet-required', t => {
  const w = worldFor(t), wallet = w.delivery.walletFactoryFor('purchase')({});
  for (const missing of ['getPublicAccount', 'getWriteProfile']) {
    const incomplete = { ...wallet }; delete incomplete[missing];
    assert.throws(() => installedProtocol(w, held, () => incomplete), error => error.code === 'wallet-required');
  }
});

test('a second buyer on one protocol object is refused by the client', async t => {
  const w = worldFor(t), protocol = installedProtocol(w, held), other = createEphemeralWallet();
  const operation = w.load(); operation.terms.buyer.wallet = other.address;
  const result = await clientAction(() => protocol.submitAgreement(operation)); assert.equal(result.error?.code, 'wrong-writer'); assert.equal(count(w), 0);
});

test('a kill between the client handoff commit and the delivery commit leaves no delivery, reissues no handoff, and the purchase stays read-back-only', async t => {
  const w = worldFor(t), protocol = installedProtocol(w, held);
  await clientAction(() => protocol.recheck(w.load())); assert.equal(w.delivery.forOperation('purchase'), null);
});

test('a claim whose answer is lost stays claimed, gets no second delivery and no bytes, and a pass without the journal capability is refused', async t => {
  const { w, post } = await claimedWorld(t); await w.send(); const repeated = await post('claim', { token: 'purchase', challengeId: 'lost', signature: 'lost' });
  assert.deepEqual(Object.keys(repeated.body), ['delivery']); assert.equal(repeated.body.delivery.state, 'claimed'); assert.equal(count(w), 1);
  assert.equal((await post('pass', passBody(w))).status, 404);
});

test('a pass whose answer is lost grants no send and no claim, and a retry is bound by the retained pass history and the limit of eight', async t => {
  const { w, post, answer } = await claimedWorld(t); const body = passBody(w); const options = { journal: answer.journalCapability };
  const lost = await post('pass', body, options), retry = await post('pass', body, options);
  assert.equal(retry.status, 200); assert.equal(retry.body.request, undefined); assert.equal(retry.body.pass.seq, lost.body.pass.seq + 1);
  assert.throws(() => w.relayAccess.admit({ presented: lost.body.relayAccess.capability, wallet: w.wallet.address, phase: 'rpc' }), { code: 'relay_access_denied' });
  for (let i = 2; i < 8; i++) assert.equal((await post('pass', body, options)).status, 200);
  assert.equal((await post('pass', body, options)).body.error, 'pass_limit');
});

test('the server pass verdict equals deriveDispatchHistory for every presented history in the table', async t => {
  const histories = [signedHistory, ...['dispatch', 'confirm', 'broadcast'].map(stage => [...signedHistory, { seq: 2, kind: 'signed-held', stage, passId: 'held' }]), [], [...signedHistory, { seq: 2, kind: 'observed', passId: 'observation' }],
    ...['broadcast', 'dispatch', 'confirm'].flatMap(stage => ['withheld', 'unknown', 'acknowledged'].map(phase => [...signedHistory,
      { seq: 2, kind: `${stage}-started`, stage, passId: 'attempt' }, { seq: 3, kind: `${stage}-${phase}`, stage, passId: 'attempt' }]))];
  for (const history of histories) {
    const w = worldFor(t);
    const verdict = deriveDispatchHistory(history), allowed = verdict.signed && verdict.neverDispatched && verdict.confirmation !== 'unknown';
    w.db.prepare('DELETE FROM agreement_create_events').run(); w.db.prepare('DELETE FROM agreement_create_deliveries').run();
    await w.send(); claimDirect(w); const body = passBody(w, history);
    const append = () => transaction(w.db, () => w.delivery.appendPass({ operationId: 'purchase', start: w.starts.current('purchase'), hash: body.hash, history, mintRelay: relayMint(w) }));
    if (allowed) assert.ok(append()); else assert.throws(append);
  }
});

test('a failed delivery insert propagates its cause and leaves no delivery', async t => {
  const w = worldFor(t); w.db.exec("CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON agreement_create_deliveries BEGIN SELECT RAISE(ABORT, 'delivery disk failure'); END");
  await assert.rejects(w.send(), /delivery disk failure/); assert.equal(count(w), 0);
});

test('effect gates run before state and keep the binding cause', async t => {
  const w = worldFor(t), post = await serveDelivery(t, w);
  w.purchases.portalOperation = () => { throw new Error('state was read'); };
  for (const [patch, error, cause] of [[{ on: false }, 'sdk_purchases_off'], [{ on: true, cause: 'tp1_local_binding_changed' }, 'profile_not_admitted', 'tp1_local_binding_changed'], [{ cause: null, stopped: true }, 'writes_stopped']]) {
    Object.assign(w.gateState, patch);
    const result = await post('challenge', { token: 'purchase', start: 'start' }); assert.equal(result.status, 409); assert.equal(result.body.error, error);
    if (cause) assert.equal(result.body.cause, cause);
  }
});

test('effect authority requires a claimed open purchase and its current unexpired Start', async t => {
  const w = worldFor(t); await w.send(); assert.deepEqual(w.delivery.effectAuthority('purchase'), { ok: false, reason: 'not_claimed' });
  const start = w.start(); claimDirect(w, start); assert.deepEqual(w.delivery.effectAuthority('purchase'), { ok: true });
  w.clock.at = start.expiresAt; assert.equal(w.delivery.effectAuthority('purchase').reason, 'expired'); w.clock.at -= HOUR;
  w.db.prepare("UPDATE operations SET status = 'cancelled'").run(); assert.equal(w.delivery.effectAuthority('purchase').reason, 'closed');
});


test('a Start expiry is clamped to the handoff before any claim can consume its challenge', async t => {
  const w = worldFor(t); await w.send(); const start = w.start();
  w.db.prepare('UPDATE operations SET handoff_expires_at = ?').run(new Date(w.clock.now() + 1000).toISOString());
  w.delivery.bindStart({ operationId: 'purchase', start });
  assert.equal(Number(row(w).claim_expires_at), w.clock.now() + 1000);
  w.clock.at += 1000; let consumed = false;
  const answer = w.delivery.claim({ operationId: 'purchase', start, consume: () => { consumed = true; }, mintRelay: relayMint(w) });
  assert.equal(answer.delivery.state, 'expired'); assert.equal(consumed, false);
});

test('a missing delivery stays absent on authenticated readback and refuses a claim challenge', async t => {
  const w = worldFor(t), post = await serveDelivery(t, w);
  assert.equal((await post('view', { token: 'purchase' })).body.delivery, null);
  assert.equal((await post('challenge', { token: 'purchase', start: w.start().id })).body.error, 'delivery_missing');
  assert.equal(count(w), 0);
});

test('a failed recovery capability mint rolls back the pass and preserves the earlier relay capability', async t => {
  const { w, answer } = await claimedWorld(t), body = passBody(w);
  const before = w.delivery.events(answer.delivery.id);
  w.relayAccess = { ...w.relayAccess, mint: () => { throw new Error('capability store failure'); } };
  const post = await serveDelivery(t, w);
  assert.equal((await post('pass', body, { journal: answer.journalCapability })).status, 500);
  assert.deepEqual(w.delivery.events(answer.delivery.id), before);
  assert.equal(w.relayAccess.admit({ presented: answer.relayAccess.capability, wallet: w.wallet.address, phase: 'rpc' }).live, true);
});

test('a failed Start rebind keeps the previous binding', async t => {
  const w = worldFor(t); await w.send(); const start = w.start(); w.delivery.bindStart({ operationId: 'purchase', start });
  const before = row(w);
  w.db.exec("CREATE TEMP TRIGGER fail_rebind BEFORE UPDATE ON agreement_create_deliveries BEGIN SELECT RAISE(ABORT, 'binding store failure'); END");
  assert.throws(() => w.delivery.bindStart({ operationId: 'purchase', start: w.start() }), /binding store failure/);
  assert.equal(row(w).start_record_id, before.start_record_id); assert.equal(row(w).claim_expires_at, before.claim_expires_at);
});
