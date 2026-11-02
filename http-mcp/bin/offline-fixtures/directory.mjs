// SIMULATED Community DACS Directory for the offline tester (loopback only,
// x-dacs-simulation: fixture). Serves the public read endpoints the plugin
// uses, and indexes seller registrations from the fixture chain.
//
// POST /api/dacs/register (the body the plugin's portal sends): the fixture
// checks the owner signature over the Community registration message, then
// reads every listed anchor from the fixture chain's public storage-program
// read. An anchor is indexed only when it exists, is owned by the claim's
// wallet, and holds a listing presented and signed by that same claim; the
// summary uses the same shape as the shipped baseline listing (seller.mjs
// directorySummary), with the content hash of the exact stored bytes. The
// directory is still only a discovery hint: the plugin's get_listing verifies
// chain bytes, signatures and validity on its own. Nothing is sent anywhere.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { createLoopbackServer, listenLoopback, closeServer, readJson, sendJson } from './http.mjs';
import { verifyEd25519Hex } from './chain.mjs';
import { directorySummary } from './seller.mjs';

const CLAIM = /^did:demos:agent:([0-9a-f]{64})$/;
const LOCATOR = /^stor-[0-9a-f]{40}$/;
const SIG_HEX = /^(0x)?[0-9a-f]{128}$/i;
const MAX_REGISTRATIONS = 100;
const MAX_ENTRIES = 200;
const MAX_ANCHORS = 8;
const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

// Community dacs-directory@074f040 src/catalog/registrationSig.ts registrationMessage().
export function registrationMessage({ primaryClaim, displayName, listingAnchors, deals = [] }, signedAt) {
  return [
    'dacs-directory registration',
    `claim:${primaryClaim}`,
    `name:${displayName}`,
    `anchors:${sha256Hex(JSON.stringify([...listingAnchors].sort()))}`,
    `deals:${sha256Hex(canonicalize(deals))}`,
    `at:${signedAt}`,
  ].join('\n');
}

export async function startFixtureDirectory({ chain = null, now = () => Date.now() } = {}) {
  const entries = new Map(); // seller\0id\0version -> { summary, detail }
  const registrations = [];
  const counters = { indexed: 0, refused: 0 };
  const key = (seller, id, version) => `${seller}\0${id}\0${version}`;

  function add(summary, listing) {
    entries.set(key(summary.seller.primaryClaim, summary.listingId, summary.version), { summary, detail: structuredClone(listing) });
  }

  // Returns { status, body } for one registration request.
  function register(body) {
    const refuse = (status, error) => {
      counters.refused += 1;
      return { status, body: { ok: false, error, simulated: true } };
    };
    const claim = CLAIM.exec(String(body?.primaryClaim ?? ''));
    if (!claim) return refuse(400, 'primaryClaim must be did:demos:agent:<64 lowercase hex>');
    const address = `0x${claim[1]}`;
    if (typeof body.displayName !== 'string' || body.displayName.length < 1 || body.displayName.length > 200) return refuse(400, 'displayName is required');
    const anchors = body.listingAnchors;
    if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > MAX_ANCHORS || !anchors.every((a) => LOCATOR.test(String(a)))) {
      return refuse(400, `listingAnchors must be 1-${MAX_ANCHORS} stor- locators`);
    }
    const sig = body.ownerSignature;
    if (!Number.isSafeInteger(sig?.signedAt) || Math.abs(now() - sig.signedAt) > SIGNATURE_WINDOW_MS) return refuse(400, 'ownerSignature.signedAt is outside the 10 minute window');
    const message = registrationMessage({ primaryClaim: body.primaryClaim, displayName: body.displayName, listingAnchors: anchors }, sig.signedAt);
    if (sig.message !== message) return refuse(400, 'ownerSignature.message is not the registration message for this body');
    // Hex, or the 86-character base64url form a wallet may return.
    const sigHex = typeof sig.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(sig.signature) ? Buffer.from(sig.signature, 'base64url').toString('hex') : sig.signature;
    if (typeof sigHex !== 'string' || !SIG_HEX.test(sigHex) || !verifyEd25519Hex(address, message, sigHex)) {
      return refuse(401, 'ownerSignature does not verify for the claim');
    }
    if (!chain) return refuse(503, 'no fixture chain is configured');
    const indexed = [];
    const skipped = [];
    for (const locator of anchors) {
      const stored = chain.readStorage(locator);
      const listing = stored?.data;
      const why = !stored ? 'not found on the fixture chain'
        : stored.owner !== address ? 'not owned by the claim wallet'
          : listing?.seller?.identity?.presentedBy !== body.primaryClaim || listing?.signature?.signer !== body.primaryClaim ? 'listing is not presented and signed by the claim'
            : typeof listing.listingId !== 'string' || !Number.isSafeInteger(listing.listingVersion) || typeof listing?.pricing?.price?.amount !== 'string' ? 'stored data is not a listing'
              : entries.size >= MAX_ENTRIES && !entries.has(key(body.primaryClaim, listing.listingId, listing.listingVersion)) ? 'fixture directory is full'
                : null;
      if (why) {
        skipped.push({ locator, reason: why });
        continue;
      }
      add(directorySummary(listing, locator, new Date(now()).toISOString()), listing);
      indexed.push({ locator, listingId: listing.listingId, version: listing.listingVersion });
    }
    counters.indexed += indexed.length;
    if (registrations.length < MAX_REGISTRATIONS) registrations.push({ primaryClaim: body.primaryClaim, anchors: [...anchors], indexed: indexed.length, at: new Date(now()).toISOString() });
    // Nothing indexable is a refusal, so the plugin keeps the publication at
    // chain_verified (retryable) instead of recording a submission.
    if (indexed.length === 0) {
      counters.refused += 1;
      return { status: 422, body: { ok: false, error: `no anchor could be indexed: ${skipped.map((s) => s.reason).join('; ')}`, skipped, simulated: true } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        ownerVerified: true,
        queued: false,
        indexed,
        skipped,
        simulated: true,
        note: 'offline fixture: indexed in memory from the fixture chain (SIMULATED, not the Community directory)',
      },
    };
  }

  const server = createLoopbackServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'GET' && url.pathname === '/api/dacs/listings') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase().slice(0, 200);
      const seller = url.searchParams.get('primaryClaim');
      const category = url.searchParams.get('category');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 50);
      const cursor = Math.max(Number(url.searchParams.get('cursor')) || 0, 0);
      const all = [...entries.values()].map((e) => e.summary).filter((s) =>
        (!seller || s.seller.primaryClaim === seller) && (!category || s.offering.category === category) &&
        (!q || `${s.offering.title} ${s.offering.description}`.toLowerCase().includes(q)));
      const page = all.slice(cursor, cursor + limit);
      return sendJson(res, 200, { listings: page, cursor: cursor + limit < all.length ? String(cursor + limit) : undefined, total: all.length });
    }
    const detail = /^\/api\/dacs\/listings\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const entry = entries.get(key(url.searchParams.get('seller'), decodeURIComponent(detail[1]), Number(detail[2])));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, entry.detail);
    }
    if (req.method === 'POST' && url.pathname === '/api/dacs/register') {
      const { status, body } = register(await readJson(req, 64 * 1024));
      return sendJson(res, status, body);
    }
    return sendJson(res, 404, { error: 'not found' });
  });
  const port = await listenLoopback(server);

  return {
    url: `http://127.0.0.1:${port}`,
    add,
    get listingCount() {
      return entries.size;
    },
    get registrationCount() {
      return registrations.length;
    },
    // Public counts only.
    stats: () => ({ listings: entries.size, registrations: registrations.length, indexed: counters.indexed, refused: counters.refused }),
    close: () => closeServer(server),
  };
}
