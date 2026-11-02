// SIMULATED public-proof services for the offline tester (loopback only).
//
// - GET /users/<handle>: GitHub-API-shaped {login, id} answer, for the core
//   profile's DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN. The id is a stable hash
//   of the handle; no GitHub account exists or is contacted.
// - GET / and POST /publish: a plain page where the human "publishes" the
//   proof text their own wallet produced. It returns a gist.github.com or
//   x.com shaped URL that only this fixture resolves. Nothing is posted to
//   GitHub or X, and the URL is not fetched from the internet by anything.
// - POST /api/proofs: the same publication as JSON, for scripted tests.
//
// The fixture chain asks checkProof() whether a proof URL was published here
// for that handle and whether its demos:dw2p proof verifies (ed25519 over the
// UTF-8 string "dw2p", the bundled demosdk 4.0.16 legacy format) for the
// transaction sender. This is the legacy proof format; it is not bound to the
// handle, and the web2ProofBinding fork is not simulated.
import { createHash, randomBytes } from 'node:crypto';
import { createLoopbackServer, listenLoopback, closeServer, readBody, readJson, sendJson, sendText, BodyError } from './http.mjs';
import { verifyEd25519Hex } from './chain.mjs';

const HANDLE = /^[A-Za-z0-9_-]{1,39}$/;
const PROOF = /^demos:dw2p:ed25519:(0x)?([0-9a-f]{128})$/;
const MAX_PROOFS = 200;
const PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const userIdFor = (handle) => Number.parseInt(createHash('sha256').update(`offline-fixture:${handle.toLowerCase()}`).digest('hex').slice(0, 12), 16);

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SIMULATED proof publisher</title></head><body>
<h1>SIMULATED public proof publisher (offline fixture)</h1>
<p><strong>Not GitHub, not X, not Demos testnet.</strong> Nothing here is posted anywhere. The URL you get is resolved only by this local fixture.</p>
${body}
</body></html>`;
}

const FORM = `<form method="post" action="/publish">
<p><label>Kind <select name="kind"><option value="github">github (gist)</option><option value="twitter">twitter (x.com post)</option></select></label></p>
<p><label>Handle <input name="username" required pattern="[A-Za-z0-9_\\-]{1,39}" maxlength="39"></label></p>
<p><label>Proof text from your wallet <input name="proof" required size="80" maxlength="200"></label></p>
<p><button type="submit">Publish SIMULATED proof</button></p>
</form>`;

export async function startFixtureProofs() {
  const published = new Map(); // url -> { kind, username, proof }

  function publish({ kind, username, proof }) {
    if (!['github', 'twitter'].includes(kind)) throw new BodyError(400, 'kind must be github or twitter');
    if (!HANDLE.test(String(username ?? ''))) throw new BodyError(400, 'handle is not valid');
    if (!PROOF.test(String(proof ?? '').trim())) throw new BodyError(400, 'proof text must be the wallet\'s demos:dw2p:ed25519:… string');
    if (published.size >= MAX_PROOFS) throw new BodyError(429, 'fixture proof limit reached');
    const id = randomBytes(10).toString('hex');
    const url = kind === 'github'
      ? `https://gist.github.com/${username}/${id}`
      : `https://x.com/${username}/status/${BigInt(`0x${id}`).toString().slice(0, 19)}`;
    published.set(url, { kind, username, proof: String(proof).trim() });
    return url;
  }

  function checkProof({ context, proofUrl, username, address }) {
    const entry = published.get(String(proofUrl ?? ''));
    if (!entry) return { ok: false, reason: 'proof URL was not published on the offline proof fixture' };
    if (entry.kind !== context) return { ok: false, reason: 'proof URL kind does not match the identity context' };
    if (entry.username.toLowerCase() !== String(username).toLowerCase()) return { ok: false, reason: 'proof URL handle does not match the username' };
    const match = PROOF.exec(entry.proof);
    if (!match || !verifyEd25519Hex(address, 'dw2p', match[2])) return { ok: false, reason: 'proof signature does not verify for the sender' };
    return { ok: true, userId: String(userIdFor(entry.username)) };
  }

  function tweet(tweetUrl) {
    const entry = published.get(tweetUrl);
    if (!entry || entry.kind !== 'twitter') return { success: false, error: 'tweet not found on the offline proof fixture' };
    return { success: true, simulated: true, tweet: { url: tweetUrl, text: entry.proof, username: entry.username, userId: String(userIdFor(entry.username)) } };
  }

  const server = createLoopbackServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const user = /^\/users\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && user) {
      const handle = decodeURIComponent(user[1]);
      if (!HANDLE.test(handle)) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, { login: handle, id: userIdFor(handle), type: 'User', simulated: true });
    }
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, page(FORM), 'text/html; charset=utf-8', PAGE_HEADERS);
    if (req.method === 'POST' && url.pathname === '/publish') {
      const form = new URLSearchParams(await readBody(req, 4096));
      let proofUrl;
      try {
        proofUrl = publish({ kind: form.get('kind'), username: form.get('username'), proof: form.get('proof') });
      } catch (error) {
        if (!(error instanceof BodyError)) throw error;
        // The human form re-renders with the reason; /api/proofs keeps 4xx.
        return sendText(res, 200, page(`<p>Not published: ${escapeHtml(error.message)}</p>${FORM}`), 'text/html; charset=utf-8', PAGE_HEADERS);
      }
      return sendText(res, 200, page(`<p>SIMULATED proof URL (paste this into the portal):</p><p><code id="proof-url">${escapeHtml(proofUrl)}</code></p>${FORM}`), 'text/html; charset=utf-8', PAGE_HEADERS);
    }
    if (req.method === 'POST' && url.pathname === '/api/proofs') {
      const body = await readJson(req, 4096);
      return sendJson(res, 200, { proofUrl: publish(body ?? {}), simulated: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  });
  const port = await listenLoopback(server);

  return {
    url: `http://127.0.0.1:${port}`,
    publish,
    checkProof,
    tweet,
    get publishedCount() {
      return published.size;
    },
    close: () => closeServer(server),
  };
}
