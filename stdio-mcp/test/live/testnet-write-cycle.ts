/**
 * LIVE testnet write-cycle driver (spends testnet DEM; never run against mainnet).
 *
 * Drives the BUILT server (dist/index.js) over stdio exactly as an MCP client would:
 * prepare -> off-chat approval page -> submit. The human's role on the approval page is
 * played by this driver: it reads the single-use approval link from the server's
 * out-of-band `stderr` channel (never from a tool result) and POSTs Approve to the local
 * page. That is a test-only stand-in for a human; the link is never printed or logged.
 *
 *   npx tsx test/live/testnet-write-cycle.ts <phase>
 *
 * Phases: info | fund | pay | dacs | expired. Each phase prints one JSON object (no secrets).
 * Configuration comes from env: LIVE_MCP_KEYSTORE, LIVE_BUYER_KEYSTORE, LIVE_SELLER_KEYSTORE,
 * LIVE_PASSPHRASE_FILE, LIVE_MCP_STATE, LIVE_AUX_STATE, LIVE_MCP_CAP_DEM.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.DEMOS_RPC_URL ?? '';
if (!RPC) {
  console.log(JSON.stringify({ skipped: 'set DEMOS_RPC_URL to a testnet node' }));
  process.exit(0);
}
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

interface Instance {
  name: string;
  client: Client;
  links: string[];
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; value: any; text: string }>;
  nextLink: (timeoutMs?: number) => Promise<string>;
  close: () => Promise<void>;
}

async function start(name: string, env: Record<string, string>): Promise<Instance> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'index.js')],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DEMOS_NETWORK: 'testnet',
      DEMOS_RPC_URL: RPC,
      DEMOS_MCP_ENABLE_WRITES: '1',
      DEMOS_CONFIRM_CHANNELS: 'stderr',
      DEMOS_CODE_FALLBACK: '0', // approval only through the page
      DEMOS_KEYSTORE_PASSPHRASE_FILE: need('LIVE_PASSPHRASE_FILE'),
      ...env,
    },
    stderr: 'pipe',
  });
  const links: string[] = [];
  let buf = '';
  transport.stderr?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = /APPROVE OR DENY HERE: (http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{43})/.exec(line);
      if (m) links.push(m[1]!);
      // never echo approval links or codes
      else if (process.env.LIVE_VERBOSE && !/\/a\/|code/i.test(line)) process.stderr.write(`[${name}] ${line}\n`);
    }
  });
  const client = new Client({ name: `live-${name}`, version: '0' });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 })) as any;
    const text = r.content.map((c: any) => c.text).join('');
    let value: any = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { ok: !r.isError, value, text };
  };
  const nextLink = async (timeoutMs = 10_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const l = links.shift();
      if (l) return l;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no approval link arrived on the out-of-band channel');
  };
  return { name, client, links, call, nextLink, close: () => client.close() };
}

/** The test driver's stand-in for the human: open the card, then POST approve. */
async function approve(link: string): Promise<{ get: number; headline: string | null; post: number }> {
  const g = await fetch(link);
  const html = await g.text();
  const headline = /<p style="font-size:20px"><b>(.*?)<\/b><\/p>/.exec(html)?.[1] ?? null;
  const p = await fetch(`${link}/approve`, { method: 'POST' });
  await p.text();
  return { get: g.status, headline, post: p.status };
}

async function reuse(link: string): Promise<{ get: number; post_approve: number; post_deny: number }> {
  const g = await fetch(link);
  await g.text();
  const a = await fetch(`${link}/approve`, { method: 'POST' });
  await a.text();
  const d = await fetch(`${link}/deny`, { method: 'POST' });
  await d.text();
  return { get: g.status, post_approve: a.status, post_deny: d.status };
}

const out: Record<string, unknown> = {};
const mcpEnv = () => ({ DEMOS_KEYSTORE: need('LIVE_MCP_KEYSTORE'), DEMOS_STATE_DIR: need('LIVE_MCP_STATE'), DEMOS_DAILY_CAP_DEM: need('LIVE_MCP_CAP_DEM') });

async function readback(inst: Instance, hash: string) {
  const r = await inst.call('demos_tx_get', { hash });
  return r.value;
}

async function verifyReceipt(inst: Instance, receipt: any, issuer: string) {
  const good = await inst.call('demos_dacs_receipt_verify', { receipt, expected_signer: issuer });
  const tampered = structuredClone(receipt);
  tampered.spend_os = String(BigInt(tampered.spend_os ?? '0') + 1n);
  const bad1 = await inst.call('demos_dacs_receipt_verify', { receipt: tampered, expected_signer: issuer });
  const tampered2 = structuredClone(receipt);
  if (tampered2.chain) tampered2.chain.amount_os = String(BigInt(tampered2.chain.amount_os) + 1000000000n);
  const bad2 = await inst.call('demos_dacs_receipt_verify', { receipt: tampered2, expected_signer: issuer });
  const unpinned = await inst.call('demos_dacs_receipt_verify', { receipt });
  return {
    original: good.value?.decision,
    tampered_spend_os: bad1.value?.decision,
    tampered_chain_amount: bad2.value?.decision,
    unpinned_issuer: unpinned.value?.decision,
    original_failed_checks: (good.value?.checks ?? []).filter((c: any) => c.decision !== 'pass'),
  };
}

async function phaseInfo() {
  const m = await start('mcp', mcpEnv());
  try {
    out.network_info = (await m.call('demos_network_info')).value;
    out.tools = (await m.client.listTools()).tools.map((t) => t.name);
  } finally {
    await m.close();
  }
}

/** Fund the MCP wallet from the existing buyer test wallet, through the MCP itself (faucet was down). */
async function phaseFund() {
  const to = need('LIVE_MCP_ADDRESS');
  const amount = need('LIVE_FUND_DEM');
  const f = await start('fund', { DEMOS_KEYSTORE: need('LIVE_BUYER_KEYSTORE'), DEMOS_STATE_DIR: join(need('LIVE_AUX_STATE'), 'buyer'), DEMOS_DAILY_CAP_DEM: String(Number(amount) + 2), DEMOS_RECIPIENT_ALLOWLIST: to });
  try {
    const prep = await f.call('demos_tx_prepare', { to, amount_dem: amount, memo: 'fund demos-mcp live test wallet' });
    if (!prep.ok) throw new Error(`fund prepare: ${prep.text}`);
    const ap = await approve(await f.nextLink());
    const sub = await f.call('demos_tx_submit', { prepared_id: prep.value.prepared_id, wait_seconds: 10 });
    out.fund = { prepare_fee_quote_dem: prep.value.fee_quote_dem, approval: ap, submit_ok: sub.ok, status: sub.value?.status, receipt_chain: sub.value?.receipt?.chain, error: sub.ok ? undefined : sub.text };
    if (sub.ok) out.fund_readback = await readback(f, sub.value.receipt.chain.tx_hash);
  } finally {
    await f.close();
  }
}

async function phasePay() {
  const to = need('LIVE_SELLER_ADDRESS');
  const state = need('LIVE_MCP_STATE');
  const m = await start('mcp', mcpEnv());
  try {
    const info = (await m.call('demos_network_info')).value;
    const issuer = info.safety.receipt_issuer;
    out.cap_before = info.safety.daily_cap_remaining_dem;

    // KILL at prepare
    writeFileSync(join(state, 'KILL'), 'live test\n');
    const killPrep = await m.call('demos_tx_prepare', { to, amount_dem: '1' });
    out.kill_at_prepare = { refused: !killPrep.ok, message: killPrep.text.slice(0, 200) };
    rmSync(join(state, 'KILL'));

    // KILL engaged after approval, before submit
    const p0 = await m.call('demos_tx_prepare', { to, amount_dem: '1', memo: 'kill-between-approve-and-submit test' });
    if (!p0.ok) throw new Error(`prepare p0: ${p0.text}`);
    const ap0 = await approve(await m.nextLink());
    writeFileSync(join(state, 'KILL'), 'live test\n');
    const s0 = await m.call('demos_tx_submit', { prepared_id: p0.value.prepared_id });
    rmSync(join(state, 'KILL'));
    out.kill_at_submit = { approved_on_page: ap0.post, refused: !s0.ok, message: s0.text.slice(0, 200) };
    out.cap_after_kill_tests = (await m.call('demos_network_info')).value.safety.daily_cap_remaining_dem;

    // Over-cap attempt: refused at prepare, before anything is signed or sent
    const overAmount = String(Number(need('LIVE_MCP_CAP_DEM')) + 1);
    const over = await m.call('demos_tx_prepare', { to, amount_dem: overAmount });
    out.over_cap = { amount_dem: overAmount, refused: !over.ok, message: over.text.slice(0, 200), link_issued: m.links.length > 0 };

    // The real PAY
    const prep = await m.call('demos_tx_prepare', { to, amount_dem: '1', memo: 'demos-mcp live testnet pay cycle' });
    if (!prep.ok) throw new Error(`pay prepare: ${prep.text}`);
    const link = await m.nextLink();
    const ap = await approve(link);
    const sub = await m.call('demos_tx_submit', { prepared_id: prep.value.prepared_id, wait_seconds: 10 });
    out.pay = {
      prepare: { signed: prep.value.signed, headline: prep.value.card?.headline, fee_quote_dem: prep.value.fee_quote_dem, spend_total_dem: prep.value.spend_total_dem },
      approval_page: ap,
      submit_ok: sub.ok,
      status: sub.value?.status,
      approved_by: sub.value?.approved_by,
      receipt_chain: sub.value?.receipt?.chain,
      error: sub.ok ? undefined : sub.text,
    };
    // hostile path: reuse the approval link, and resubmit the consumed prepared_id
    out.pay_link_reuse = await reuse(link);
    const again = await m.call('demos_tx_submit', { prepared_id: prep.value.prepared_id });
    out.pay_resubmit = { refused: !again.ok, message: again.text.slice(0, 200) };
    if (sub.ok) {
      out.pay_readback = await readback(m, sub.value.receipt.chain.tx_hash);
      out.pay_receipt_verify = await verifyReceipt(m, sub.value.receipt, issuer);
      out.pay_receipt = sub.value.receipt;
    }
    out.cap_after = (await m.call('demos_network_info')).value.safety.daily_cap_remaining_dem;
  } finally {
    await m.close();
  }
}

/** Expired approval: TTL 30 s; approve after expiry must be refused, and so must submit. */
async function phaseExpired() {
  const to = need('LIVE_SELLER_ADDRESS');
  const m = await start('mcp-ttl30', { ...mcpEnv(), DEMOS_CONFIRM_TTL_SEC: '30' });
  try {
    const prep = await m.call('demos_tx_prepare', { to, amount_dem: '1', memo: 'expiry test (must never send)' });
    if (!prep.ok) throw new Error(`prepare: ${prep.text}`);
    const link = await m.nextLink();
    await new Promise((r) => setTimeout(r, 32_000));
    const g = await fetch(link);
    await g.text();
    const p = await fetch(`${link}/approve`, { method: 'POST' });
    await p.text();
    const sub = await m.call('demos_tx_submit', { prepared_id: prep.value.prepared_id });
    out.expired = { expires_at: prep.value.approval?.expires_at, get_after_expiry: g.status, post_approve_after_expiry: p.status, submit_refused: !sub.ok, submit_message: sub.text.slice(0, 200) };
    out.cap_after = (await m.call('demos_network_info')).value.safety.daily_cap_remaining_dem;
  } finally {
    await m.close();
  }
}

/** DACS: the seller test wallet signs an offer (its own MCP instance); the MCP wallet accepts and pays. */
async function phaseDacs() {
  const mcpAddr = need('LIVE_MCP_ADDRESS');
  const s = await start('seller', { DEMOS_KEYSTORE: need('LIVE_SELLER_KEYSTORE'), DEMOS_STATE_DIR: join(need('LIVE_AUX_STATE'), 'seller'), DEMOS_DAILY_CAP_DEM: '1' });
  const h = (c: string) => c.repeat(64);
  const ref = (c: string) => ({ anchor: { kind: 'https', locator: `https://example.invalid/vet/${c}` }, contentHash: h(c) });
  let signedOffer: any;
  try {
    const prep = await s.call('demos_dacs_create_offer_prepare', {
      role: 'seller',
      listing_ref: { listingId: 'demos-mcp-live-test', version: 1, contentHash: h('a') },
      self_bundle_hash: h('b'),
      self_vet_record_ref: ref('c'),
      counterparty: { primary_claim: `key:${mcpAddr.replace(/^0x/, '')}`, bundle_hash: h('d'), vet_record_ref: ref('e') },
      price: { amount: '1', currency: 'DEM' },
      deliverable: { deliverableType: 'test-artifact', hash: h('f') },
      deadline_unix_ms: Date.now() + 30 * 60_000,
    });
    if (!prep.ok) throw new Error(`offer prepare: ${prep.text}`);
    const ap = await approve(await s.nextLink());
    const sub = await s.call('demos_tx_submit', { prepared_id: prep.value.prepared_id, wait_seconds: 10 });
    if (!sub.ok) throw new Error(`offer submit: ${sub.text}`);
    signedOffer = sub.value.signed_offer;
    out.offer = { agreement_hash: prep.value.agreement_hash, approval_page: ap, status: sub.value.status, approved_by: sub.value.approved_by, signatures: signedOffer.signatures.length, receipt_has_tx: !!sub.value.receipt?.chain };
    out.offer_verify = (await s.call('demos_dacs_receipt_verify', { receipt: signedOffer, check_chain: false })).value?.decision;
  } finally {
    await s.close();
  }

  const m = await start('mcp', mcpEnv());
  try {
    const info = (await m.call('demos_network_info')).value;
    const issuer = info.safety.receipt_issuer;
    out.cap_before = info.safety.daily_cap_remaining_dem;
    const prep = await m.call('demos_dacs_accept_prepare', { offer: signedOffer, pay: true });
    if (!prep.ok) throw new Error(`accept prepare: ${prep.text}`);
    const link = await m.nextLink();
    const ap = await approve(link);
    const sub = await m.call('demos_tx_submit', { prepared_id: prep.value.prepared_id, wait_seconds: 10 });
    out.accept = {
      prepare: { headline: prep.value.card?.headline, fee_quote_dem: prep.value.fee_quote_dem, spend_total_dem: prep.value.spend_total_dem },
      approval_page: ap,
      submit_ok: sub.ok,
      status: sub.value?.status,
      approved_by: sub.value?.approved_by,
      receipt_chain: sub.value?.receipt?.chain,
      settlement_tx_ref: sub.value?.settlement_tx_ref,
      agreement_signatures: sub.value?.agreement?.signatures?.length,
      error: sub.ok ? undefined : sub.text,
    };
    out.accept_link_reuse = await reuse(link);
    if (sub.ok) {
      out.accept_readback = await readback(m, sub.value.receipt.chain.tx_hash);
      out.agreement_verify = (await m.call('demos_dacs_receipt_verify', { receipt: sub.value.agreement })).value;
      out.accept_receipt_verify = await verifyReceipt(m, sub.value.receipt, issuer);
      out.accept_receipt = sub.value.receipt;
      out.agreement = sub.value.agreement;
    }
    out.cap_after = (await m.call('demos_network_info')).value.safety.daily_cap_remaining_dem;
  } finally {
    await m.close();
  }
}

const phase = process.argv[2];
const phases: Record<string, () => Promise<void>> = { info: phaseInfo, fund: phaseFund, pay: phasePay, dacs: phaseDacs, expired: phaseExpired };
if (!phases[phase ?? '']) throw new Error(`phase must be one of ${Object.keys(phases).join(', ')}`);
if (existsSync(join(need('LIVE_MCP_STATE'), 'KILL')) && phase !== 'info') throw new Error('KILL file present; remove it first');
try {
  await phases[phase!]!();
} catch (e) {
  out.error = (e as Error).message.slice(0, 500);
}
process.stdout.write(JSON.stringify({ phase, at: new Date().toISOString(), ...out }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
