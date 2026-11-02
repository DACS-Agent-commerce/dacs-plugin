// Overnight ordinary functional acceptance: a Node consumer of the guided
// dashboard's PUBLIC HTTP interface (/tester/api/*), the normal portal pages'
// HTTP API and the fixture chain's public RPC. SIMULATED fixtures only;
// source-aware; NOT a security review, NOT live/testnet/ChatGPT.
//
// The "wallet" here is a fresh synthetic ed25519 key standing in for a wallet
// extension (labelled): it signs portal messages and SDK-shaped transactions
// (hash = sha256(JSON.stringify(content)), ed25519 over the UTF-8 hash) and
// submits them with execute confirmTx -> broadcastTx, as a wallet would. It is
// not evidence that the built-in (embedded) wallet can do the same.
import { createHash } from 'node:crypto';
import { CookieJar } from './oauth.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function act(h, action, args = {}) {
  const res = await fetch(`${h.origin}/tester/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dacs-tester': '1' }, body: JSON.stringify({ action, args }) });
  return { http: res.status, ...(await res.json()) };
}

export async function dashState(h) {
  return (await fetch(`${h.origin}/tester/api/state`)).json();
}

export async function evidence(h) {
  const res = await fetch(`${h.origin}/tester/api/evidence`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dacs-tester': '1' }, body: '{}' });
  const text = await res.text();
  return { http: res.status, text, json: JSON.parse(text) };
}

async function portalPost(h, path, body, jar) {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar.header(`${h.origin}${path}`) } : {}) }, body: JSON.stringify(body ?? {}) });
  jar?.store(res);
  const data = await res.json();
  return { http: res.status, ...data };
}
export const portalApi = (h, path, body) => portalPost(h, path, body);

// Follows redirects like a browser tab (cookie jar, manual redirects) and stops
// once a response is not a redirect. Returns the final URL.
async function follow(url, jar, stopWhen = () => false) {
  let current = new URL(url);
  for (let hop = 0; hop < 12; hop += 1) {
    if (stopWhen(current)) return current;
    const res = await fetch(current, { redirect: 'manual', headers: { cookie: jar.header(current) } });
    jar.store(res);
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return current;
  }
  throw new Error('too many redirects');
}

// Dashboard sign-in ("Sign in" or "Sign in as seller") completed in the normal
// portal with the synthetic wallet key; ends on the dashboard again.
export async function signIn(h, role, wallet) {
  const out = await act(h, role === 'seller' ? 'seller-sign-in' : 'sign-in');
  if (!out.ok) throw new Error(`${role} sign-in did not start: ${out.error}`);
  const s = role === 'seller' ? out.state.seller.signIn : out.state.signIn;
  const jar = new CookieJar();
  const atPortal = await follow(s.authorizationUrl, jar, (u) => /\/portal\/authorize\//.test(u.pathname));
  const uid = /\/portal\/authorize\/([^/?#]+)/.exec(atPortal.pathname)?.[1];
  if (!uid) throw new Error(`authorization did not reach the portal (${atPortal.pathname})`);
  const view = await portalPost(h, `/portal/authorize/${uid}/api/view`, {}, jar);
  const challenge = await portalPost(h, `/portal/authorize/${uid}/api/challenge`, { address: wallet.address }, jar);
  const done = await portalPost(h, `/portal/authorize/${uid}/api/complete`, { challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) }, jar);
  const end = await follow(done.redirectTo, jar, (u) => u.pathname === '/tester/');
  if (end.pathname !== '/tester/') throw new Error(`sign-in ended at ${end.pathname}`);
  return { clientName: view.clientName, state: await dashState(h) };
}

// Synthetic wallet-extension stand-in: sign and submit one transaction to the
// fixture chain (confirmTx, then broadcastTx with the confirm answer).
export function signTx(wallet, payload) {
  const content = structuredClone(payload.content);
  const hash = sha256(JSON.stringify(content));
  return { content, hash, signature: { type: 'ed25519', data: wallet.signBytes(Buffer.from(hash, 'utf8')).toString('hex') } };
}

export async function rpc(chainUrl, body) {
  const res = await fetch(chainUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

export async function submitTx(chainUrl, tx) {
  const confirmed = await rpc(chainUrl, { method: 'execute', params: [{ extra: 'confirmTx', data: tx }] });
  const valid = confirmed?.response?.data?.valid === true;
  if (!valid) return { confirmed: false, reason: confirmed?.response?.data?.message ?? null };
  const broadcast = await rpc(chainUrl, { method: 'execute', params: [{ extra: 'broadcastTx', data: confirmed }] });
  return { confirmed: true, broadcast: broadcast?.result === 200, reason: broadcast?.response?.message ?? null, txHash: broadcast?.response?.txHash ?? null };
}

// Independent readback through the chain's public RPC/HTTP (not the plugin).
export async function txByHash(chainUrl, hash) {
  const r = await rpc(chainUrl, { method: 'nodeCall', params: [{ message: 'getTxByHash', data: { hash } }] });
  return r?.response ?? null;
}
export async function readStoragePublic(chainUrl, locator) {
  const res = await fetch(`${chainUrl}/storage-program/${locator}`);
  return { http: res.status, body: await res.json() };
}

export const portalPath = (url) => {
  const u = new URL(url);
  return { path: u.pathname, token: new URLSearchParams(u.hash.slice(1)).get('t'), id: u.pathname.split('/').pop() };
};

// Seller publication through the documented portal publish page API, with the
// stand-in key. `after` is called between steps so a test can check what the
// dashboard shows at each point. Returns the coordinates.
export async function publishFromPortal(h, wallet, portalUrl, after = async () => {}) {
  const { id, token } = portalPath(portalUrl);
  const base = `/portal/api/publish/${id}`;
  const view = await portalApi(h, `${base}/view`, { token });
  const identity = await portalApi(h, `${base}/identity`, { token, address: wallet.address, signature: wallet.signHex(view.signRequest.message) });
  const listed = await portalApi(h, `${base}/listing`, { token, signature: wallet.signHex(identity.signRequest.message) });
  if (listed.status !== 'publication_handoff') throw new Error(`listing signature step: ${listed.status ?? listed.error}`);
  await after('signed', listed);
  const sent = await submitTx(h.fixtures.chain, signTx(wallet, listed.payload));
  if (!sent.broadcast) throw new Error(`storage write not accepted: ${sent.reason}`);
  await after('broadcast', sent);
  const report = await portalApi(h, `${base}/report`, { token, txHash: sent.txHash });
  await after('reported', report);
  const req = await portalApi(h, `${base}/registration`, { token });
  const registered = await portalApi(h, `${base}/register`, { token, signedAt: req.signedAt, signature: wallet.signHex(req.message) });
  await after('registered', registered);
  return { storageAddress: listed.payload.content.data[1].storageAddress, txHash: sent.txHash, report, registered };
}

// Buyer approval and payment through the documented purchase portal API.
export async function payFromPortal(h, wallet, approvalUrl, { rejectTransfer = false } = {}) {
  const { id, token } = portalPath(approvalUrl);
  const base = `/portal/api/purchase/${id}`;
  const challenge = await portalApi(h, `${base}/challenge`, { token, address: wallet.address });
  const approved = await portalApi(h, `${base}/approve`, { token, challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  if (approved.status !== 'payment_handoff') throw new Error(`approve: ${approved.status ?? approved.error}`);
  if (rejectTransfer) return { approved, report: await portalApi(h, `${base}/report`, { token, walletError: 'User rejected the request' }) };
  const sent = await submitTx(h.fixtures.chain, signTx(wallet, approved.payload));
  if (!sent.broadcast) throw new Error(`transfer not accepted: ${sent.reason}`);
  const report = await portalApi(h, `${base}/report`, { token, txHash: sent.txHash });
  return { approved, sent, report };
}

export const stageStates = (listing) => Object.fromEntries((listing?.stages ?? []).map((s) => [s.id, s.state]));
