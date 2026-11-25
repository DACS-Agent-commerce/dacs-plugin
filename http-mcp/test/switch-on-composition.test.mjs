// SDK purchases on: the process members the switch-on composition builds once and hands on. The evidence ports, the
// routers' inputs and the CREATE delivery gate all hold the same process objects; the node connection can be prepared
// before createApp and is then the app's only one. The node is a scripted double on an .invalid origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { linkedUser, tool } from './helpers/flows.mjs';
import { FIXTURE_CHAIN, NODE_ORIGIN, accountOf, routedFetch, seedHandoffPurchase, switchOnHarness, switchedOn, tp1Node } from './helpers/switch-on-world.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { INSTRUCTIONS } from '../src/mcp/server.mjs';
import { createLogger } from '../src/util/log.mjs';
import { createPortalRouter } from '../src/portal/routes.mjs';
import { createAgreementCreateRouter } from '../src/portal/agreement-create-routes.mjs';
import { prepareSwitchOnOwner } from '../src/sdk/switch-on.mjs';
import { purchaseStore, transaction } from '../src/store/database.mjs';
import { RelayAccessError } from '../src/wallet/relay-access.mjs';

const PORT_NAMES = ['chain', 'delivery', 'journal', 'purchases', 'readPurchase', 'recorder', 'starts'];

/** A journal stand-in that records every member read from it. */
function watchedJournal() {
  const touched = [];
  return { touched, journal: new Proxy({}, { get: (_target, name) => { touched.push(String(name)); return undefined; } }) };
}

/** A switch-on configuration over NODE_ORIGIN with its own data directory, removed after the test. */
function directConfig(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'switch-on-direct-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir };
  return switchedOn({ chain: { rpcUrl: NODE_ORIGIN, network: 'demos-testnet', timeoutMs: 1000 } })(loadConfig(env));
}

async function directApp(t, options) {
  const app = await createApp({ logger: createLogger({ level: 'error', sink: () => {} }), ...options });
  t.after(() => app.close());
  return app;
}

test('the switch-on evidence ports are exactly the seven process members by reference, with the injected journal untouched, no recorder while its subpath is absent, and the same ports on a repeat call', async (t) => {
  const { h } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' } });
  const { switchOn, purchases, chain } = h.app.services;
  const { touched, journal } = watchedJournal();
  const ports = switchOn.createSwitchOnEvidencePorts({ journal });
  assert.deepEqual(Object.keys(ports).sort(), PORT_NAMES);
  assert.ok(Object.isFrozen(ports));
  assert.equal(ports.purchases, purchases);
  assert.equal(ports.chain, chain);
  assert.equal(ports.starts, switchOn.routeInputs.portal.startIntents);
  assert.equal(ports.starts, switchOn.routeInputs.agreementCreate.starts);
  assert.equal(ports.delivery, switchOn.routeInputs.portal.createDelivery);
  assert.equal(ports.delivery, switchOn.routeInputs.agreementCreate.delivery);
  assert.equal(ports.journal, journal);
  assert.equal(ports.recorder, null);
  assert.equal(switchOn.createSwitchOnEvidencePorts({ journal }), ports, 'a repeat call builds nothing new');
  assert.throws(() => switchOn.createSwitchOnEvidencePorts({ journal: {} }), TypeError, 'a second journal is refused');
  const user = await linkedUser(h);
  const purchase = seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: user.wallet.address });
  assert.equal(ports.readPurchase(purchase.id, purchase.token).id, purchase.id);
  assert.equal(ports.readPurchase(purchase.id, 'x'.repeat(43)), null);
  assert.deepEqual(touched, [], 'nothing was read from or written to the journal');
});

test('with the recorder subpath namespace given to createApp, the evidence ports build the recorder once over the injected journal and the startup admission, and a null journal builds none', async (t) => {
  const built = [];
  const recorderNamespace = { createPurchaseEvidenceRecorder: (options) => { built.push(options); return Object.freeze({ recorder: built.length }); } };
  const withJournal = (await switchOnHarness(t, { appOptions: { recorderNamespace } })).h.app.services.switchOn;
  const journal = {};
  const ports = withJournal.createSwitchOnEvidencePorts({ journal });
  withJournal.createSwitchOnEvidencePorts({ journal });
  assert.equal(built.length, 1);
  assert.equal(built[0].journal, journal);
  assert.equal(built[0].admission.binding, withJournal.startupResult.binding);
  assert.equal(ports.recorder.recorder, 1);
  const withoutJournal = (await switchOnHarness(t, { appOptions: { recorderNamespace } })).h.app.services.switchOn;
  assert.equal(withoutJournal.createSwitchOnEvidencePorts({ journal: null }).recorder, null);
  assert.equal(built.length, 1, 'no recorder without a journal');
});

test('the portal and CREATE routers are built with the switch-on route inputs themselves, which share the process\'s one relay capability store', async (t) => {
  const captured = {};
  const routerFactories = {
    portal: (options) => { captured.portal = options; return createPortalRouter(options); },
    agreementCreate: (options) => { captured.agreementCreate = options; return createAgreementCreateRouter(options); },
  };
  const { h } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' }, appOptions: { routerFactories } });
  const { switchOn } = h.app.services;
  assert.ok(Object.isFrozen(switchOn.routeInputs));
  assert.equal(captured.portal, switchOn.routeInputs.portal);
  assert.equal(captured.agreementCreate, switchOn.routeInputs.agreementCreate);
  assert.ok(switchOn.relayAccess, 'the process has a relay capability store');
  assert.equal(captured.portal.relayAccess, switchOn.relayAccess);
  assert.equal(captured.agreementCreate.relayAccess, switchOn.relayAccess);
});

test('with the switch on, the CREATE delivery gate reads KILL on every call: absent lets it through, present answers writes_stopped, and a failed startup binding answers its own code', async (t) => {
  const { h } = await switchOnHarness(t);
  const { delivery } = h.app.services.switchOn.createSwitchOnEvidencePorts({ journal: null });
  assert.equal(delivery.gate(), null);
  writeFileSync(join(h.dataDir, 'KILL'), '');
  assert.equal(delivery.gate(), 'writes_stopped');
  rmSync(join(h.dataDir, 'KILL'));
  assert.equal(delivery.gate(), null);
  const failed = (await switchOnHarness(t, { node: tp1Node({ chainIdentity: FIXTURE_CHAIN }) })).h;
  assert.equal(failed.app.services.switchOn.createSwitchOnEvidencePorts({ journal: null }).delivery.gate(), 'tp1_connection_unverified');
});

test('createApp binds over a node connection prepared for its own configuration and opens none of its own, and builds its own when the prepared one is for another configuration', async (t) => {
  const [prepared, own] = [tp1Node(), tp1Node()];
  const config = directConfig(t);
  const app = await directApp(t, { config, fetchImpl: routedFetch(own), preparedOwner: prepareSwitchOnOwner({ config, fetchImpl: routedFetch(prepared) }) });
  assert.equal(app.services.switchOn.startupResult.ok, true);
  assert.ok(prepared.reads.length > 0, 'the startup binding read the node over the prepared connection');
  assert.deepEqual(own.reads, [], 'no second connection');

  const [foreign, fallback] = [tp1Node(), tp1Node()];
  const other = directConfig(t);
  const second = await directApp(t, { config: other, fetchImpl: routedFetch(fallback), preparedOwner: prepareSwitchOnOwner({ config: directConfig(t), fetchImpl: routedFetch(foreign) }) });
  assert.equal(second.services.switchOn.startupResult.ok, true);
  assert.deepEqual(foreign.reads, [], 'a connection prepared for another configuration is not used');
  assert.ok(fallback.reads.length > 0);
});

test('the operation store exposes the stored handoff expiry as handoffExpiresAt, and relay access refuses a malformed stored expiry with relay_access_denied rather than a RangeError', async (t) => {
  const { h } = await switchOnHarness(t);
  const user = await linkedUser(h);
  const purchase = seedHandoffPurchase(h, { accountId: accountOf(h, user), wallet: user.wallet.address, handoffExpiresAt: 'bad' });
  assert.equal(h.app.services.ops.getByHandoff(purchase.id, purchase.token).handoffExpiresAt, 'bad');
  assert.throws(() => h.app.services.switchOn.relayAccess.mint({ operationId: purchase.id, phases: ['bind'] }), RelayAccessError);
});

test('the app database exports its one purchase store, whose transaction is the one every store write runs in', () => {
  assert.equal(purchaseStore.transaction, transaction);
});

test('with the switch on, the MCP server gives the standard instructions, and prepare_purchase without a protocol answers with no protocol', async (t) => {
  const { h } = await switchOnHarness(t);
  const client = new Client({ name: 'switch-on-instructions', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  t.after(() => client.close());
  assert.equal(client.getInstructions(), INSTRUCTIONS);
  const user = await linkedUser(h);
  const prepared = await tool(h, user, 'prepare_purchase', { listingId: 'fixture-report', version: 1, seller: user.wallet.claim, idempotencyKey: 'no-protocol' });
  assert.equal(prepared.raw?.structuredContent?.protocol, undefined);
});
