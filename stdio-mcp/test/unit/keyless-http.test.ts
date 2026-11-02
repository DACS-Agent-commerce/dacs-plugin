/**
 * The streamable HTTP transport is keyless: read, verify, and unsigned prepare.
 * It does not open a wallet and it does not register submit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../../src/config.js';
import { SecretGuard } from '../../src/secrets.js';
import { ConfirmationGate } from '../../src/confirm.js';
import { SpendLedger } from '../../src/spend.js';
import { listenKeyless } from '../../src/http_transport.js';
import { MockChain, keypair } from '../helpers.js';

const READ_VERIFY_PREPARE = [
  'demos_network_info',
  'demos_balance',
  'demos_tx_get',
  'demos_identity_lookup',
  'demos_dacs_receipt_verify',
  'demos_storage_read',
  'demos_tx_prepare',
  'demos_identity_attest_prepare',
  'demos_dacs_create_offer_prepare',
  'demos_dacs_accept_prepare',
  'demos_dacs_listing_prepare',
  'demos_dacs_listing_verify',
];

test('keyless http serves read, verify, and unsigned prepare, and does not submit', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'demos-mcp-keyless-'));
  const config = loadConfig({ DEMOS_STATE_DIR: stateDir, DEMOS_NETWORK: 'testnet' } as NodeJS.ProcessEnv);
  config.writesEnabled = false;
  config.keystorePath = undefined;
  config.keystorePassphrase = undefined;
  config.keystorePassphraseFile = undefined;
  config.mnemonicFile = undefined;
  config.approvalPage = false;
  const guard = new SecretGuard();
  const chain = new MockChain();
  const address = keypair(4).address;
  chain.balances.set(address, 5_000_000_000n);
  let opened = 0;
  const gate = new ConfirmationGate([], config.confirmTtlMs, guard);
  const ledger = new SpendLedger(stateDir, config.dailyCapOs);
  const listening = await listenKeyless(
    {
      config,
      guard,
      chain,
      gate,
      ledger,
      surface: 'keyless',
      openWallet: async () => {
        opened += 1;
        throw new Error('wallet opened');
      },
    },
    0,
  );
  const auth = JSON.parse(readFileSync(listening.authPath, 'utf8')) as { bearer: string };
  assert.equal(statSync(listening.authPath).mode & 0o777, 0o600);
  assert.match(auth.bearer, /^[0-9a-f]{64}$/);
  const client = new Client({ name: 'keyless-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(listening.url), {
    requestInit: { headers: { Authorization: `Bearer ${auth.bearer}` } },
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const required of READ_VERIFY_PREPARE) assert.ok(names.includes(required), required);
    assert.equal(names.includes('demos_tx_submit'), false);
    assert.equal(names.includes('demos_tx_cancel'), false);
    assert.equal(names.includes('demos_identity_proof_payload'), false);
    assert.equal(names.some((name) => name.startsWith('demos_onboard')), false);
    const pay = (await client.callTool({
      name: 'demos_tx_prepare',
      arguments: { to: address, amount_dem: '1' },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const text = pay.content.map((part) => part.text).join('\n');
    assert.equal(pay.isError, undefined);
    const body = JSON.parse(text) as { holds_keys: boolean; signed: boolean; submit: string; unsigned_tx: { amount_dem: string; to: string } };
    assert.equal(body.holds_keys, false);
    assert.equal(body.signed, false);
    assert.equal(body.submit, 'refused');
    assert.equal(body.unsigned_tx.amount_dem, '1');
    assert.equal(body.unsigned_tx.to, address);
    assert.equal(opened, 0);
    const info = (await client.callTool({ name: 'demos_network_info', arguments: {} })) as { content: Array<{ text: string }> };
    const safety = JSON.parse(info.content.map((part) => part.text).join('\n')) as { safety: { signing: string; wallet_address: null; receipt_issuer: null } };
    assert.match(safety.safety.signing, /does not hold keys/);
    assert.equal(safety.safety.wallet_address, null);
    assert.equal(safety.safety.receipt_issuer, null);
    const health = await fetch(`http://127.0.0.1:${listening.port}/health`, {
      headers: { Authorization: `Bearer ${auth.bearer}` },
    });
    const healthBody = (await health.json()) as { holds_keys: boolean; submit: boolean };
    assert.equal(healthBody.holds_keys, false);
    assert.equal(healthBody.submit, false);
    assert.equal(JSON.stringify(healthBody).includes(auth.bearer), false);
  } finally {
    await client.close();
    await listening.close();
  }
});

function rawGet(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('keyless http rejects a missing bearer, a foreign host, and a foreign origin', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'demos-mcp-keyless-auth-'));
  const config = loadConfig({ DEMOS_STATE_DIR: stateDir, DEMOS_NETWORK: 'testnet' } as NodeJS.ProcessEnv);
  config.writesEnabled = false;
  config.approvalPage = false;
  const guard = new SecretGuard();
  const listening = await listenKeyless(
    {
      config,
      guard,
      chain: new MockChain(),
      gate: new ConfirmationGate([], config.confirmTtlMs, guard),
      ledger: new SpendLedger(stateDir, config.dailyCapOs),
      surface: 'keyless',
      openWallet: async () => {
        throw new Error('wallet opened');
      },
    },
    0,
  );
  const auth = JSON.parse(readFileSync(listening.authPath, 'utf8')) as { bearer: string };
  const bearer = { Authorization: `Bearer ${auth.bearer}` };
  try {
    const missing = await rawGet(listening.port, {});
    assert.equal(missing.status, 401);
    assert.equal(missing.body.includes(auth.bearer), false);

    const wrong = await rawGet(listening.port, { Authorization: 'Bearer 00' });
    assert.equal(wrong.status, 401);

    const evilHost = await rawGet(listening.port, { ...bearer, Host: 'evil.example' });
    assert.equal(evilHost.status, 403);
    assert.equal(evilHost.body.includes('evil.example'), false);

    const evilOrigin = await rawGet(listening.port, { ...bearer, Origin: 'http://evil.example' });
    assert.equal(evilOrigin.status, 403);

    const wrongPort = await rawGet(listening.port, { ...bearer, Host: '127.0.0.1:1' });
    assert.equal(wrongPort.status, 403);

    const localOrigin = await rawGet(listening.port, { ...bearer, Origin: `http://127.0.0.1:${listening.port}` });
    assert.equal(localOrigin.status, 200);

    const localhost = await rawGet(listening.port, { ...bearer, Host: `localhost:${listening.port}` });
    assert.equal(localhost.status, 200);

    const loopback = await rawGet(listening.port, { ...bearer, Host: `[::1]:${listening.port}` });
    assert.equal(loopback.status, 200);
  } finally {
    await listening.close();
  }
});
