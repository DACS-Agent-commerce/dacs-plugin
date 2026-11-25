// With SDK purchases on, the Listing a Start response hands the wallet is only ever the one the client's listing
// verifier accepted for this purchase. Hostile Listings are seeded on the chain and directory fixtures; the node
// is a scripted double on an .invalid origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { NODE_ORIGIN, accountOf, clientAction, switchOnHarness } from './helpers/switch-on-world.mjs';

/** Puts `listing` on the chain fixture under `seller` and in the directory, as published. */
function publish(h, seller, listing) {
  const locator = fixtureLocator(`${seller.address}:${listing.listingId}:${listing.listingVersion}`);
  h.chain.seedStorage(locator, { data: listing, owner: seller.address });
  h.directory.add(summaryFor(listing, locator), listing);
}

// Each hostile Listing names `seller` as its signer.
const HOSTILE = {
  unsigned: (seller) => {
    const listing = fixtureListing(seller, { listingId: 'unsigned' });
    delete listing.signature;
    return listing;
  },
  'signed by another key': (seller) => {
    const other = fixtureListing(createEphemeralWallet(), { listingId: 'other-key' });
    return { ...other, seller: fixtureListing(seller, { listingId: 'other-key' }).seller, signature: { ...other.signature, signer: seller.claim } };
  },
  'changed after signing': (seller) => {
    const listing = fixtureListing(seller, { listingId: 'price-raised' });
    return { ...listing, pricing: { kind: 'fixed', price: { amount: '250', currency: 'DEM' } } };
  },
};

test('with the switch on, a purchase whose pinned Listing is unsigned, signed by another key, or changed after signing (price raised with the old signature kept) is refused by the server before any Start response or signed request', async (t) => {
  const origins = [];
  const { h } = await switchOnHarness(t, { origins, env: { DACS_INTENT_APPROVAL: 'on' } });
  const user = await linkedUser(h);
  const seller = createEphemeralWallet();
  for (const [label, build] of Object.entries(HOSTILE)) {
    const listing = build(seller);
    publish(h, seller, listing);
    const rows = databaseRows(h.app.db);
    const prepared = await tool(h, user, 'prepare_purchase', { listingId: listing.listingId, version: 1, seller: seller.claim, idempotencyKey: `hostile-${listing.listingId}` });
    assert.ok(prepared.error, `${label}: refused`);
    assert.equal(databaseRows(h.app.db), rows, `${label}: no purchase, so no Start can be issued`);
  }
  assert.deepEqual(origins.filter((origin) => ![NODE_ORIGIN, h.chain.url, h.directory.url].includes(origin)), [], 'no request left for a seller');
});

test('with the switch on, the Start response for a verified Listing carries exactly the verified bytes', async (t) => {
  const { h } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' } });
  const user = await linkedUser(h);
  const seller = createEphemeralWallet();
  const listing = fixtureListing(seller, { listingId: 'verified' });
  publish(h, seller, listing);
  const { operation, approvalUrl } = await clientAction(() => h.app.services.purchases.prepare({ accountId: accountOf(h, user), listingId: 'verified', version: 1,
    seller: seller.claim, idempotencyKey: 'verified-start' }));
  const token = new URL(approvalUrl).hash.slice(1);
  const response = await fetch(`${h.origin}/portal/api/purchase/${operation.id}/intent/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, address: user.wallet.address }) });
  assert.equal(canonicalize((await response.json()).start.listing), canonicalize(listing));
});
