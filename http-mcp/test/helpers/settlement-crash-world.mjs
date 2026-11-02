// Durable SQLite plus an independently durable public source-journal double.
// No wallet, signer or network. The send ledger starts at one already-issued
// payment; every attempted new send is a test failure.
import { join } from 'node:path';
import { openDatabase } from '../../src/store/database.mjs';
import { createOperationStore } from '../../src/operations.mjs';
import { createCoordinateStore } from '../../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../../src/purchases.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../../src/dacs/native-agreement-payment-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
export const A = 'ab'.repeat(32), B = 'bc'.repeat(32), ACCOUNT = 'TEST-crash';
export async function openCrashWorld(dir, { initialize = false, scenario = 'current', interrupt = () => {} } = {}) {
  const raw = openDatabase(join(dir, 'state.sqlite'));
  let armed = false;
  const db = new Proxy(raw, { get(target, key) {
    if (key === 'exec') return sql => {
      if (armed && sql === 'BEGIN IMMEDIATE') interrupt('before-transaction');
      if (armed && sql === 'COMMIT') interrupt('before-commit');
      const result = target.exec(sql);
      if (armed && sql === 'COMMIT') interrupt('after-commit');
      return result;
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const journal = openDurableWalletJournal({ path: join(dir, 'source.sqlite'), mode: initialize ? 'create' : 'open' });
  const now = () => Date.UTC(2026, 9, 22);
  const ops = createOperationStore({ db, handoffSecret: 'TEST-crash-fixture-only'.padEnd(32, '.'), now }), coordinates = createCoordinateStore({ db, now });
  const wallet = `0x${'ee'.repeat(32)}`, payee = `0x${'dd'.repeat(32)}`;
  const domain = { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null };
  let ids;
  if (initialize) {
    db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT, 'TEST', ACCOUNT, new Date().toISOString());
    const terms = { buyer: { wallet }, seller: { payee, claim: 'TEST-seller' }, price: { amountOs: '2500000000' },
      listing: { listingId: 'TEST', version: 1, contentHash: 'cd'.repeat(32) }, network: domain.network, rail: domain.rail, domain,
      protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION } };
    const create = (id, status) => {
      const op = ops.createIdempotent({ accountId: ACCOUNT, kind: 'purchase', idempotencyKey: id, request: { id }, status,
        terms, termsHash: 'cd'.repeat(32), state: {}, expiresAt: new Date(Date.now() + 60000).toISOString() }).operation;
      coordinates.save({ operationId: op.id, kind: 'dem-transfer', network: domain.network, from: wallet, nonceFence: 6, expectedNonce: 7, target: payee, amountOs: terms.price.amountOs, payload: {} });
      return op.id;
    };
    ids = { paid: create('paid', scenario === 'mismatch' ? 'broadcast_reported' : 'cancelled'), other: create('other', 'broadcast_reported') };
    coordinates.reportHash(ids.paid, A); coordinates.reportHash(ids.other, scenario === 'stale' ? 'de'.repeat(32) : B);
    await journal.put('TEST-ids', ids);
    await journal.put('TEST-send-ledger', { sends: 1 });
    for (const id of Object.values(ids)) await journal.put(id, { state: 'issued', nonce: 7 });
  } else ids = await journal.get('TEST-ids');
  const forbidden = () => { throw new Error('TEST must not send another payment'); };
  const chain = { network: domain.network, evidenceMode: domain.mode, networkIdentity: async () => ({ mode: domain.mode }),
    observeTransfer: async hash => {
      if (armed && scenario === 'stale') coordinates.replaceUnobservedHash(ids.paid, B);
      return { status: 'included', txHash: hash, blockNumber: 10, payer: wallet, payee, amountOs: scenario === 'mismatch' ? '1' : '2500000000' };
    },
    getTransaction: async hash => ({ hash, status: 'confirmed', blockNumber: 10, content: { from: wallet, nonce: 7 } }),
    broadcast: forbidden, sendTransaction: forbidden };
  const protocol = { nativePaymentSuperseded: async operation => {
    await journal.put(operation.id, { state: 'superseded', nonce: 7, by: A });
    return true;
  } };
  const purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain, verifier: {}, protocol, now });
  return { ids, ops, coordinates, journal, db,
    arm: () => { armed = true; },
    verify: () => purchases.verifyDeal({ accountId: ACCOUNT, operationId: ids.paid }),
    snapshot: async () => ({ paid: ops.get(ACCOUNT, ids.paid), other: ops.get(ACCOUNT, ids.other),
      coord: coordinates.get(ids.paid), lane: coordinates.get(ids.other),
      nonces: db.prepare('SELECT * FROM wallet_nonce_consumptions').all(),
      paidSource: await journal.get(ids.paid), otherSource: await journal.get(ids.other), ledger: await journal.get('TEST-send-ledger') }),
    close: () => { journal.close(); raw.close(); } };
}
