// The native wallet relay admits only the wallet bound to a live purchase handoff, through a capability minted
// with the handoff and presented in the x-dacs-relay-access header. The relay runs over the client's own held
// transport facade, so while the client holds purchase actions every active call is refused profile_not_admitted
// and only the passive readback reads the transport's retained record; the node double answers nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/store/database.mjs';
import { RELAY_LIVE_LIMIT, RELAY_PHASES, RelayAccessError, createRelayAccess } from '../src/wallet/relay-access.mjs';
import { BINDING_PATH, BUYER, HOUR, OTHER_WALLET, RPC_PATH, START, TX_HASH, nodeRead, openHeldTransport, readback, release, seedPurchase, startRelay, testClock } from './helpers/relay-world.mjs';
import { purchaseOperation, purchaseService, startPortal } from './helpers/portal-world.mjs';

let held;
before(async () => { held = await openHeldTransport(); });
after(async () => { await held.close(); });

async function relayWorld(t, { purchases = [{ operationId: 'op-relay' }], wrapAccess = (access) => access } = {}) {
  const db = openDatabase(':memory:');
  for (const purchase of purchases) seedPurchase(db, purchase);
  const clock = testClock();
  const access = createRelayAccess({ db, now: clock.now });
  const relay = await startRelay({ db, transport: held.transport, clock, relayAccess: wrapAccess(access) });
  const sentBefore = held.nodeRequests.length;
  t.after(async () => { await relay.close(); db.close(); });
  return {
    db, clock, relay, access,
    mint: (operationId = 'op-relay', phases = RELAY_PHASES) => access.mint({ operationId, phases }).capability,
    nodeRequestsSent: () => held.nodeRequests.length - sentBefore,
  };
}

// What each answer shows about how far the call went.
const refusedByRelay = (answer) => answer.status === 403 && answer.body?.error === 'relay_access_denied';
const readFromRetainedRecord = (answer) => answer.status === 500 && answer.body?.error === 'not_issued';
const heldByClient = (answer) => answer.status === 409 && answer.body?.error === 'profile_not_admitted';
const reachedTransport = (answer) => readFromRetainedRecord(answer) || heldByClient(answer);
const settles = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let turn = 0; turn < 1000 && !condition(); turn += 1) await settles();
  assert.ok(condition(), 'the awaited state was not reached');
}

test("a relay call carrying a live capability for the purchase's bound wallet is forwarded once to the client's native transport", async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  assert.ok(readFromRetainedRecord(await w.relay.post(BINDING_PATH, readback(), capability)));
  assert.ok(heldByClient(await w.relay.post(BINDING_PATH, release(), capability)));
  assert.ok(heldByClient(await w.relay.post(RPC_PATH, nodeRead, capability)));
  assert.equal(w.nodeRequestsSent(), 0);
});

test("a relay call with no capability, an unknown one or another purchase's capability is refused relay_access_denied and forwards nothing", async (t) => {
  const w = await relayWorld(t, { purchases: [{ operationId: 'op-relay' }, { operationId: 'op-other', accountId: 'acct-other', wallet: OTHER_WALLET }] });
  const unknown = createHash('sha256').update('never minted').digest('base64url');
  const answers = [];
  for (const capability of [undefined, '', 'too-short', `${unknown}=`, unknown]) {
    answers.push(await w.relay.post(BINDING_PATH, readback(), capability), await w.relay.post(BINDING_PATH, release(), capability), await w.relay.post(RPC_PATH, nodeRead, capability));
  }
  // Another purchase's capability for this purchase's wallet (an RPC read names no wallet and no purchase).
  const other = w.mint('op-other');
  answers.push(await w.relay.post(BINDING_PATH, readback(), other), await w.relay.post(BINDING_PATH, release(), other));
  // A phase outside the capability's set.
  answers.push(await w.relay.post(BINDING_PATH, release(), w.mint('op-relay', ['readback'])), await w.relay.post(RPC_PATH, nodeRead, w.mint('op-relay', ['readback'])));
  for (const answer of answers) assert.ok(refusedByRelay(answer), JSON.stringify(answer));
  assert.equal(new Set(answers.map((answer) => JSON.stringify(answer.body))).size, 1, 'every refusal has the same body');
  const capability = w.mint();
  assert.deepEqual(await w.relay.post(BINDING_PATH, readback(), capability, { origin: 'https://elsewhere.test' }), { status: 403, body: { error: 'wrong_origin' } });
  assert.deepEqual(await w.relay.post(BINDING_PATH, { ...readback(), consumedByHash: TX_HASH }, capability), { status: 400, body: { error: 'invalid_params' } });
  assert.equal(w.nodeRequestsSent(), 0);
});

test('a capability past its handoff expiry is refused, and readback with it answers only from the retained record', async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  w.clock.at = START + HOUR;
  assert.ok(refusedByRelay(await w.relay.post(RPC_PATH, nodeRead, capability)));
  assert.ok(refusedByRelay(await w.relay.post(BINDING_PATH, { phase: 'bind', address: BUYER }, capability)));
  // Readback goes to the transport's passive retained-record read, never to walletBinding (which the hold refuses).
  assert.ok(readFromRetainedRecord(await w.relay.post(BINDING_PATH, readback(), capability)));
  // Releasing a lease never signs or resends, so it still reaches the transport.
  assert.ok(heldByClient(await w.relay.post(BINDING_PATH, release(), capability)));
  assert.throws(() => w.mint(), RelayAccessError, 'a handoff past its expiry gets no capability');
  assert.equal(w.nodeRequestsSent(), 0);
});

test("a relay body naming a wallet other than the capability's wallet is refused before the transport is called", async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  for (const body of [readback(OTHER_WALLET), release(OTHER_WALLET), readback(BUYER.toUpperCase().replace('0X', '0x')), { phase: 'readback', hash: TX_HASH }]) {
    assert.ok(refusedByRelay(await w.relay.post(BINDING_PATH, body, capability)), JSON.stringify(body));
  }
  assert.equal(w.nodeRequestsSent(), 0);
});

test('capabilities are stored hashed and survive restart, and a pre-restart capability works only inside its window', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db');
  const seeded = openDatabase(path);
  seedPurchase(seeded, { operationId: 'op-relay' });
  seeded.close();
  // Minted by another process, which then exits.
  const mintScript = `
    const { openDatabase } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/store/database.mjs')).href)});
    const { createRelayAccess, RELAY_PHASES } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/wallet/relay-access.mjs')).href)});
    const db = openDatabase(${JSON.stringify(path)});
    process.stdout.write(JSON.stringify(createRelayAccess({ db, now: () => ${START} }).mint({ operationId: 'op-relay', phases: RELAY_PHASES })));
    db.close();`;
  const minted = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', mintScript], { encoding: 'utf8' }));
  assert.equal(minted.expiresAt, new Date(START + HOUR).toISOString());

  const db = openDatabase(path);
  const rows = db.prepare('SELECT * FROM relay_capabilities').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capability_hash, createHash('sha256').update(`dacs-relay-access:${minted.capability}`).digest('hex'));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(minted.capability), 'the capability itself is never stored');
  const clock = testClock(START + 1);
  const relay = await startRelay({ db, transport: held.transport, clock });
  t.after(async () => { await relay.close(); db.close(); });
  assert.ok(heldByClient(await relay.post(RPC_PATH, nodeRead, minted.capability)));
  assert.ok(readFromRetainedRecord(await relay.post(BINDING_PATH, readback(), minted.capability)));
  clock.at = Date.parse(minted.expiresAt);
  assert.ok(refusedByRelay(await relay.post(RPC_PATH, nodeRead, minted.capability)));
  assert.ok(readFromRetainedRecord(await relay.post(BINDING_PATH, readback(), minted.capability)));
});

test('a relay body over 64 KiB is refused before parsing', async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  const oversized = JSON.stringify({ ...readback(), padding: 'x'.repeat(70 * 1024) });
  for (const path of [BINDING_PATH, RPC_PATH]) {
    assert.equal((await w.relay.post(path, oversized, capability)).status, 413);
    // Without a well-formed capability the body is not read at all.
    assert.ok(refusedByRelay(await w.relay.post(path, oversized)));
  }
  assert.equal(w.nodeRequestsSent(), 0);
});

test('the access log and relay logs never contain the capability value', async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  await w.relay.post(BINDING_PATH, readback(), capability);
  await w.relay.post(BINDING_PATH, release(), capability);
  await w.relay.post(RPC_PATH, nodeRead, capability);
  await w.relay.post(BINDING_PATH, readback(OTHER_WALLET), capability);
  await w.relay.post(BINDING_PATH, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), capability);
  w.clock.at = START + HOUR;
  await w.relay.post(RPC_PATH, nodeRead, capability);
  assert.ok(w.relay.logger.lines.length > 0, 'the relay logged its failures');
  for (const line of [...w.relay.logger.lines, ...w.relay.requestTargets]) assert.doesNotMatch(line, new RegExp(capability));
});

test('two concurrent relay calls on one capability reach the transport in order and never as two broadcasts of the same bytes', async (t) => {
  const admitted = [];
  const w = await relayWorld(t, { wrapAccess: (access) => ({ ...access, admit: (request) => { admitted.push(request.phase); return access.admit(request); } }) });
  const capability = w.mint();
  // Holding the node connection's fence keeps the first call inside the transport.
  const fence = await held.owner.acquireConnectionFence();
  const settled = [];
  const first = w.relay.post(BINDING_PATH, readback(), capability).then((answer) => { settled.push('first'); return answer; });
  await until(() => admitted.length === 2);
  const second = w.relay.post(BINDING_PATH, readback(), capability).then((answer) => { settled.push('second'); return answer; });
  await until(() => admitted.length === 3);
  for (let turn = 0; turn < 50; turn += 1) await settles();
  assert.equal(admitted.length, 3, 'the second call waits in the relay, unadmitted for the transport, while the first is inside it');
  fence.release();
  assert.ok(readFromRetainedRecord(await first));
  assert.ok(readFromRetainedRecord(await second));
  assert.deepEqual(settled, ['first', 'second']);
  assert.equal(admitted.length, 4);
  assert.equal(w.nodeRequestsSent(), 0, 'nothing was broadcast');
});

test('an upstream failure answers 500 with the outcome-unknown body and never a status the wallet SDK retries', async (t) => {
  const closed = await openHeldTransport();
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  const clock = testClock();
  const relay = await startRelay({ db, transport: closed.transport, clock });
  t.after(async () => { await relay.close(); db.close(); await closed.close(); });
  const capability = relay.relayAccess.mint({ operationId: 'op-relay', phases: RELAY_PHASES }).capability;
  // The node connection is gone: the transport cannot read, and nothing is retried.
  closed.owner.close();
  const answer = await relay.post(BINDING_PATH, readback(), capability);
  assert.equal(answer.status, 500);
  assert.equal(answer.body.error, 'transport_closed');
  assert.match(answer.body.message, /nothing is retried/);
  assert.equal(closed.nodeRequests.length, 0);
  for (const body of [readback(), release(), nodeRead]) {
    const path = body === nodeRead ? RPC_PATH : BINDING_PATH;
    assert.ok(![502, 503, 504].includes((await relay.post(path, body, capability)).status));
  }
});

test('bind, signature and execute calls are refused relay_access_denied and send nothing to the node', async (t) => {
  const w = await relayWorld(t);
  const capability = w.mint();
  const execute = (extra) => ({ method: 'execute', params: [{ extra, data: { hash: TX_HASH } }] });
  for (const [path, body] of [[BINDING_PATH, { phase: 'bind', address: BUYER }], [BINDING_PATH, { phase: 'signature', address: BUYER, hash: TX_HASH }],
    [RPC_PATH, execute('confirmTx')], [RPC_PATH, execute('broadcastTx')]]) {
    assert.ok(refusedByRelay(await w.relay.post(path, body, capability)), JSON.stringify(body));
  }
  assert.equal(w.nodeRequestsSent(), 0);
});

test('a repeated handoff recovers relay access for the same live handoff, account, operation and wallet, keeping at most four live capabilities', async (t) => {
  const db = openDatabase(':memory:');
  seedPurchase(db, { operationId: 'op-relay' });
  const clock = testClock();
  const relayAccess = createRelayAccess({ db, now: clock.now });
  // The client re-issues the same payload while its nonce fence holds.
  const { service, calls } = purchaseService({ operation: purchaseOperation('op-relay', 'payment_handoff'), answers: { prepareHandoff: { operation: purchaseOperation('op-relay', 'payment_handoff'), payload: { hash: TX_HASH } } } });
  const portal = await startPortal({ db, purchases: service, relayAccess });
  t.after(async () => { await portal.close(); db.close(); });
  const handoffs = [];
  for (let attempt = 0; attempt < RELAY_LIVE_LIMIT + 1; attempt += 1) handoffs.push(await portal.post('handoff'));
  assert.equal(calls.filter(({ name }) => name === 'prepareHandoff').length, RELAY_LIVE_LIMIT + 1);
  const capabilities = handoffs.map(({ status, body }) => { assert.equal(status, 200); return body.relayAccess.capability; });
  assert.equal(new Set(capabilities).size, capabilities.length);
  assert.throws(() => relayAccess.admit({ presented: capabilities[0], wallet: BUYER, phase: 'readback' }), RelayAccessError, 'the oldest is dropped');
  for (const capability of capabilities.slice(1)) {
    const admitted = relayAccess.admit({ presented: capability, wallet: BUYER, phase: 'readback' });
    assert.deepEqual({ ...admitted }, { accountId: 'acct-relay', operationId: 'op-relay', wallet: BUYER, phases: [...RELAY_PHASES], expiresAt: new Date(START + HOUR).toISOString(), live: true });
  }
});

test('closure, revocation or expiry during the relay wait forwards nothing that needs live access, and an expired readback stays a retained-record read', async (t) => {
  for (const [change, path, body, expected] of [
    ['revoked', BINDING_PATH, release(), refusedByRelay],
    ['handoff closed', RPC_PATH, nodeRead, refusedByRelay],
    ['expired', RPC_PATH, nodeRead, refusedByRelay],
    ['expired', BINDING_PATH, readback(), readFromRetainedRecord],
  ]) {
    const admitted = [];
    const w = await relayWorld(t, { wrapAccess: (access) => ({ ...access, admit: (request) => { admitted.push(request.phase); return access.admit(request); } }) });
    const capability = w.mint();
    const fence = await held.owner.acquireConnectionFence();
    const first = w.relay.post(BINDING_PATH, readback(), capability);
    await until(() => admitted.length === 2);
    const waiting = w.relay.post(path, body, capability);
    await until(() => admitted.length === 3);
    if (change === 'revoked') w.access.revokeOperation('op-relay');
    if (change === 'handoff closed') w.db.prepare('UPDATE operations SET handoff_expires_at = ? WHERE id = ?').run(new Date(START - 1).toISOString(), 'op-relay');
    if (change === 'expired') w.clock.at = START + HOUR;
    fence.release();
    assert.ok(readFromRetainedRecord(await first));
    const answer = await waiting;
    assert.ok(expected(answer), `${change}: ${JSON.stringify(answer)}`);
    if (expected === refusedByRelay) assert.ok(!reachedTransport(answer));
    assert.equal(w.nodeRequestsSent(), 0);
  }
});
