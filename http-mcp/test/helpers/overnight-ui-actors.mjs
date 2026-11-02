// Test-only actors for the overnight UI tests (SIMULATED fixtures only).
//
// A "synthetic wallet" here is a fresh node:crypto Ed25519 key standing in
// for a Demos wallet EXTENSION: it signs portal messages and Demos-shaped
// transactions locally and posts them to the offline fixture chain through
// the same execute confirmTx/broadcastTx calls demosdk 4.0.16 uses. It is used
// where the built-in (embedded) wallet has no published capability, and is
// never presented as the embedded wallet. Keys live only in test memory.
import { createHash } from 'node:crypto';
import { CookieJar } from './oauth.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';

export { createEphemeralWallet };

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function dashboardClient(h) {
  const post = async (path, body, headers = { 'content-type': 'application/json', 'x-dacs-tester': '1' }) => {
    const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };
  return {
    post,
    state: async () => (await fetch(`${h.origin}/tester/api/state`)).json(),
    action: async (action, args) => (await post('/tester/api/action', { action, args })).body,
    evidence: async () => (await post('/tester/api/evidence', {})).body,
  };
}

export async function portalApi(h, path, body, jar = null) {
  const res = await fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar.header(`${h.origin}${path}`) } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  jar?.store(res);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

export const tokenFrom = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get('t');

// Completes the dashboard's OAuth sign-in for `role` with a synthetic wallet:
// authorization URL from the dashboard state -> portal wallet login -> the
// dashboard's own callback (which performs the token exchange).
export async function completeDashboardSignIn(h, authorizationUrl, wallet, callbackPath) {
  const jar = new CookieJar();
  const callbackPrefix = `${h.origin}${callbackPath}`;
  const follow = async (start) => {
    let current = new URL(start);
    for (let hop = 0; hop < 10; hop += 1) {
      if (current.href.startsWith(callbackPrefix)) return { callback: current };
      const res = await fetch(current, { redirect: 'manual', headers: { cookie: jar.header(current) } });
      jar.store(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      return { final: current, response: res };
    }
    throw new Error('too many redirects');
  };
  const start = await follow(authorizationUrl);
  if (start.callback) throw new Error('authorization returned without a portal login');
  await start.response.body?.cancel();
  const uid = /\/portal\/authorize\/([^/?#]+)/.exec(start.final.pathname)?.[1];
  if (!uid) throw new Error(`authorization did not reach the portal (${start.final.pathname})`);
  const challenge = await portalApi(h, `/portal/authorize/${uid}/api/challenge`, { address: wallet.address }, jar);
  if (challenge.status !== 200) throw new Error(`login challenge ${challenge.status} ${challenge.message ?? ''}`);
  const done = await portalApi(h, `/portal/authorize/${uid}/api/complete`, { challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) }, jar);
  if (done.status !== 200) throw new Error(`login complete ${done.status} ${done.message ?? ''}`);
  const end = await follow(new URL(done.redirectTo, h.origin).href);
  if (!end.callback) throw new Error(`login did not return to ${callbackPath}`);
  const cb = await fetch(end.callback, { redirect: 'manual' });
  await cb.body?.cancel();
  return cb.status;
}

// Signs a Demos-shaped transaction the way the fixture chain (and demosdk
// 4.0.16) hashes it: hash = sha256(JSON.stringify(content)), ed25519 over the
// UTF-8 hash string, by content.from.
export function signTransaction(wallet, payload) {
  const content = structuredClone(payload.content);
  const hash = sha256(JSON.stringify(content));
  return { content, hash, signature: { type: 'ed25519', data: wallet.signHex(hash) } };
}

async function rpc(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// confirmTx then broadcastTx, as the SDK's confirm()/broadcast() do. Returns
// { confirmed, broadcast, hash }.
export async function broadcastTransaction(chainUrl, tx) {
  const confirmed = await rpc(chainUrl, { method: 'execute', params: [{ extra: 'confirmTx', data: tx }] });
  if (confirmed?.response?.data?.valid !== true) return { confirmed, broadcast: null, hash: null };
  const broadcast = await rpc(chainUrl, { method: 'execute', params: [{ extra: 'broadcastTx', data: confirmed }] });
  return { confirmed, broadcast, hash: broadcast?.result === 200 ? broadcast.response.txHash : null };
}

// The full portal publication for a prepared seller listing, with the
// synthetic wallet: identity signature, listing signature, storage-program
// write through the fixture chain, report, directory registration.
// Stops early (and says where) when `until` is given.
export async function publishWithSyntheticWallet(h, { operationId, portalUrl }, wallet, { until = null } = {}) {
  const token = tokenFrom(portalUrl);
  const base = `/portal/api/publish/${operationId}`;
  const view = await portalApi(h, `${base}/view`, { token });
  if (view.signRequest?.step !== 'identity') throw new Error(`expected identity step, got ${view.status}`);
  const identity = await portalApi(h, `${base}/identity`, { token, address: wallet.address, signature: wallet.signHex(view.signRequest.message) });
  if (identity.status !== 'awaiting_listing_signature') throw new Error(`identity: ${identity.status} ${identity.message ?? ''}`);
  const listed = await portalApi(h, `${base}/listing`, { token, signature: wallet.signHex(identity.signRequest.message) });
  if (listed.status !== 'publication_handoff' || !listed.payload) throw new Error(`listing: ${listed.status} ${listed.message ?? ''}`);
  const out = { token, draft: identity.signRequest.draft, payload: listed.payload };
  if (until === 'handoff') return out;
  const sent = await broadcastTransaction(h.fixtures.chain, signTransaction(wallet, listed.payload));
  if (!sent.hash) throw new Error(`broadcast refused: ${JSON.stringify(sent.confirmed?.response?.data?.message ?? sent.broadcast?.response)}`);
  out.hash = sent.hash;
  out.report = await portalApi(h, `${base}/report`, { token, txHash: sent.hash });
  if (until === 'chain') return out;
  const req = await portalApi(h, `${base}/registration`, { token });
  out.registration = await portalApi(h, `${base}/register`, { token, signedAt: req.signedAt, signature: wallet.signHex(req.message) });
  return out;
}

// Buyer approval and payment with the synthetic wallet through the portal API.
export async function payWithSyntheticWallet(h, { operationId, approvalUrl }, wallet) {
  const token = tokenFrom(approvalUrl);
  const base = `/portal/api/purchase/${operationId}`;
  const challenge = await portalApi(h, `${base}/challenge`, { token, address: wallet.address });
  if (challenge.status !== 200) throw new Error(`purchase challenge ${challenge.status} ${challenge.message ?? ''}`);
  const approved = await portalApi(h, `${base}/approve`, { token, challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  if (!approved.payload) throw new Error(`approve: ${approved.status} ${approved.message ?? ''}`);
  const sent = await broadcastTransaction(h.fixtures.chain, signTransaction(wallet, approved.payload));
  if (!sent.hash) throw new Error('payment broadcast refused');
  const report = await portalApi(h, `${base}/report`, { token, txHash: sent.hash });
  return { approved, hash: sent.hash, report };
}
