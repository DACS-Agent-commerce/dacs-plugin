// Real MCP Streamable HTTP transport tests using the official client SDK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHarness } from './helpers/harness.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { sellerValue } from './helpers/model-report.mjs';

let h;
let seller;
let listing;
before(async () => {
  h = await startHarness();
  seller = createEphemeralWallet();
  listing = fixtureListing(seller, { listingId: 'weather-report', title: 'Weather report agent' });
  const locator = fixtureLocator('weather-report');
  h.chain.seedStorage(locator, { data: listing, owner: seller.address });
  h.directory.add(summaryFor(listing, locator), listing);
});
after(async () => h.close());

async function connect(opts = {}) {
  const client = new Client({ name: 'dacs-test', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), opts);
  await client.connect(transport);
  return { client, transport };
}

test('health reports configuration without claiming live success', async () => {
  const res = await fetch(`${h.origin}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.mcp, h.mcpUrl);
  assert.equal(body.dependencies.chain.configured, true);
  assert.match(body.liveness, /never reports chain, payment or ChatGPT installation success/);
});

test('protected resource metadata advertises the exact resource and issuer', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const prm = await (await fetch(`${h.origin}${path}`)).json();
    assert.equal(prm.resource, h.mcpUrl);
    assert.deepEqual(prm.authorization_servers, [`${h.origin}/oauth`]);
    assert.ok(prm.scopes_supported.includes('dacs.purchases.write'));
  }
  const as = await (await fetch(`${h.origin}/.well-known/oauth-authorization-server/oauth`)).json();
  assert.equal(as.issuer, `${h.origin}/oauth`);
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.registration_endpoint);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
});

test('initialize, list tools with honest annotations and schemas, call public search', async () => {
  const { client } = await connect();
  const info = client.getServerVersion();
  assert.equal(info.name, 'dacs-chatgpt-plugin');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(info.version, pkg.version);
  assert.match(client.getInstructions() ?? '', /directory results are hints/);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // The v2 buyer surface: publication tools are retired; keep the approved
  // identity extension (get_identities, start_identity_action). Exactly these.
  const ORIGINAL = ['search_agents', 'get_listing', 'get_profile', 'get_account_status', 'start_wallet_link', 'prepare_purchase', 'get_purchase_status', 'verify_deal', 'cancel_wallet_handoff'];
  const IDENTITY_EXTENSION = ['get_identities', 'start_identity_action'];
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ORIGINAL, ...IDENTITY_EXTENSION].sort());
  for (const name of [...ORIGINAL, ...IDENTITY_EXTENSION]) {
    assert.ok(byName[name], `missing tool ${name}`);
    assert.ok(byName[name].inputSchema, `${name} input schema`);
    assert.ok(byName[name].outputSchema, `${name} output schema`);
    assert.ok(byName[name].annotations, `${name} annotations`);
    assert.ok(Array.isArray(byName[name]._meta?.securitySchemes), `${name} _meta.securitySchemes`);
  }
  assert.equal(byName.search_agents.annotations.readOnlyHint, true);
  assert.equal(byName.search_agents.annotations.openWorldHint, true);
  assert.deepEqual(byName.search_agents._meta.securitySchemes, [{ type: 'noauth' }]);
  assert.equal(byName.prepare_purchase.annotations.readOnlyHint, false);
  assert.equal(byName.get_purchase_status.annotations.readOnlyHint, true);
  assert.equal(byName.get_profile._meta['openai/profile'], true);
  assert.deepEqual(byName.get_profile.outputSchema.required, ['id']);
  assert.deepEqual(byName.prepare_purchase._meta.securitySchemes, [{ type: 'oauth2', scopes: ['dacs.purchases.write'] }]);
  // No tool accepts an approval flag or account id from the model.
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema.properties ?? {});
    for (const forbidden of ['approved', 'accountId', 'owner', 'confirmed', 'completed']) assert.ok(!props.includes(forbidden), `${tool.name} accepts ${forbidden}`);
  }

  const result = await client.callTool({ name: 'search_agents', arguments: { query: 'weather' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results.length, 1);
  assert.equal(result.structuredContent.results[0].verified, false);
  assert.equal(result.structuredContent.evidenceMode, 'simulated-fixture');
  // Seller text passes the SDK's output-schema check only as a seller-data envelope.
  assert.equal(sellerValue(result.structuredContent.results[0].title), 'Weather report agent');
  await client.close();
});

// What the model is told about payment: settled_verified is one RPC node's
// tuple-only observation, never paid-and-final, a purchase-specific receipt or
// fulfilled service; real testnet payment and extension payments are held.
test('payment wording: instructions and purchase tools never present settled_verified as final, a receipt or delivery', async () => {
  const { client } = await connect();
  const instructions = client.getInstructions() ?? '';
  assert.doesNotMatch(instructions, /approved, paid or final unless/, 'no instruction that settled_verified means paid or final');
  for (const phrase of ['settled_verified', 'one configured Demos RPC node', 'tuple-only', 'not finality', 'not a purchase-specific receipt', 'not service fulfillment', 'network_identity_unpinned', 'never asks an installed wallet extension to pay']) {
    assert.ok(instructions.includes(phrase), `instructions say: ${phrase}`);
  }
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.doesNotMatch(byName.verify_deal.description, /independently|settlement is accepted/);
  for (const phrase of ['one node', 'tuple-only', 'not finality', 'not a purchase-specific receipt']) assert.ok(byName.verify_deal.description.includes(phrase), `verify_deal says: ${phrase}`);
  assert.doesNotMatch(byName.get_purchase_status.description, /verified evidence/);
  assert.ok(byName.get_purchase_status.description.includes('tuple-only'));
  assert.ok(byName.prepare_purchase.description.includes('network_identity_unpinned'));
  await client.close();
});

test('get_listing independently verifies chain readback and labels simulation', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'get_listing', arguments: { listingId: 'weather-report', version: 1, seller: seller.claim } });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const v = result.structuredContent;
  assert.equal(v.transactable, true, JSON.stringify(v.checks));
  assert.equal(v.disposition, 'verified');
  assert.equal(v.price.amount, '2.5');
  assert.equal(v.price.amountOs, '2500000000');
  assert.equal(v.evidence.chainMode, 'simulated-fixture');
  assert.ok(v.checks.every((c) => c.ok));
  assert.equal(sellerValue(v.title), 'Weather report agent');
  assert.equal(result.content[0].text, 'Transactable: weather-report v1 for 2.5 DEM; every check passed (evidence mode simulated-fixture).');
  await client.close();
});

test('MCP Apps resources are listed with versioned URIs and empty CSP allowlists', async () => {
  const { client } = await connect();
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ['ui://dacs/listings-v3.html', 'ui://dacs/status-v5.html']);
  const read = await client.readResource({ uri: 'ui://dacs/status-v5.html' });
  assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(read.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(read.contents[0].text, /ui\/initialize/);
  await client.close();
});

test('protected tools return an OAuth challenge with mcp/www_authenticate when anonymous', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'get_profile', arguments: {} });
  assert.equal(result.isError, true);
  const challenge = result._meta['mcp/www_authenticate'][0];
  assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="/);
  const purchase = await client.callTool({ name: 'prepare_purchase', arguments: { listingId: 'weather-report', version: 1, seller: seller.claim, idempotencyKey: 'anon-attempt-1' } });
  assert.equal(purchase.isError, true);
  assert.match(purchase._meta['mcp/www_authenticate'][0], /scope="dacs.purchases.write"/);
  await client.close();
});

test('an invalid bearer token is refused at the HTTP layer with a 401 challenge', async () => {
  const res = await fetch(h.mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata="[^"]+oauth-protected-resource\/mcp"/);
});

test('invalid tool input is rejected by schema validation', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'get_listing', arguments: { listingId: 'x', version: 0, seller: 'not-a-did' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /validation/i);
  await client.close();
});

test('foreign Host and Origin headers are rejected', async () => {
  const res = await fetch(h.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});
