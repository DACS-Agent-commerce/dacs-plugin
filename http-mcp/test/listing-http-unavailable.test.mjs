// Offline HTTP failures through the real source adapter, verifier and stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmittedNode2DemoTransport } from '../src/devnet-demo/operator-network.mjs';
import { DEVNET_NODE2_REVIEWED_BUILD } from '../src/wallet/devnet-native-transport.mjs';
import { createListingVerifier } from '../src/dacs/verification.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { fixtureListing, summaryFor } from './fixtures/listings.mjs';
import { PAYER, signHex } from './helpers/claude-native-readback-current-fixture.mjs';
import { layoutAdmission, layoutChain, memoryJournal, mutableOwner, node2Stub, NOW, WALLET } from './helpers/claude-node2-current-coverage-fixture.mjs';
import { node2NetworkInfo } from './helpers/node2-reviewed-build.mjs';

const LOCATOR = `stor-${'a'.repeat(40)}`;
const PATH = `GET /storage-program/${LOCATOR}`;

for (const [reviewed, failure] of [[false, 'storage'], [true, 'storage'], [true, 'build']]) {
  test(`HTTP 404 from ${failure} holds approval with ${reviewed ? 'selected' : 'default null'} admission policy`, async t => {
    const seller = { address:PAYER, claim:`did:demos:agent:${PAYER.slice(2)}`,
      signBytes:bytes=>Buffer.from(signHex(bytes), 'hex') };
    const listing = fixtureListing(seller, { now:NOW });
    const storage = { success:true, data:listing, owner:PAYER, programName:'TEST-http-listing' };
    const stub = node2Stub({ ...layoutChain(), getNetworkInfo:node2NetworkInfo(), [PATH]:storage });
    const owner = Object.assign(mutableOwner(), { verifyDeploymentRecord:()=>true });
    const journal = memoryJournal();
    const source = createAdmittedNode2DemoTransport({ admission:await layoutAdmission(), transportOwner:owner,
      journal, fetchImpl:stub.fetchImpl, now:()=>NOW,
      ...(reviewed ? { reviewedNodeBuild:DEVNET_NODE2_REVIEWED_BUILD } : {}) });
    t.after(()=>source.close());
    const chain = source.chainReader();
    const directory = { origin:'https://directory.invalid', evidenceMode:'TEST',
      findSummary:async()=>summaryFor(listing, LOCATOR, { observedAt:new Date(NOW).toISOString() }),
      getListingDetail:async()=>structuredClone(listing) };
    const verifier = createListingVerifier({ directory, chain, now:()=>NOW });
    const db = openDatabase(':memory:');
    t.after(()=>db.close());
    const accountId = 'TEST-http-listing-buyer';
    db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
      .run(accountId, 'TEST', accountId, new Date(NOW).toISOString());
    const ops = createOperationStore({ db, handoffSecret:'TEST-http-listing-handoff-secret', now:()=>NOW });
    let challenges = 0;
    const purchases = createPurchaseService({ db, config:{ publicOrigin:'https://portal.invalid' },
      ops, coordinates:createCoordinateStore({ db }), accounts:{ listWallets:()=>[{ address:WALLET }] },
      verifier, chain, challenges:{ issue:()=>({ challengeId:`TEST-challenge-${++challenges}` }) }, now:()=>NOW });
    const prepared = await purchases.prepare({ accountId, listingId:listing.listingId, version:1,
      seller:seller.claim, idempotencyKey:'TEST-http-listing' });
    assert.equal(prepared.verification.transactable, true, 'signed Listing initially verifies');
    const before = ops.get(accountId, prepared.operation.id), history = ops.history(before.id);
    const approve = ()=>purchases.issueApprovalChallenge({ operationId:before.id,
      token:ops.handoffTokenFor(before.id), address:WALLET });
    const from = stub.calls.length;
    stub.set({ [failure === 'storage' ? PATH : 'getNetworkInfo']:()=>new Response('', { status:404 }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(approve(), { code:'listing_recheck_unavailable' });
      assert.deepEqual(ops.get(accountId, before.id), before);
      assert.deepEqual(ops.history(before.id), history);
    }
    await assert.rejects(chain.readStorageProgram(LOCATOR), error=>{
      assert.equal(error.kind, 'unavailable');
      assert.equal(error.status, 404);
      assert.equal(error.cause.kind, 'not-found');
      assert.equal(error.cause.status, 404);
      return true;
    });
    assert.equal(challenges, 0);
    assert.deepEqual(journal.puts, []);
    assert.equal(owner.counts().held, false);
    if (failure === 'build') assert.ok(!stub.calls.slice(from).some(c=>c.path.startsWith('/storage-program/')));
    assert.ok(!stub.messages().some(m=>['confirmTx', 'broadcastTx'].includes(m)));
    stub.set({ [PATH]:storage, getNetworkInfo:node2NetworkInfo() });
    assert.deepEqual(await approve(), { challengeId:'TEST-challenge-1' });
    assert.deepEqual(ops.get(accountId, before.id), before);
  });
}
