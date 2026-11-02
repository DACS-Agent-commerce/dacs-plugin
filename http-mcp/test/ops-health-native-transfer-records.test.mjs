// Ops health after real native payments on the source-pinned devnet transport.
// The cancel/send exclusion keeps per-payer records in the source transport
// journal that hold no hash or signed transaction: a cancelled payment's
// terms, the transfers signature leases claimed, and the transfers refused for
// a cancelled payment's terms. A source-broker wallet-Agreement purchase also
// leaves its browser Agreement CREATE handoff once its CREATE is requested (devnet-browser-agreement/create/
// <purchase>, at completed). Here a buyer cancels while the transfer dialog
// is open (the source refuses the transfer and keeps the refusal), then buys
// again and pays. Health reads that state, laid out as the operator keeps it
// (app/dacs-chatgpt.sqlite and node2-transport.sqlite, every record), and
// exits 0; the same records malformed, under an unknown key, or for a wallet,
// purchase, account, network, chain or Agreement that is not that database's
// still exit 2.
//
// The browser side is the shipped portal.js pay() (run from its source) with
// the real embedded wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { canonicalize, contentHash, fixedPriceAgreementLogicalAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { startDevnetAgreementTransportHarness } = await import('./helpers/devnet-agreement-transport-harness.mjs');
const { startDevnetAgreementTransportSeller } = await import('./helpers/devnet-agreement-transport-seller.mjs');
const { createSdkWalletSession, createDevnetAgreementWalletTransport, nativePayloadDigest } = await import('../public/portal/embedded-wallet/sdk-provider.mjs');
const { createOfflineAgreementBrokerClient } = await import('../public/portal/offline-agreement-broker.mjs');
const { linkPackagedWallet } = await import('./helpers/offline-agreement-fixture.mjs');
const { tool, tokenFrom } = await import('./helpers/flows.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { opsHealth } = await import('../src/ops/health.mjs');
const { deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

// The portal's pay() and the wallet helpers it calls, from the shipped source.
const portalSource = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
const slice = (from, to) => { const start = portalSource.indexOf(from), end = portalSource.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return portalSource.slice(start, end); };
const PAY_SOURCE = `${slice('function envelopeError(res) {', 'async function connect()')}${slice('function findHash(value', '// ---------------- server API')}${slice('  async function pay(view) {', '  render(await api(`/portal/api/purchase/${id}/view`')}; pay`;

const named = async ({ payload, terms }) => ({ nonce: payload.content.nonce, to: payload.content.to.toLowerCase(), amountOs: terms.price.amountOs, payloadDigest: await nativePayloadDigest(payload.content) });

// One buyer wallet and one seller on a fresh harness, as in
// native-payment-cancel-send.test.mjs.
async function world(t) {
  const h = await startDevnetAgreementTransportHarness();
  t.after(() => h.close());
  globalThis.location = new URL(h.origin);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `health-records-${Date.now()}`, durable: true });
  const transactionTransport = createDevnetAgreementWalletTransport(await h.profile());
  const api = async (path, body) => {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  const x = { h, seller, api, onTransferDialog: null, broker: null, rendered: [] };
  const brokerJournal = { get: (k) => x.broker.anchorJournal.get(k), put: (k, v) => x.broker.anchorJournal.put(k, v), withWalletLock: (k, work) => x.broker.anchorJournal.withWalletLock(k, work) };
  const session = createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, transactionTransport, anchorJournal: brokerJournal,
    approve: async (request) => { if (request.method === 'sendTransaction' && request.content?.action === 'native DEM transfer') await x.onTransferDialog?.(); return true; } });
  await session.create();
  t.after(() => session.lock());
  x.address = session.getPublicAccount().address;
  x.buyer = await linkPackagedWallet(h, session);
  x.sign = async (m) => (await session.request({ method: 'sign', params: [m] })).data.signature;
  x.purchase = async () => {
    const prepared = await tool(h, x.buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `health-records-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
    const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
    x.id = id; x.token = token;
    x.broker = createOfflineAgreementBrokerClient({ id, token, api });
    const identity = await api(`/portal/api/purchase/${id}/agreement/identity`, { token, address: x.address });
    const planned = await api(`/portal/api/purchase/${id}/agreement/plan`, { token, signature: await x.sign(identity.signRequest.message) });
    const agreementSignature = await x.sign(planned.signRequest.agreementMessage);
    await x.broker.authenticate({ address: x.address, sign: x.sign });
    await api(`/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature });
    await x.broker.approveOne(session);
    let view;
    for (let i = 0; i < 160; i++) { view = await api(`/portal/api/purchase/${id}/protocol/recheck`, { token }); if (!view.poll?.pending) break; await new Promise((r) => setTimeout(r, 250)); }
    assert.equal(view.status, 'awaiting_approval', JSON.stringify(view.evidence?.protocol?.lastAttempt ?? view.status));
    return id;
  };
  x.approve = async () => {
    const challenge = await api(`/portal/api/purchase/${x.id}/challenge`, { token: x.token, address: x.address });
    return api(`/portal/api/purchase/${x.id}/approve`, { token: x.token, challengeId: challenge.challengeId, signature: await x.sign(challenge.message) });
  };
  // The portal's pay(handoff), as the Approve button runs it after approve.
  x.pay = (handoff) => vm.runInNewContext(PAY_SOURCE, { provider: session, api, render: (v) => x.rendered.push(v), log: () => {}, needPaymentNetwork: () => {}, id: x.id, token: x.token, offlineAgreementBroker: x.broker })(handoff);
  x.cancel = () => tool(h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  x.key = (kind, address = x.address) => `devnet/${kind}/${JSON.stringify([h.expected.network, h.expected.chainIdentity, address])}`;
  return x;
}

// A consistent copy of the app database and every record of the source
// journal, laid out as the operator keeps its state directory.
async function operatorState(t, x) {
  const root = mkdtempSync(join(tmpdir(), 'ops-health-native-records-')), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(state, 'app'), { recursive: true });
  const db = new DatabaseSync(x.h.config.databasePath, { readOnly: true });
  try { db.exec(`VACUUM INTO '${join(state, 'app', 'dacs-chatgpt.sqlite').replaceAll("'", "''")}'`); } finally { db.close(); }
  const journal = openDurableWalletJournal({ path: join(state, 'node2-transport.sqlite'), mode: 'create' });
  try { for (const [key, value] of await x.h.journal.entries()) await journal.put(key, value); }
  finally { journal.close(); }
  return state;
}
// Another copy of that state with one record put into its source journal.
function withRecord(t, state, key, value) {
  const root = mkdtempSync(join(tmpdir(), 'ops-health-native-records-')), copy = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(state, copy, { recursive: true });
  const journal = openDurableWalletJournal({ path: join(copy, 'node2-transport.sqlite'), mode: 'open' });
  return journal.put(key, value).finally(() => journal.close()).then(() => copy);
}
const health = (state) => opsHealth({ databasePath: join(state, 'app', 'dacs-chatgpt.sqlite'), operatorState: state });
const cli = (state) => spawnSync(process.execPath, ['scripts/ops-health.mjs', '--operator-state', state, '--json'], { cwd: resolve('.'), encoding: 'utf8', timeout: 30000 });

test('ops health after a native payment cancelled while its transfer dialog was open (refused at its lease) and a paid one: the source journal\'s cancellation, claim and refusal records and both browser Agreement CREATE handoffs are not issued writes, so health exits 0; malformed, under an unknown key, or for a wallet or purchase that is not here, they exit 2', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  // The race: cancelled while the transfer dialog is open.
  await x.purchase();
  const cancelledId = x.id, first = await x.approve();
  let cancellation;
  x.onTransferDialog = async () => { cancellation = await x.cancel(); };
  await assert.rejects(x.pay(first));
  x.onTransferDialog = null;
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  // The buyer buys again and pays.
  await x.purchase();
  const paidId = x.id, second = await x.approve();
  await x.pay(second);
  assert.equal(x.rendered.at(-1).status, 'settled_verified');

  // The source journal holds exactly these three records with no stage, all on the buyer's lane.
  const state = await operatorState(t, x), entries = await x.h.journal.entries();
  const stageless = Object.fromEntries(entries.filter(([, value]) => !Object.hasOwn(value, 'stage')));
  assert.deepEqual(Object.keys(stageless).sort(), ['cancelled-payments', 'refused-transfers', 'transfer-claims'].map((kind) => x.key(kind)));
  const transfer = await named(first);
  assert.deepEqual(stageless[x.key('cancelled-payments')].transfers.map(({ cancelledAt, ...rest }) => rest), [{ ...transfer, operationId: cancelledId }]);
  assert.deepEqual(stageless[x.key('refused-transfers')].refusals.map(({ refusedAt, ...rest }) => rest), [{ ...transfer, gate: 'signature' }]);
  assert.deepEqual(stageless[x.key('transfer-claims')], { transferClaims: 'dacs-chatgpt-plugin/native-transfer-claims/v1', claims: [] }, 'the paid lease\'s claim was released');
  // Each purchase left its browser Agreement CREATE handoff at completed, with the CREATE's hash.
  const handoffKey = (id) => `devnet-browser-agreement/create/${id}`;
  const handoffs = Object.fromEntries(entries.filter(([key]) => key.startsWith('devnet-browser-agreement/create/')));
  assert.deepEqual(Object.keys(handoffs).sort(), [cancelledId, paidId].map(handoffKey).sort());
  for (const id of [cancelledId, paidId]) {
    const { binding, stage, transactionHash, ...rest } = handoffs[handoffKey(id)];
    assert.deepEqual([stage, binding.operation, binding.wallet, /^[0-9a-f]{64}$/.test(transactionHash)], ['completed', id, x.address, true]);
    assert.deepEqual(Object.keys(rest).sort(), ['correlation', 'expiresAt', 'request', 'requestHash', 'version']);
  }

  const report = health(state);
  assert.equal(report.healthy, true, JSON.stringify(report.stuck));
  assert.deepEqual(report.stuck, []);
  assert.deepEqual(report.seller.journals, ['node2-transport.sqlite']);
  assert.deepEqual(report.seller.unconfirmed, []);
  assert.deepEqual(report.purchases.map((row) => [row.purchaseId, row.stage, row.outcome, row.unresolvedWrites]), [[paidId, 'payment-observed', 'recorded', []], [cancelledId, 'cancelled', 'recorded', []]]);
  const run = cli(state);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).seller, report.seller);

  // Still fail closed: a malformed claim, an unknown key under the prefix, a
  // claim for another wallet, and the same for the other two records.
  const claims = stageless[x.key('transfer-claims')], claim = { leaseId: '1'.repeat(32), ...transfer, expiresAt: new Date().toISOString() }, refused = stageless[x.key('refused-transfers')];
  const other = `0x${'c'.repeat(64)}`;
  const failing = [
    ['a claim with a hash', x.key('transfer-claims'), { ...claims, claims: [{ ...claim, hash: 'e'.repeat(64) }] }],
    ['a claim with no lease id', x.key('transfer-claims'), { ...claims, claims: [claim].map(({ leaseId, ...rest }) => rest) }],
    ['claims under another format', x.key('transfer-claims'), { ...claims, transferClaims: 'dacs-chatgpt-plugin/native-transfer-claims/v2' }],
    ['an unknown key under the claims prefix', 'devnet/transfer-claims/TEST', claims],
    ['claims for a wallet that is not a buyer here', x.key('transfer-claims', other), claims],
    ['a refusal at an unknown gate', x.key('refused-transfers'), { ...stageless[x.key('refused-transfers')], refusals: [{ ...stageless[x.key('refused-transfers')].refusals[0], gate: 'release' }] }],
    // One refusal per payload (refuseCancelled keeps the first gate's).
    ['the refused payload refused again at another gate', x.key('refused-transfers'), { ...refused, refusals: [...refused.refusals, { ...refused.refusals[0], gate: 'broadcast' }] }],
    ['a refusal kept twice', x.key('refused-transfers'), { ...refused, refusals: [...refused.refusals, refused.refusals[0]] }],
    ['an unknown key under the refusals prefix', `devnet/refused-transfers/${JSON.stringify([x.h.expected.network, x.address])}`, stageless[x.key('refused-transfers')]],
    ['refusals for a wallet that is not a buyer here', x.key('refused-transfers', other), stageless[x.key('refused-transfers')]],
    ['a cancellation with no operation', x.key('cancelled-payments'), { ...stageless[x.key('cancelled-payments')], transfers: stageless[x.key('cancelled-payments')].transfers.map(({ operationId, ...rest }) => rest) }],
    ['cancellations for a wallet that is not a buyer here', x.key('cancelled-payments', other), stageless[x.key('cancelled-payments')]],
    ['a cancellation of a purchase that is not here', x.key('cancelled-payments'), { ...stageless[x.key('cancelled-payments')], transfers: stageless[x.key('cancelled-payments')].transfers.map((e) => ({ ...e, operationId: `pur_${'Z'.repeat(16)}` })) }],
    ['claims on the buyer\'s lane on another network', `devnet/transfer-claims/${JSON.stringify(['foreign-net', x.h.expected.chainIdentity, x.address])}`, claims],
    ['claims on the buyer\'s lane on another chain', `devnet/transfer-claims/${JSON.stringify([x.h.expected.network, 'e'.repeat(64), x.address])}`, claims],
    // The paid purchase's real handoff, changed in one place.
    ...handoffVariants(handoffs[handoffKey(paidId)], handoffKey, paidId, cancelledId, other),
  ];
  for (const [name, key, value] of failing) {
    const copy = await withRecord(t, state, key, value);
    assert.throws(() => health(copy), /could not read valid state/, name);
  }
  // The same claims under the buyer's own lane, written again, still pass; the CLI exits 2 on one that does not.
  assert.equal(health(await withRecord(t, state, x.key('transfer-claims'), { ...claims, claims: [claim] })).healthy, true);
  // The same transfer signed from another payload is another refusal.
  assert.equal(health(await withRecord(t, state, x.key('refused-transfers'), { ...refused, refusals: [...refused.refusals, { ...refused.refusals[0], payloadDigest: 'e'.repeat(64), gate: 'confirmTx' }] })).healthy, true);
  assert.equal(cli(await withRecord(t, state, x.key('transfer-claims', other), claims)).status, 2);
  // The paid handoff at each other stage its producer writes, with that stage's fields, still passes; the CLI exits 2 at one it never writes.
  const paidHandoff = handoffs[handoffKey(paidId)], { transactionHash, ...unsent } = paidHandoff;
  for (const record of [{ ...unsent, stage: 'queued' }, { ...unsent, stage: 'issued-to-browser' }, { ...unsent, stage: 'expired' }, { ...paidHandoff, stage: 'uncertain', errorCode: 'TEST_wallet_error' }, { ...paidHandoff, stage: 'uncertain' }, { ...unsent, stage: 'denied', errorCode: 'TEST_wallet_error' }, { ...unsent, stage: 'denied' }]) {
    assert.equal(health(await withRecord(t, state, handoffKey(paidId), record)).healthy, true, JSON.stringify([record.stage, record.errorCode]));
  }
  assert.equal(cli(await withRecord(t, state, handoffKey(paidId), { ...unsent, stage: 'broadcast-started' })).status, 2);
});

// A native payment whose execution failed, through the source as
// native-payment-cancel-failed-lane.test.mjs runs it (offline: the Node2
// coverage fixture's stub and an in-memory journal): the source reads it back
// failed at its saved nonce fence and keeps it so under its intent key and on
// the buyer's lane; the purchase is then cancelled, and the source keeps the
// cancellation. Health reads that state, laid out as the operator keeps it,
// and exits 0; the failed record changed in one place, for a wallet or
// network that is not that database's, or in a seller journal, exits 2.
test('ops health after a native payment read back failed and then cancelled: the source journal\'s failed transfer (intent and lane) and the cancellation are not issued writes, so health exits 0; malformed, for a wallet or network that is not here, or in a seller journal, they exit 2', async (t) => {
  const { admittedTransport, CHAIN, layoutAdmission, layoutChain, memoryJournal, NETWORK, sha } = await import('./helpers/claude-node2-current-coverage-fixture.mjs');
  const { AMOUNT, PAYER, PAYEE, intentKey, issuedRow, laneKey, node2Projection, signedContent, signTransaction } = await import('./helpers/claude-native-readback-current-fixture.mjs');
  const { openDatabase } = await import('../src/store/database.mjs');
  const { createOperationStore } = await import('../src/operations.mjs');
  const { createCoordinateStore } = await import('../src/dacs/wallet-transactions.mjs');
  const { createPurchaseService } = await import('../src/purchases.mjs');
  const { createProtocolPurchases } = await import('../src/dacs/protocol-purchases.mjs');
  const { NATIVE_AGREEMENT_PAYMENT } = await import('../src/dacs/native-agreement-payment-consumer.mjs');
  const signed = signTransaction(signedContent()), journal = memoryJournal();
  const run = admittedTransport(await layoutAdmission(), {
    ...layoutChain(),
    getTransactionStatus: { result: 200, response: { state: 'included', blockNumber: 10 } },
    getTxByHash: { result: 200, response: { hash: signed.hash, status: 'failed', blockNumber: 10, content: node2Projection(signed.content, signed.hash) } },
    getAddressNonce: { result: 200, response: { nonce: 6 } },
    10: { result: 200, response: { number: 10, status: 'confirmed', hash: sha('ops-health-failed-lane:block-10'), content: { timestamp: 1_900_000_000_123, ordered_transactions: [signed.hash] } } },
  }, { journal });
  const source = run.capability;
  t.after(() => source.close());
  const issued = issuedRow(signed, (await source.binding({ phase: 'bind', address: PAYER })).binding);
  journal.seed(intentKey(signed.hash), issued); journal.seed(laneKey(PAYER), issued);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-ops-health-failed-lane-secret-0000' }), coordinates = createCoordinateStore({ db });
  const terms = { buyer: { wallet: PAYER }, seller: { payee: PAYEE }, price: { amountOs: AMOUNT }, listing: { listingId: 'TEST-listing', version: 1, contentHash: sha('TEST-listing') }, network: NETWORK, rail: 'demos-native:DEM',
    domain: { network: NETWORK, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN },
    protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: 'public-signed-create', transportBinding: source.transportBinding } };
  const payload = { content: (({ type, from, to, amount, data, nonce, timestamp }) => ({ type, from, to, amount, data, nonce, timestamp }))(signedContent()) };
  const a = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST-failed-A', request: { name: 'A' }, status: 'payment_uncertain', terms, termsHash: sha('TEST-failed-A'), expiresAt: new Date(Date.now() + 60000).toISOString(), state: { protocol: { stage: 'seller-committed' } } }).operation;
  coordinates.save({ operationId: a.id, kind: 'native-dem-transfer', network: NETWORK, from: PAYER, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: AMOUNT, payload });
  const protocol = createProtocolPurchases({ db, ops, coordinates, dacsProtocol: { sellerEndpoint: () => source.pins.endpoint, sellerSr2Commitment: { commitmentSubstrate: 'fixture', publicProjection: true },
    walletAgreement: { rpcUrl: source.pins.endpoint, network: NETWORK, sourceCapability: source, journal, bridgeFor: () => null }, nativeAgreementPayment: source } });
  const chain = { ...source.chainReader(), networkIdentity: async () => ({ identity: (await source.observeBinding()).chainIdentity, mode: 'public-chain-read' }) };
  const purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain, protocol });
  coordinates.reportHash(a.id, signed.hash);
  assert.equal((await purchases.verifyDeal({ accountId: 'TEST-buyer', operationId: a.id })).verification.outcome, 'execution_failed');
  assert.equal((await purchases.cancel({ accountId: 'TEST-buyer', operationId: a.id })).cancelled, true);

  const entries = await journal.entries(), failed = Object.fromEntries(entries.filter(([, value]) => value?.stage === 'failed'));
  assert.deepEqual(Object.keys(failed).sort(), [intentKey(signed.hash), laneKey(PAYER)].sort());
  assert.ok(entries.some(([key]) => key.startsWith('devnet/cancelled-payments/')));
  // The app database and every source journal record, as the operator keeps them.
  const root = mkdtempSync(join(tmpdir(), 'ops-health-failed-lane-')), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(state, 'app'), { recursive: true });
  db.exec(`VACUUM INTO '${join(state, 'app', 'dacs-chatgpt.sqlite').replaceAll("'", "''")}'`);
  const durable = openDurableWalletJournal({ path: join(state, 'node2-transport.sqlite'), mode: 'create' });
  try { for (const [key, value] of entries) await durable.put(key, value); } finally { durable.close(); }
  const report = health(state);
  assert.equal(report.healthy, true, JSON.stringify(report.stuck));
  assert.deepEqual([report.seller.journals, report.seller.unconfirmed], [['node2-transport.sqlite'], []]);
  assert.deepEqual(report.purchases.map((row) => [row.purchaseId, row.stage]), [[a.id, 'cancelled']]);
  assert.equal(cli(state).status, 0);

  const record = failed[intentKey(signed.hash)], other = `0x${'c'.repeat(64)}`;
  const stranger = structuredClone(record); stranger.signedTransaction.content.from = other;
  const changed=(edit)=>{const r=structuredClone(record);edit(r.signedTransaction);return r;};
  for (const [name, key, value] of [
    ['a real failed transfer without its signature', intentKey(signed.hash), changed(tx=>{delete tx.signature;})],
    ['a real failed transfer with an invalid signature', intentKey(signed.hash), changed(tx=>{tx.signature.data='f'.repeat(128);})],
    ['a real failed transfer with a changed destination under its retained hash', intentKey(signed.hash), changed(tx=>{tx.content.to=other;})],
    ['a real failed transfer without its native body', intentKey(signed.hash), changed(tx=>{delete tx.content.data;})],
    ['a failed transfer with a receipt', intentKey(signed.hash), { ...record, receipt: {} }],
    ['a failed transfer with a nonce fence that is not the nonce below', intentKey(signed.hash), { ...record, failure: { ...record.failure, nonceFence: record.failure.nonceFence + 1 } }],
    ['a failed transfer under another transfer\'s intent key', intentKey('e'.repeat(64)), record],
    ['a failed transfer of a wallet that is not a buyer here, on its lane', `devnet/native-wallet/${JSON.stringify([NETWORK, CHAIN, other])}`, stranger],
    ['a failed transfer on another network', intentKey(signed.hash), { ...record, networkBinding: { ...record.networkBinding, network: 'foreign-net' } }],
  ]) {
    const copy = await withRecord(t, state, key, value);
    assert.throws(() => health(copy), /could not read valid state/, name);
  }
  for (const journal of ['seller-artifacts.sqlite', 'seller-wallet.sqlite']) {
    const root = mkdtempSync(join(tmpdir(), 'ops-health-failed-lane-')), copy = join(root, 'state');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(state, copy, { recursive: true });
    const seller = openDurableWalletJournal({ path: join(copy, journal), mode: 'create' });
    try { await seller.put(intentKey(signed.hash), record); } finally { seller.close(); }
    assert.throws(() => health(copy), /could not read valid state/, journal);
  }
});

// A real completed handoff changed in one place: a stage or field its producer
// never writes there, a request that is not its hash, another purchase's key,
// a purchase or wallet or terms hash that is not this database's.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function handoffVariants(handoff, handoffKey, id, otherId, otherWallet) {
  const rehash = (r) => ({ ...r, requestHash: sha256(canonicalize(r.request)) });
  const { transactionHash, ...unsent } = handoff, absent = `pur_${'Z'.repeat(16)}`;
  const strangers = structuredClone(handoff), create = strangers.request.params[0], content = create.transaction.content, op = content.data[1];
  strangers.binding.wallet = otherWallet; create.owner = `did:demos:agent:${otherWallet.slice(2)}`; content.from = content.from_ed25519_address = otherWallet;
  op.storageAddress = content.to = deriveStorageAddress(otherWallet, op.programName, content.nonce, '');
  // The same request with its CREATE changed in one place.
  const changed = (change) => { const r = structuredClone(handoff); change(r.request.params[0], r.request.params[0].transaction.content); return rehash(r); };
  return [
    ['a handoff at a stage its producer never writes', handoffKey(id), { ...handoff, stage: 'broadcast-started' }],
    ['a handoff with no stage fields at a journal stage its producer never writes', handoffKey(id), { ...unsent, stage: 'observed' }],
    ['a completed handoff with no transaction hash', handoffKey(id), unsent],
    ['a completed handoff with an error code', handoffKey(id), { ...handoff, errorCode: 'TEST_wallet_error' }],
    ['a denied handoff with the CREATE hash', handoffKey(id), { ...handoff, stage: 'denied' }],
    ['a denied handoff with an empty error code', handoffKey(id), { ...unsent, stage: 'denied', errorCode: '' }],
    ['a handoff with a signed transaction', handoffKey(id), { ...handoff, signedTransaction: { content: { from: handoff.binding.wallet } } }],
    ['a handoff whose request is not its hash', handoffKey(id), { ...handoff, requestHash: '0'.repeat(64) }],
    ['a handoff with another request profile', handoffKey(id), rehash({ ...handoff, request: { ...handoff.request, params: [{ ...handoff.request.params[0], profile: 'devnet-other' }] } })],
    ['a handoff under another purchase\'s key', handoffKey(otherId), handoff],
    ['a handoff for a purchase that is not in this database', handoffKey(absent), { ...handoff, binding: { ...handoff.binding, operation: absent } }],
    ['a consistent handoff for a wallet that is not this purchase\'s buyer', handoffKey(id), rehash(strangers)],
    ['a handoff with another terms hash', handoffKey(id), { ...handoff, binding: { ...handoff.binding, 'terms-hash': 'c'.repeat(64) } }],
    ['a handoff for another account', handoffKey(id), { ...handoff, binding: { ...handoff.binding, account: 'acct_TEST_foreign' } }],
    ['a handoff for another Agreement hash', handoffKey(id), { ...handoff, binding: { ...handoff.binding, 'agreement-hash': 'e'.repeat(64) } }],
    ['a handoff whose request has an extra field', handoffKey(id), changed((r) => { r.extra = 'not-written-by-producer'; })],
    ['a handoff whose CREATE is a native send', handoffKey(id), changed((r) => { r.transaction = { content: { from: handoff.binding.wallet, type: 'native', to: otherWallet, amount: '1' } }; })],
    ['a handoff whose CREATE is on another chain', handoffKey(id), changed((r, c) => { c.chainIdentity = 'e'.repeat(64); })],
    ['a handoff whose CREATE carries another Agreement', handoffKey(id), changed((r, c) => { c.data[1].data = { ...c.data[1].data, TEST: 'another Agreement' }; })],
    ['a handoff whose CREATE carries another Agreement with that Agreement\'s envelope hash', handoffKey(id), changed((r, c) => {
      const op = c.data[1]; op.data = { ...op.data, TEST: 'another Agreement' };
      r.envelopeHash = op.metadata.envelopeHash = sha256(canonicalize(op.data));
    })],
    ['a handoff whose CREATE consistently carries another Agreement under the purchase\'s planned Agreement hash', handoffKey(id), changed((r, c) => {
      const op = c.data[1]; op.data = { ...op.data, TEST: 'another Agreement' };
      r.contentHash = op.metadata.contentHash = contentHash(op.data);
      r.envelopeHash = op.metadata.envelopeHash = sha256(canonicalize(op.data));
    })],
    // The Agreement's content hash leaves its signatures out: the same content hash, another envelope than the purchase retained.
    ...[['signature', (data) => ({ ...data, signature: { TEST: 'not retained' } })], ['signatures', (data) => ({ ...data, signatures: [...(data.signatures ?? []), { TEST: 'not retained' }] })]].map(([field, substitute]) => [
      `a handoff whose CREATE carries the purchase's Agreement with a ${field} it never retained`, handoffKey(id), changed((r, c) => {
        const op = c.data[1]; op.data = substitute(op.data);
        assert.equal(contentHash(op.data), r.contentHash);
        r.envelopeHash = op.metadata.envelopeHash = sha256(canonicalize(op.data));
      })]),
    ['a handoff whose CREATE is consistently at another job\'s Agreement address', handoffKey(id), changed((r, c) => {
      const op = c.data[1]; r.logicalAddress = op.metadata.logicalAddress = fixedPriceAgreementLogicalAddress('01ARZ3NDEKTSV4RRFFQ69G5FAW');
      op.programName = logicalToStorageProgramName(r.logicalAddress); op.storageAddress = c.to = deriveStorageAddress(c.from, op.programName, c.nonce, '');
    })],
    ['a handoff whose CREATE has a signature and no hash', handoffKey(id), changed((r) => { r.transaction.signature = { type: 'ed25519', data: 'f'.repeat(128) }; })],
    ['a handoff whose CREATE has a hash and no signature', handoffKey(id), changed((r) => { r.transaction.hash = 'f'.repeat(64); })],
    ['an unknown key under the handoff prefix', 'devnet-browser-agreement/create/TEST', handoff],
  ];
}
