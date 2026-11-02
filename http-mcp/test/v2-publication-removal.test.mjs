import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser } from './helpers/flows.mjs';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { SCOPES, RESOURCE_SCOPES, SCOPE_DESCRIPTIONS } from '../src/auth/scopes.mjs';

const removed = ['register_agent', 'get_agent_status', 'verify_agent_publication'];
for (const flags of [{}, { showcasePublicationView: true }, { showcasePublicationView: true, showcaseReportView: true }, { showcasePublicationView: true, showcaseLedger: true }]) {
  test(`v2 has no publication tools or resources under ${JSON.stringify(flags)}`, async (t) => {
    const server = createMcpServerFactory({ config: { publicOrigin: 'https://plugin.example', ...flags }, services: {}, logger: { info() {}, error() {} } })();
    t.after(() => server.close());
    for (const name of removed) assert.equal(server._registeredTools[name], undefined, name);
    assert.equal(Object.keys(server._registeredResources).some(uri => uri.includes('publication')), false);
    for (const name of ['search_agents', 'get_listing', 'get_profile', 'get_account_status', 'start_wallet_link', 'prepare_purchase', 'get_purchase_status', 'verify_deal', 'cancel_wallet_handoff', 'get_identities', 'start_identity_action']) assert.ok(server._registeredTools[name], name);
    assert.doesNotMatch(readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8'), /register_agent prepares/);
  });
}

test('no browser test drives a retired publication tool or signing page', () => {
  const retired = new RegExp(`${removed.join('|')}|/portal/(?:api/)?publish`);
  for (const directory of ['../test/browser/', '../deploy/test/']) {
    for (const name of readdirSync(new URL(directory, import.meta.url)).filter(file => file.endsWith('.browser.test.mjs'))) {
      assert.doesNotMatch(readFileSync(new URL(`${directory}${name}`, import.meta.url), 'utf8'), retired, `${directory}${name}`);
    }
  }
});

test('v2 routes historical publication cancellation only to the owner recovery service', async t => {
  let calls = 0;
  const server = createMcpServerFactory({ config: { publicOrigin: 'https://plugin.example' }, services: {
    accounts: { resolveFromToken: () => ({ id: 'account_TEST' }) },
    agents: { cancel(args) { calls++; assert.deepEqual(args, { accountId: 'account_TEST', operationId: `pub_${'A'.repeat(16)}` }); return { operation: { status: 'cancelled' }, cancelled: true }; } },
    purchases: { cancel() { throw new Error('purchase service must not run'); } },
  }, logger: { info() {}, error() {} } })();
  t.after(() => server.close());
  const result = await server._registeredTools.cancel_wallet_handoff.handler({ operationId: `pub_${'A'.repeat(16)}` }, { http: { authInfo: { scopes: [SCOPES.AGENTS_WRITE], extra: { issuer: 'TEST', subject: 'TEST' } } } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { operationId: `pub_${'A'.repeat(16)}`, status: 'cancelled', cancelled: true });
  assert.equal(calls, 1);
});

test('publication implementation and portal signing flow leave the v2 package', () => {
  for (const path of ['../src/agents.mjs', '../src/publication-checks.mjs', '../src/mcp/publication-view.mjs', '../public/portal/publication-stage-text.mjs']) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  const dashboardHtml = readFileSync(new URL('../bin/offline-fixtures/tester-ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboardHtml, /href="#seller"/);
  const dashboard = readFileSync(new URL('../bin/offline-fixtures/tester-dashboard.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /await tool\('(register_agent|get_agent_status|verify_agent_publication)'/);
  const portal = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
  assert.doesNotMatch(portal, /async function publishFlow|\/portal\/api\/publish\//);
  const routes = readFileSync(new URL('../src/portal/routes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /\/portal\/publish\/:id|\/portal\/api\/publish\//);
});

test('v2 preserves the OAuth scope set for existing account links', () => {
  assert.deepEqual([...RESOURCE_SCOPES].sort(), ['dacs.account.read', 'dacs.agents.write', 'dacs.identities.write', 'dacs.purchases.write']);
  assert.match(SCOPE_DESCRIPTIONS[SCOPES.AGENTS_WRITE], /Legacy v1 agent scope/);
  const flag = JSON.parse(readFileSync(new URL('../src/switches/DACS_SHOWCASE_PUBLICATION_VIEW.switch', import.meta.url)));
  assert.match(flag.operatorNote, /Retired in v2/);
});

// Startup refusals must run before configuration, imports, approvals or writes.
// The purchase launcher also gets its valid start and resume invocations.
const CONFIG = '--config=/TEST-must-not-read.json';
const LAUNCHER_ARGUMENTS = {
  'devnet-demo-compose.mjs': [[CONFIG]],
  'devnet-demo-purchase.mjs': [[CONFIG], [CONFIG, '--idempotency-key=TEST-probe'], [CONFIG, '--resume=TEST-probe']],
};
for (const [script, argumentSets] of Object.entries(LAUNCHER_ARGUMENTS)) {
  for (const args of argumentSets) {
    test(`v2 refuses the retired seller launcher ${[script, ...args.slice(1)].join(' ')} before reading config`, async () => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, ...args], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /in-process demo seller is retired in v2/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    });
  }
}

test('showcase and fixed-price guides scope the historical label to the launchers and do not tell readers to run them', () => {
  const guide = (name) => readFileSync(new URL(`../docs/${name}.md`, import.meta.url), 'utf8');
  assert.match(guide('SHOWCASE-QUICKSTART'), /applies only to the `scripts\/devnet-demo-\*\.mjs` references below/);
  assert.doesNotMatch(guide('SHOWCASE-QUICKSTART'), /devnet-demo-compose\.mjs` starts\)/);
  assert.doesNotMatch(guide('DEVNET-FIXED-PRICE-DEMO'), /^\d+\. Run [^\n]*devnet-demo-purchase/m);
  assert.doesNotMatch(guide('DEVNET-FIXED-PRICE-DEMO'), /devnet-demo-compose\.mjs` now consumes/);
});

test('retired launchers leave no CLI-only stop exports or stop-request module', async () => {
  const stop = await import('../src/devnet-demo/stop.mjs');
  const approval = await import('../src/devnet-demo/operator-approval.mjs');
  for (const name of ['ownsShutdown', 'OWNED_SHUTDOWN_REFUSAL', 'installDevnetDemoStopSignals']) assert.equal(name in stop, false, name);
  assert.equal('ttyApprovalPending' in approval, false);
  assert.equal(existsSync(new URL('../src/devnet-demo/stop-request.mjs', import.meta.url)), false);
});
test('operator guides label retired launcher procedures and name programmatic readback recovery', () => {
  for (const name of ['DEVNET-OPERATOR-CLI','DEVNET-OPERATOR-RECOVERY','DEVNET-FIXED-PRICE-DEMO','DEVNET-CHATGPT-OPERATOR','SHOWCASE-QUICKSTART','DEVNET-OPERATOR-CLI-ISSUED-RECOVERY']) {
    const doc = readFileSync(new URL(`../docs/${name}.md`, import.meta.url), 'utf8');
    assert.match(doc, /Historical v1 launcher procedure/);
    assert.match(doc, /createBuyerDriver.*resume/);
    assert.doesNotMatch(doc, /^node scripts\/devnet-demo-(?:compose|purchase)/m);
  }
});

for (const enabled of ['0', '1']) {
  test(`all publication signing routes stay unavailable with switch=${enabled}`, async t => {
    const h = await startHarness({ env: { DACS_SHOWCASE_PUBLICATION_VIEW: enabled } });
    t.after(() => h.close());
    const user = await linkedUser(h), accountId = h.app.services.accounts.walletOwner(user.wallet.address);
    const { operation } = h.app.services.ops.createIdempotent({ accountId, kind: 'listing_publication', subjectId: 'agt_legacy_api_00001', idempotencyKey: 'TEST-route-retirement', request: {}, status: 'publication_handoff', terms: {}, termsHash: 'ab'.repeat(32), state: {}, expiresAt: '2099-01-01T00:00:00.000Z' });
    const token = h.app.services.ops.handoffTokenFor(operation.id);
    for (const step of ['view','identity','listing','handoff','report','registration','register','verify']) {
      const response = await fetch(`${h.origin}/portal/api/publish/${operation.id}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(response.status, 404, step);
      assert.deepEqual(await response.json(), { error: 'not_found' }, `${step} has no route rather than a domain error`);
    }
  });
}

test('the package has no publication renderer export or publication assets', async () => {
  const ui = await import('../src/mcp/ui.mjs');
  assert.equal('PUBLICATION_STATUS_RENDER' in ui, false);
  for (const path of ['../src/mcp/publication-view.mjs','../public/portal/publication-stage-text.mjs']) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
});
