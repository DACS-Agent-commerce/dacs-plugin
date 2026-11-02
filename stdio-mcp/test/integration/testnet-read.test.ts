/**
 * Read-only integration test against the public Demos testnet RPC.
 * Spawns the BUILT server (dist/index.js) over stdio exactly as an MCP client
 * would, with writes disabled and no key configured: this test cannot spend.
 * Run: npm run build && npm run test:integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { contentHash } from '../../src/dacs/jcs.js';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.DEMOS_RPC_URL;

type Tx = { hash: string; from: string; to: string; type: string; amount: string };
async function recentTxs(): Promise<{ any: Tx; native: Tx | null }> {
  const d = new Demos();
  await d.connect(RPC);
  const txs = (await d.getTransactions('latest', 300)) as any[];
  let any: Tx | null = null;
  let native: Tx | null = null;
  for (const t of txs) {
    const c = typeof t.content === 'string' ? JSON.parse(t.content) : t.content;
    if (t.status !== 'confirmed' || !c?.from) continue;
    const tx = { hash: t.hash, from: c.from, to: c.to, type: c.type, amount: String(c.amount) };
    any ??= tx;
    if (!native && c.type === 'native' && /^[1-9][0-9]*$/.test(tx.amount)) native = tx;
  }
  if (!any) throw new Error('no recent confirmed transaction found on testnet');
  return { any, native };
}
const osToDemStr = (os: string) => {
  const b = BigInt(os);
  const f = (b % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return (b / 1_000_000_000n).toString() + (f ? '.' + f : '');
};

test('testnet read path through the real stdio server (0 DEM, writes off)', { timeout: 180_000, skip: RPC ? false : 'set DEMOS_RPC_URL to a testnet node' }, async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'index.js')],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DEMOS_RPC_URL: RPC, DEMOS_STATE_DIR: join(ROOT, 'node_modules', '.demos-mcp-it') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'it', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    const text = r.content.map((c: any) => c.text).join('');
    assert.ok(!r.isError, `${name} failed: ${text}`);
    return JSON.parse(text);
  };
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /prepare|submit/.test(t)), 'no write tools without explicit enable');

    const info = await call('demos_network_info');
    assert.equal(info.network, 'testnet');
    assert.ok(info.last_block > 0);
    assert.match(info.safety.writes, /disabled/);

    const { any: tx, native } = await recentTxs();
    const got = await call('demos_tx_get', { hash: tx.hash });
    assert.equal(got.state, 'included');
    assert.equal(got.content.from.toLowerCase(), tx.from.toLowerCase());

    const bal = await call('demos_balance', { address: tx.from });
    assert.equal(bal.exists_on_chain, true);
    assert.match(bal.balance_os, /^[0-9]+$/);

    const ids = await call('demos_identity_lookup', { address: tx.from });
    assert.equal(typeof ids.identities, 'object');

    // storage: an absent address reads as found:false; a private one reports access denied
    const absent = await call('demos_storage_read', { address: 'stor-' + '1'.repeat(40) });
    assert.equal(absent.found, false);
    if (tx.type === 'storageProgram' && typeof tx.to === 'string' && tx.to.startsWith('stor-')) {
      const r = (await client.callTool({ name: 'demos_storage_read', arguments: { address: tx.to } })) as any;
      const text = r.content.map((c: any) => c.text).join('');
      if (r.isError) assert.match(text, /access denied/);
      else {
        const s = JSON.parse(text);
        assert.equal(s.found, true);
        assert.match(s.content_hash_jcs_sha256, /^[0-9a-f]{64}$/);
      }
    }

    // A pay-dem SettlementEvidence pointing at a real included native transfer, signed by a throwaway
    // key:<hex> orchestrator claim: signature, signer authority, inclusion AND on-chain amount are checked.
    if (!native) {
      t.diagnostic('no native transfer in the last 300 txs; evidence check skipped');
    } else {
      const priv = new Uint8Array(32).fill(5);
      const claim = 'key:' + Buffer.from(ed.getPublicKey(priv)).toString('hex');
      const sign = (ev: Record<string, any>) => {
        const h = contentHash(ev, ['signature']);
        return { ...ev, signature: { algorithm: 'ed25519', signer: claim, value: Buffer.from(ed.sign(new TextEncoder().encode('dacs-evidence:v1:' + h), priv)).toString('base64url') } };
      };
      const base = {
        evidenceVersion: '1', jobId: '01JZTESTNETREADONLY0000000', phase: 'pay-dem', outcome: 'success',
        paymentTxRefs: [{ kind: 'demos', txHash: native.hash }], paymentAmount: { amount: osToDemStr(native.amount), currency: 'DEM' },
        settlementFinality: { model: 'bft-final' }, observedAt: Date.now(),
      };
      const v = await call('demos_dacs_receipt_verify', { receipt: sign(base), expected_signer: claim });
      assert.equal(v.decision, 'accept', JSON.stringify(v.checks));
      assert.ok(v.checks.some((c: any) => c.check.endsWith('amount') && c.decision === 'pass'));
      // wrong amount → reject; absent tx → not accept; no session context → not accept
      const wrong = await call('demos_dacs_receipt_verify', { receipt: sign({ ...base, paymentAmount: { amount: '0.000000001', currency: 'DEM' } }), expected_signer: claim });
      assert.equal(wrong.decision, 'reject');
      const absent = await call('demos_dacs_receipt_verify', { receipt: sign({ ...base, paymentTxRefs: [{ kind: 'demos', txHash: 'f'.repeat(64) }] }), expected_signer: claim });
      assert.notEqual(absent.decision, 'accept');
      const noCtx = await call('demos_dacs_receipt_verify', { receipt: sign(base) });
      assert.equal(noCtx.decision, 'indeterminate');
    }
  } finally {
    await client.close();
  }
});
