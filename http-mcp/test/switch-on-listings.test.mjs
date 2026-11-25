// SDK purchases on: the process's registry of verified sellers, which the client's authority reader asks. A seller is
// registered only by a transactable listing verifier result for that exact seller, read through get_listing; nothing
// is registered from a request alone, and nothing is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { databaseRows } from './helpers/database-rows.mjs';
import { switchOnHarness } from './helpers/switch-on-world.mjs';

const listingRequest = (seller) => ({ listingId: 'verified', version: 1, seller });

test('with the switch on and the pinned client, get_listing leaves the seller unregistered before and after the client\'s held verifier refusal', async (t) => {
  const { h } = await switchOnHarness(t);
  const user = await linkedUser(h);
  const seller = createEphemeralWallet();
  const listing = fixtureListing(seller, { listingId: 'verified' });
  const locator = fixtureLocator(`${seller.address}:${listing.listingId}:${listing.listingVersion}`);
  h.chain.seedStorage(locator, { data: listing, owner: seller.address });
  h.directory.add(summaryFor(listing, locator), listing);
  const { listings } = h.app.services.switchOn;
  assert.equal(listings.isRegistered(seller.claim), false, 'empty at start');
  assert.ok((await tool(h, user, 'get_listing', listingRequest(seller.claim))).error, 'the pinned client refuses the verification');
  assert.equal(listings.isRegistered(seller.claim), false);
});

test('a listing verifier given to createApp registers only the seller whose transactable result get_listing asked for: a result for another seller, a refused result and the request alone register nothing, and nothing is saved', async (t) => {
  const results = new Map();
  const asked = [];
  const listingVerifierFactory = () => ({
    async verify(args) {
      asked.push(args.seller);
      return results.get(args.seller);
    },
  });
  const { h } = await switchOnHarness(t, { appOptions: { listingVerifierFactory } });
  const user = await linkedUser(h);
  const [seller, other] = [createEphemeralWallet().claim, createEphemeralWallet().claim];
  const result = (named, transactable) => ({ ...listingRequest(named), transactable, disposition: 'valid', checks: [], price: { amount: '1', currency: 'DEM', amountOs: '1' },
    evidence: { chainMode: 'public-chain-read' } });
  const { listings } = h.app.services.switchOn;
  const rows = databaseRows(h.app.db);
  results.set(other, result(seller, true));
  results.set(seller, result(seller, false));
  await tool(h, user, 'get_listing', listingRequest(other));
  await tool(h, user, 'get_listing', listingRequest(seller));
  assert.deepEqual([listings.isRegistered(seller), listings.isRegistered(other)], [false, false], 'a result for another seller or a refused one registers nothing');
  results.set(seller, result(seller, true));
  await tool(h, user, 'get_listing', listingRequest(seller));
  assert.deepEqual([listings.isRegistered(seller), listings.isRegistered(other)], [true, false]);
  assert.deepEqual(asked, [other, seller, seller], 'get_listing asked the verifier given to createApp');
  assert.equal(databaseRows(h.app.db), rows, 'the registry is not saved');
});
