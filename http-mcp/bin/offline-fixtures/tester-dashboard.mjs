// Guided tester dashboard for the offline launcher. SIMULATED ONLY: not Demos
// testnet, not funded, not ChatGPT, not security reviewed.
//
// Served only by the offline operator (bin/offline-fixtures/operator.mjs) on
// the plugin's own loopback origin under /tester/; the production binary never
// loads this module. It is an ordinary OAuth client of the plugin: it signs in
// through the normal authorization-code + PKCE portal and calls the normal MCP
// tools with the pinned official @modelcontextprotocol/client. Buyer sign-in
// uses its own OAuth client registration and token set:
//   - buyer  (redirect URI <origin>/tester/oauth/callback): purchases and
//     identity changes;
// The seller OAuth role and publication actions are retired in v2.
// It never touches the app's stores or services, never signs, approves or
// publishes anything, and never sees a wallet password, recovery phrase,
// backup or vault: those stay in the existing embedded-wallet and portal
// pages. OAuth tokens stay in this process; the browser only receives the
// public state below.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';
import { canonicalizeDecimal } from '@kynesyslabs/dacs';

const LISTING_TOOLS = new Set(['search_agents', 'get_listing']);
// Listing text arrives as seller-data envelopes ({label, text, truncated}); this
// page shows the decoded values, always with textContent.
export function listingValues(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(listingValues);
  if (typeof value.text === 'string' && value.text.startsWith('<DACS_SELLER_DATA_JSON>\n')) return JSON.parse(value.text.split('\n')[1]);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, listingValues(child)]));
}

// A tool error's message arrives as a seller-data envelope, whose label would
// fill the bounded error text. Show the code and decoded reason instead; a body
// that is not a complete error envelope is shown as it came.
export function toolErrorMessage(result) {
  const body = result.content?.[0]?.text ?? 'tool error';
  try {
    const { error, message } = JSON.parse(body);
    const reason = listingValues(message);
    if (typeof reason === 'string') return typeof error === 'string' ? `${error}: ${reason}` : reason;
  } catch { /* Not a JSON error body, or an incomplete envelope. */ }
  return body;
}

export const DASHBOARD_PATH = '/tester/';
export const CALLBACK_PATH = '/tester/oauth/callback';
export const SELLER_CALLBACK_PATH = '/tester/oauth/seller-callback';
export const DASHBOARD_SCOPE = 'dacs.account.read dacs.purchases.write dacs.identities.write';
export const DASHBOARD_NOTICE = 'SIMULATED ONLY: no real funds, not Demos testnet, not ChatGPT, not security reviewed.';
export const CHECKLIST_ITEMS = Object.freeze(['lock', 'unlock', 'backup', 'restore', 'decline']);
// Fixed, public parts of a seller-wizard listing. The seller types the title,
// price and (optionally) the description; everything else is fixed here.
export const SELLER_LISTING_DEFAULTS = Object.freeze({
  displayName: 'Offline tester seller (SIMULATED)',
  endpointBase: 'https://seller.invalid/offline-tester/',
  category: 'services.offline-tester',
  tags: Object.freeze(['offline', 'simulated', 'tester']),
  validDays: 7,
});
const HANDLE = /^[A-Za-z0-9_-]{1,39}$/;
const ADDRESS = /^0x[0-9a-f]{64}$/i;
const PRICE = /^\d{1,12}(\.\d{1,9})?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_BODY = 16 * 1024;
const MAX_FEEDBACK = 2000;
const MAX_ACTIVITY = 40;
const MAX_RESULTS = 10;
// Finished purchases kept (with their receipts) when the next one is prepared.
const MAX_COMPLETED = 10;
// Purchase statuses that leave nothing pending, so a new attempt (new key) is allowed.
const PURCHASE_FINISHED = new Set(['settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'superseded', 'cancelled']);
const PURCHASE_CANCELLABLE = new Set(['awaiting_approval', 'approved', 'payment_handoff']);
// Closed identity actions: nothing more can happen to them, so Add/Remove
// start a new action (src/identities.mjs; docs/IDENTITY-RECOVERY.md).
const IDENTITY_FINISHED = new Set(['association_observed', 'removal_observed', 'rejected_before_send', 'failed_before_send', 'cancelled', 'expired']);
// Publication statuses after which the seller wizard may start another listing.
const PUBLICATION_FINISHED = new Set(['directory_visible', 'publication_mismatch', 'cancelled']);
const PUBLICATION_CANCELLABLE = new Set(['awaiting_identity_signature', 'awaiting_listing_signature', 'listing_signed', 'publication_handoff']);
// Statuses where verify_agent_publication re-reads chain (and directory).
const PUBLICATION_VERIFIABLE = new Set(['publication_handoff', 'broadcast_reported', 'publication_uncertain', 'chain_verified', 'directory_submitted', 'directory_visible']);
const PUBLICATION_SIGNED = new Set(['listing_signed', 'publication_handoff', 'broadcast_reported', 'publication_uncertain', 'chain_verified', 'directory_submitted', 'directory_visible', 'publication_mismatch']);
const PUBLICATION_REPORTED = new Set(['broadcast_reported', 'publication_uncertain', 'chain_verified', 'directory_submitted', 'directory_visible', 'publication_mismatch']);

const UI_FILES = {
  '/tester/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/tester/dashboard.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
  '/tester/dashboard.js': { file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
};
const UI_DIR = new URL('./tester-ui/', import.meta.url);

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-dacs-simulation': 'tester-dashboard',
};

// Readable, bounded error text with portal capabilities and codes elided.
export function safeMessage(value) {
  return String(value?.message ?? value ?? 'unknown error')
    .split('\n')[0]
    .replace(/#t=[^\s"']+/g, '#t=…')
    .replace(/([?&](code|state|t|access_token|refresh_token)=)[^\s&"']+/gi, '$1…')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 …')
    .slice(0, 300);
}

const newKey = (prefix) => `tester-${prefix}-${randomBytes(9).toString('base64url')}`;
const claimFor = (address) => (ADDRESS.test(address ?? '') ? `did:demos:agent:${address.toLowerCase().slice(2)}` : null);

// In-memory OAuth client state for the official SDK auth() flow.
class DashboardOAuthProvider {
  constructor(redirectUrl, { scope = DASHBOARD_SCOPE, clientName = 'DACS offline tester dashboard (SIMULATED)' } = {}) {
    this._redirect = redirectUrl;
    this._scope = scope;
    this._name = clientName;
    this.authorizationUrl = null;
  }
  get redirectUrl() { return this._redirect; }
  get clientMetadata() {
    return { client_name: this._name, redirect_uris: [this._redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: this._scope };
  }
  clientInformation() { return this._client; }
  saveClientInformation(info) { this._client = info; }
  tokens() { return this._tokens; }
  saveTokens(tokens) { this._tokens = tokens; }
  redirectToAuthorization(url) { this.authorizationUrl = new URL(url); }
  saveCodeVerifier(v) { this._verifier = v; }
  codeVerifier() {
    if (!this._verifier) throw new Error('no sign-in is in progress');
    return this._verifier;
  }
  saveDiscoveryState(s) { this._discovery = s; }
  discoveryState() { return this._discovery; }
  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') this._tokens = undefined;
    if (scope === 'all' || scope === 'client') this._client = undefined;
    if (scope === 'all' || scope === 'verifier') this._verifier = undefined;
  }
}

// Web2 handles of one context (github | twitter) in a get_identities wallet
// entry, read from the bounded raw node answer the same way the package
// checker does. Never throws.
export function web2Handles(wallet, context) {
  try {
    const raw = wallet?.raw?.json ? JSON.parse(wallet.raw.json) : null;
    const list = raw?.response?.web2?.[context];
    return Array.isArray(list) ? list.map((e) => e?.username).filter((u) => typeof u === 'string' && HANDLE.test(u)) : [];
  } catch {
    return [];
  }
}
export const githubHandles = (wallet) => web2Handles(wallet, 'github');

// Ordinary input checks for the seller wizard form, with one plain-language
// message per field. The plugin's register_agent stays authoritative.
export function validateListingInput({ title, priceDem, description } = {}) {
  const errors = {};
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) errors.title = 'Enter a service title (3 to 120 characters).';
  else if (CONTROL.test(t)) errors.title = 'The title cannot contain line breaks or control characters.';
  else if (t.length < 3) errors.title = 'The title needs at least 3 characters.';
  else if (t.length > 120) errors.title = 'The title can be at most 120 characters.';
  const p = typeof priceDem === 'string' ? priceDem.trim() : '';
  if (!p) errors.priceDem = 'Enter a fixed price in DEM, for example 2.75.';
  else if (!PRICE.test(p)) errors.priceDem = 'Use digits with an optional dot and at most 9 decimals, for example 2.75 (no commas, spaces, units or signs).';
  else if (/^0*(\.0*)?$/.test(p)) errors.priceDem = 'The price must be greater than zero.';
  const d = typeof description === 'string' ? description.trim() : '';
  if (d.length > 500) errors.description = 'The description can be at most 500 characters.';
  else if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(d)) errors.description = 'The description cannot contain control characters.';
  return { ok: Object.keys(errors).length === 0, errors, value: { title: t, priceDem: p, description: d } };
}

// A fresh, valid register_agent listingId derived from the title.
export function listingIdFor(title) {
  const slug = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug.length >= 2 ? slug : 'listing'}-${randomBytes(4).toString('hex')}`;
}

// Publication progress as plain stages. Each stage is done only on the
// status the plugin reported or on the dashboard's own independent read.
export function publicationStages(listing) {
  const status = listing?.publicationStatus ?? null;
  const failed = status === 'publication_mismatch';
  const cancelled = status === 'cancelled';
  const stages = [
    { id: 'prepared', label: 'Listing prepared by the plugin (nothing published yet)', done: Boolean(listing?.operationId) },
    { id: 'signed', label: 'Identity and exact listing signed in the seller wallet (portal)', done: PUBLICATION_SIGNED.has(status) },
    { id: 'submitted', label: 'Storage write sent from the seller wallet and reported (submitted, not yet verified)', done: PUBLICATION_REPORTED.has(status) },
    { id: 'chain', label: 'Verified by independent fixture-chain readback (exact signed bytes, seller-owned)', done: listing?.onChainVerified === true && !failed },
    { id: 'directory', label: 'Registered with the fixture directory (owner-signed)', done: ['directory_submitted', 'directory_visible'].includes(status) },
    { id: 'discoverable', label: 'Discoverable: the directory serves the verified listing and a search finds it', done: status === 'directory_visible' && listing?.discoverable?.found === true },
  ];
  const current = stages.findIndex((s) => !s.done);
  return stages.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: s.done ? 'done' : i === current ? (failed ? 'failed' : cancelled ? 'cancelled' : 'current') : 'pending',
  }));
}

// Unfinished work a reload or reopened tab can resume. Public text only.
export function unfinishedSteps(state) {
  const out = [];
  if (state.signIn.status === 'redirected') out.push({ step: 'buyer-sign-in', status: 'redirected', next: 'Buyer sign-in was started but not finished. Press "Start sign-in again" to get a fresh portal link (the old one is not reused).' });
  if (state.seller.signIn.status === 'redirected') out.push({ step: 'seller-sign-in', status: 'redirected', next: 'Seller sign-in was started but not finished. Press "Start seller sign-in again" for a fresh portal link.' });
  const l = state.seller.listing;
  if (l?.operationId && !PUBLICATION_FINISHED.has(l.publicationStatus)) {
    out.push({ step: 'seller-publication', status: l.publicationStatus, next: PUBLICATION_CANCELLABLE.has(l.publicationStatus) ? 'Reopen the publication approval in the portal to continue, or cancel it. Pressing "Prepare listing" again with the same fields returns the same pending listing.' : 'Press "Refresh publication status" to re-check the fixture chain and directory. Nothing is re-sent.' });
  }
  const p = state.purchase;
  if (p?.operationId && !PURCHASE_FINISHED.has(p.status)) {
    out.push({ step: 'purchase', status: p.status, next: PURCHASE_CANCELLABLE.has(p.status) ? 'Reopen the review in the portal to approve, or cancel it. Pressing "Prepare simulated purchase" again returns this same pending purchase.' : 'Press "Refresh receipt": the plugin re-checks the fixture chain. Nothing is re-sent.' });
  }
  for (const [kind, slots] of [['github', state.identity], ['twitter', state.identity.twitter ?? {}]]) {
    for (const slot of ['add', 'remove']) {
      const op = slots[slot];
      if (op?.operationId && !IDENTITY_FINISHED.has(op.status)) out.push({ step: kind === 'github' ? `identity-${slot}` : `identity-twitter-${slot}`, status: op.status, next: `Reopen the ${kind === 'github' ? 'GitHub' : 'Twitter'} identity review in the portal, then press "Refresh identities".` });
    }
  }
  return out;
}

// The allowlisted feedback export: public step statuses, labels and the
// tester's own typed note. No addresses, URLs, keys, hashes, tokens or logs.
export function buildFeedbackExport(state, { feedback = '', app = {} } = {}) {
  const note = typeof feedback === 'string' ? feedback.slice(0, MAX_FEEDBACK) : '';
  return {
    kind: 'dacs-offline-tester-feedback',
    format: 1,
    createdAt: new Date().toISOString(),
    notice: DASHBOARD_NOTICE,
    app: { name: String(app.name ?? 'dacs-chatgpt-plugin'), version: String(app.version ?? 'unknown'), runtime: 'offline launcher tester dashboard', evidence: 'simulated-fixture' },
    observed: {
      signIn: state.signIn.status,
      listingDiscovery: state.listing.discovery ? (state.listing.discovery.found ? 'found' : 'not_found') : 'not_checked',
      listingVerification: state.listing.verification ? (state.listing.verification.transactable ? 'transactable' : 'not_transactable') : 'not_checked',
      purchase: state.purchase ? state.purchase.status : 'not_started',
      receipt: state.purchase?.receipt ? 'simulated_receipt_observed' : 'not_observed',
      identityAdd: state.identity.add ? state.identity.add.status : 'not_started',
      identityRemove: state.identity.remove ? state.identity.remove.status : 'not_started',
      identityReadback: state.identity.observed ? state.identity.observed.status : 'not_checked',
    },
    testerMarked: Object.fromEntries(CHECKLIST_ITEMS.map((k) => [k, state.checklist[k] === true])),
    feedback: note,
  };
}

// One purchase as the evidence file shows it (the current one and the
// finished ones kept from this sign-in): public terms and receipt only.
const purchaseEvidence = (p) => ({
  operationId: p.operationId, status: p.status, listingId: p.terms?.listingId ?? null, amount: p.terms?.amount ?? null, amountOs: p.terms?.amountOs ?? null, network: p.terms?.network ?? null, payee: p.terms?.payee ?? null,
  receipt: p.receipt ? { observed: true, chainMode: p.receipt.chainMode, txHash: p.receipt.txHash, payer: p.receipt.payer, payee: p.receipt.payee, amountOs: p.receipt.amountOs } : { observed: false },
});

// The evidence download: public workflow states as the dashboard observed
// them through the plugin's MCP tools. Public chain values (wallet addresses,
// transaction hashes, prices) are included; portal links (they carry a
// one-time capability), OAuth values, idempotency keys, passwords, recovery
// phrases, backups and keys are never part of the dashboard state at all, or
// are dropped here.
export function buildEvidenceExport(state, { app = {}, runId = null, fixture = null, chain = null, directory = null } = {}) {
  const l = state.seller.listing;
  const v = state.listing.verification;
  const p = state.purchase;
  return {
    kind: 'dacs-offline-tester-evidence',
    format: 1,
    createdAt: new Date().toISOString(),
    notice: DASHBOARD_NOTICE,
    simulation: { evidence: 'simulated-fixture', funded: false, demosTestnet: false, chatgpt: false, securityReviewed: false, settlement: false },
    app: { name: String(app.name ?? 'dacs-chatgpt-plugin'), version: String(app.version ?? 'unknown'), runtime: 'offline launcher tester dashboard' },
    run: { id: runId, note: 'Every launcher start is a fresh run; state from an earlier run is gone.' },
    baselineFixture: fixture ? { listingId: fixture.listingId, version: fixture.version, seller: fixture.seller, amount: fixture.amount, currency: fixture.currency } : null,
    seller: {
      signIn: state.seller.signIn.status,
      wallet: state.seller.signIn.wallets[0] ?? null,
      listing: l ? {
        listingId: l.listingId, title: l.title, priceDem: l.priceDem, agentId: l.agentId ?? null, operationId: l.operationId ?? null,
        publicationStatus: l.publicationStatus ?? null, storageAddress: l.storageAddress ?? null, onChainVerified: l.onChainVerified === true,
        chainMode: l.chainMode ?? null, directoryVisible: l.directoryVisible === true, discoverable: l.discoverable ?? null, checkedAt: l.checkedAt ?? null,
        stages: publicationStages(l).map(({ id, state: s }) => ({ id, state: s })),
      } : null,
    },
    buyer: {
      signIn: state.signIn.status,
      wallet: state.signIn.wallets[0] ?? null,
      search: state.listing.search ? { query: state.listing.search.query, count: state.listing.search.results.length, evidenceMode: state.listing.search.evidenceMode } : null,
      target: v ? { listingId: v.listingId, version: v.version, seller: v.seller, title: v.title, amount: v.amount, currency: v.currency, amountOs: v.amountOs, transactable: v.transactable, chainMode: v.chainMode, baseline: Boolean(fixture && v.listingId === fixture.listingId && v.seller === fixture.seller) } : null,
      purchase: p?.operationId ? purchaseEvidence(p) : null,
      // Finished purchases kept when a later one was prepared, oldest first.
      completedPurchases: (state.completedPurchases ?? []).map(purchaseEvidence),
    },
    identity: {
      add: state.identity.add ? { status: state.identity.add.status, username: state.identity.add.username ?? null } : null,
      remove: state.identity.remove ? { status: state.identity.remove.status, username: state.identity.remove.username ?? null } : null,
      twitterAdd: state.identity.twitter?.add ? { status: state.identity.twitter.add.status, username: state.identity.twitter.add.username ?? null } : null,
      twitterRemove: state.identity.twitter?.remove ? { status: state.identity.twitter.remove.status, username: state.identity.twitter.remove.username ?? null } : null,
      readback: state.identity.observed ? { status: state.identity.observed.status, mode: state.identity.observed.mode, githubHandles: state.identity.observed.githubHandles, twitterHandles: state.identity.observed.twitterHandles ?? [] } : null,
    },
    unfinished: unfinishedSteps(state),
    // Sessions left with "Start over", as last observed (not refreshed since).
    earlier: structuredClone(state.earlier ?? { buyer: [], seller: [] }),
    testerMarked: Object.fromEntries(CHECKLIST_ITEMS.map((k) => [k, state.checklist[k] === true])),
    fixtureCounts: { chain, directory },
    activity: state.activity.map((a) => ({ at: a.at, action: a.action, ok: a.ok, ...(a.error ? { error: a.error } : {}) })),
  };
}

export function createTesterDashboard({ origin, mcpUrl, embeddedWalletUrl, proofsUrl, listing, app = {}, stats = null }) {
  const ui = Object.fromEntries(Object.entries(UI_FILES).map(([path, { file, type }]) => [path, { type, body: readFileSync(new URL(file, UI_DIR)) }]));
  const callbackUrl = `${origin}${CALLBACK_PATH}`;
  const sellerCallbackUrl = `${origin}${SELLER_CALLBACK_PATH}`;
  const runId = randomBytes(6).toString('hex');
  const roles = {
    buyer: { redirect: callbackUrl, scope: DASHBOARD_SCOPE, clientName: 'DACS offline tester dashboard (SIMULATED)', label: 'buyer', returnTo: `${DASHBOARD_PATH}#sign-in` },
  };
  const providers = { buyer: new DashboardOAuthProvider(callbackUrl, roles.buyer) };
  const inFlight = new Map();
  const freshSignIn = () => ({ status: 'signed_out', wallets: [], authorizationUrl: null, error: null });

  const state = {
    signIn: freshSignIn(),
    listing: { discovery: null, verification: null, search: null, error: null },
    purchase: null,
    // Finished purchases of this sign-in, kept with their receipts when the
    // next purchase is prepared (no idempotency key, no portal link).
    completedPurchases: [],
    // add/remove: GitHub (the original dashboard slots); twitter.add/remove: Twitter.
    identity: { add: null, remove: null, twitter: { add: null, remove: null }, observed: null, error: null },
    checklist: Object.fromEntries(CHECKLIST_ITEMS.map((k) => [k, false])),
    seller: { signIn: freshSignIn(), listing: null, fieldErrors: {}, error: null },
    // Sessions a tester left with "Start over": the dashboard's last
    // observation of each, unchanged. The plugin keeps those operations on
    // the old account; only the old wallet can approve them.
    earlier: { buyer: [], seller: [] },
    activity: [],
  };
  const signInOf = (role) => (role === 'seller' ? state.seller.signIn : state.signIn);
  const setSignIn = (role, value) => {
    if (role === 'seller') state.seller.signIn = value;
    else state.signIn = value;
  };

  // role: 'buyer' | 'seller' | null (anonymous public discovery).
  async function tool(name, args = {}, { authenticated = true, role = 'buyer' } = {}) {
    const client = new Client({ name: 'dacs-offline-tester-dashboard', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), authenticated && role ? { authProvider: providers[role] } : {}));
    try {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${toolErrorMessage(result)}`);
      return LISTING_TOOLS.has(name) ? listingValues(result.structuredContent) : result.structuredContent;
    } finally {
      await client.close().catch(() => {});
    }
  }

  const signedIn = (role = 'buyer') => signInOf(role).status === 'signed_in' && signInOf(role).wallets.length > 0;
  const wallet = (role = 'buyer') => signInOf(role).wallets[0];
  function requireSignIn() {
    if (!signedIn('buyer')) throw new Error('Sign in first (step 2).');
  }
  function requireSeller() {
    if (!signedIn('seller')) throw new Error('Sign in as the seller first (seller step S1).');
  }
  // GitHub keeps the original identity.add/remove slots; Twitter has its own.
  function identitySlots(kind) {
    if (kind === 'github') return state.identity;
    if (kind === 'twitter') return state.identity.twitter;
    throw new Error('Choose GitHub or Twitter.');
  }

  async function refreshAccount(role = 'buyer') {
    const account = await tool('get_account_status', {}, { role });
    const s = signInOf(role);
    s.wallets = (account.wallets ?? []).map((w) => w.address).filter((a) => ADDRESS.test(a));
    s.status = s.wallets.length ? 'signed_in' : 'no_wallet';
  }

  async function startSignIn(role) {
    const s = signInOf(role);
    if (s.status === 'redirected' && s.authorizationUrl) return;
    providers[role] = new DashboardOAuthProvider(roles[role].redirect, roles[role]);
    setSignIn(role, freshSignIn());
    const outcome = await auth(providers[role], { serverUrl: mcpUrl, scope: roles[role].scope });
    if (outcome === 'REDIRECT' && providers[role].authorizationUrl) {
      signInOf(role).status = 'redirected';
      signInOf(role).authorizationUrl = providers[role].authorizationUrl.href;
    } else if (outcome === 'AUTHORIZED') {
      await refreshAccount(role);
    } else {
      throw new Error(`unexpected sign-in outcome ${outcome}`);
    }
  }

  function purchaseView(out, prev) {
    const s = out.settlement ?? null;
    const o = s?.observation ?? {};
    // Addresses in the same 0x-prefixed form as the rest of the dashboard.
    const addr = (v) => {
      const t = String(v ?? '');
      return /^[0-9a-fA-F]{64}$/.test(t) ? `0x${t}` : t;
    };
    const receipt = out.status === 'settled_verified' && s && s.chainMode === 'simulated-fixture'
      ? { chainMode: s.chainMode, txHash: String(s.txHash ?? ''), txNonce: s.txNonce ?? null, payer: addr(o.payer), payee: addr(o.payee), amountOs: String(o.amountOs ?? ''), observation: String(o.status ?? '') }
      : null;
    return {
      idempotencyKey: prev.idempotencyKey,
      operationId: out.operationId,
      status: out.status,
      next: out.next ?? null,
      approvalUrl: out.approvalUrl ?? prev.approvalUrl ?? null,
      // Only the prepare_purchase answer just received can say it was a replay,
      // and only a still-pending one is labelled "same pending purchase". A
      // replay that is already finished shows its plain status; its receipt
      // comes only from get_purchase_status (Refresh receipt).
      replayed: out.created === false && !PURCHASE_FINISHED.has(out.status),
      terms: out.terms ? { network: out.terms.network, amount: out.terms.amount, amountOs: out.terms.amountOs, payee: out.terms.payee, buyerWallet: out.terms.buyerWallet, seller: out.terms.seller, listingId: out.terms.listingId, version: out.terms.version } : prev.terms ?? null,
      receipt,
      error: null,
    };
  }

  // Moves a finished purchase into completedPurchases before the next one
  // replaces it. A settled purchase whose receipt was not read yet is read
  // once first; if that read fails it is kept without a receipt.
  async function keepFinished(p) {
    let kept = p;
    if (p.status === 'settled_verified' && !p.receipt) {
      try {
        kept = purchaseView(await tool('get_purchase_status', { operationId: p.operationId }), p);
      } catch {
        kept = p;
      }
    }
    state.completedPurchases.push({ operationId: kept.operationId, status: kept.status, terms: kept.terms ?? null, receipt: kept.receipt ?? null, keptAt: new Date().toISOString() });
    if (state.completedPurchases.length > MAX_COMPLETED) state.completedPurchases.splice(0, state.completedPurchases.length - MAX_COMPLETED);
  }

  function identityView(out, prev) {
    return { idempotencyKey: prev.idempotencyKey, operationId: out.operationId, action: out.action, username: out.username ?? prev.username ?? null, status: out.status, statusHelp: out.statusHelp ?? null, portalUrl: out.portalUrl ?? prev.portalUrl ?? null };
  }

  // One identity action per press. A remembered action is reused only while
  // it is open; when the dashboard's copy was stale and the remembered key
  // comes back closed, a new action with a new key is started right away.
  async function startIdentity(slots, slot, reuse, fresh, args) {
    const prev = reuse ? slots[slot] : fresh();
    const out = await tool('start_identity_action', { ...args, idempotencyKey: prev.idempotencyKey });
    slots[slot] = identityView(out, prev);
    if (reuse && out.operationId === prev.operationId && IDENTITY_FINISHED.has(out.status)) {
      const next = fresh();
      slots[slot] = identityView(await tool('start_identity_action', { ...args, idempotencyKey: next.idempotencyKey }), next);
    }
  }

  // Independent verification of one discovered listing (get_listing).
  async function verifyHit(hit, { evidenceMode, count }) {
    state.listing.discovery = { found: true, title: hit.title, sellerName: hit.sellerName ?? null, seller: hit.seller, listingId: hit.listingId, version: hit.version, priceHint: hit.priceHint ?? null, currency: hit.currency ?? null, verified: hit.verified, evidenceMode, count };
    const v = await tool('get_listing', { listingId: hit.listingId, version: hit.version, seller: hit.seller }, { authenticated: false });
    state.listing.verification = {
      transactable: v.transactable === true,
      eligibility: v.eligibility,
      disposition: v.disposition,
      title: v.title ?? null,
      listingId: v.listingId,
      version: v.version,
      seller: v.seller,
      amount: v.price?.amount ?? null,
      currency: v.price?.currency ?? null,
      amountOs: v.price?.amountOs ?? null,
      chainMode: v.evidence?.chainMode ?? null,
      failedChecks: (v.checks ?? []).filter((c) => !c.ok).map((c) => String(c.name)),
      passedChecks: (v.checks ?? []).filter((c) => c.ok).length,
    };
  }

  const actions = {
    async 'sign-in'() {
      return startSignIn('buyer');
    },
    async 'restart-sign-in'() {
      setSignIn('buyer', freshSignIn());
      return startSignIn('buyer');
    },
    async 'refresh-account'() {
      if (!providers.buyer.tokens()) throw new Error('Sign in first (step 2).');
      await refreshAccount('buyer');
    },
    // "Start over": leave this role's sign-in (for example after losing the
    // built-in wallet) and sign in again with another wallet in the same run.
    // Nothing on the plugin, chain or directory is changed or cancelled; the
    // dashboard keeps its last observation of the old session, labelled as
    // such, under "Earlier sign-ins".
    async 'buyer-start-over'() {
      if (state.signIn.status === 'signed_out' && !state.purchase && !state.identity.add && !state.identity.remove && !state.identity.twitter.add && !state.identity.twitter.remove) {
        throw new Error('There is no buyer sign-in to start over from.');
      }
      state.earlier.buyer.push({
        leftAt: new Date().toISOString(),
        wallet: state.signIn.wallets[0] ?? null,
        signIn: state.signIn.status,
        purchase: state.purchase?.operationId ? { operationId: state.purchase.operationId, status: state.purchase.status, listingId: state.purchase.terms?.listingId ?? null, amount: state.purchase.terms?.amount ?? null, receiptObserved: Boolean(state.purchase.receipt) } : null,
        completedPurchases: state.completedPurchases.map((p) => ({ operationId: p.operationId, status: p.status, listingId: p.terms?.listingId ?? null, amount: p.terms?.amount ?? null, receiptObserved: Boolean(p.receipt) })),
        identities: ['add', 'remove'].flatMap((slot) => [['github', state.identity[slot]], ['twitter', state.identity.twitter[slot]]].filter(([, op]) => op?.operationId).map(([kind, op]) => ({ kind, action: slot, status: op.status, username: op.username ?? null }))),
      });
      providers.buyer = new DashboardOAuthProvider(roles.buyer.redirect, roles.buyer);
      state.signIn = freshSignIn();
      state.purchase = null;
      state.completedPurchases = [];
      state.identity = { add: null, remove: null, twitter: { add: null, remove: null }, observed: null, error: null };
    },
    async 'find-listing'() {
      state.listing = { discovery: null, verification: null, search: state.listing.search, error: null };
      const found = await tool('search_agents', { query: 'offline fixture' }, { authenticated: false });
      const hit = (found.results ?? []).find((r) => r.listingId === listing.listingId && r.seller === listing.seller) ?? null;
      if (!hit) {
        state.listing.discovery = { found: false, evidenceMode: found.evidenceMode, count: (found.results ?? []).length };
        return;
      }
      await verifyHit(hit, { evidenceMode: found.evidenceMode, count: found.results.length });
    },
    async 'search-listings'({ query } = {}) {
      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) throw new Error('Type part of a service title to search for (for example the title the seller published).');
      if (q.length > 200 || CONTROL.test(q)) throw new Error('The search text must be one line of at most 200 characters.');
      const found = await tool('search_agents', { query: q, limit: 25 }, { authenticated: false });
      const results = (found.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
        listingId: r.listingId, version: r.version, seller: r.seller, sellerName: r.sellerName ?? null, title: r.title, priceHint: r.priceHint ?? null, currency: r.currency ?? null,
        baseline: r.listingId === listing.listingId && r.seller === listing.seller,
      }));
      state.listing.search = { query: q, results, evidenceMode: found.evidenceMode, total: (found.results ?? []).length };
    },
    async 'verify-listing'({ listingId, version, seller } = {}) {
      const hit = (state.listing.search?.results ?? []).find((r) => r.listingId === listingId && r.version === version && r.seller === seller);
      if (!hit) throw new Error('Search again and choose a listing from the current results.');
      state.listing.discovery = null;
      state.listing.verification = null;
      await verifyHit(hit, { evidenceMode: state.listing.search.evidenceMode, count: state.listing.search.results.length });
    },
    async 'prepare-purchase'() {
      requireSignIn();
      const v = state.listing.verification;
      if (!v?.transactable) throw new Error('Find and verify the test service first (step 3).');
      if (signedIn('seller') && wallet('seller')?.toLowerCase() === wallet('buyer')?.toLowerCase()) {
        throw new Error('The buyer wallet is the seller wallet. Sign in as the buyer with a second throwaway wallet (another browser profile or a private window).');
      }
      // A retained key makes an accidental repeat return the same operation.
      const pending = state.purchase && !PURCHASE_FINISHED.has(state.purchase.status) ? state.purchase : null;
      if (pending?.terms && (pending.terms.listingId !== v.listingId || pending.terms.seller !== v.seller || pending.terms.version !== v.version)) {
        throw new Error(`A simulated purchase of "${pending.terms.listingId}" is still ${pending.status}. Approve or cancel it before buying a different listing.`);
      }
      // A finished purchase (and its receipt) stays listed; the next one is new.
      if (!pending && state.purchase?.operationId) await keepFinished(state.purchase);
      const prev = pending ?? { idempotencyKey: newKey('buy') };
      state.purchase = { ...prev, error: null };
      const out = await tool('prepare_purchase', { listingId: v.listingId, version: v.version, seller: v.seller, idempotencyKey: prev.idempotencyKey, walletAddress: wallet() });
      state.purchase = purchaseView(out, prev);
    },
    async 'refresh-receipt'() {
      requireSignIn();
      if (!state.purchase?.operationId) throw new Error('Prepare a simulated purchase first.');
      const out = await tool('get_purchase_status', { operationId: state.purchase.operationId });
      state.purchase = purchaseView(out, state.purchase);
    },
    async 'cancel-purchase'() {
      requireSignIn();
      if (!state.purchase?.operationId || !PURCHASE_CANCELLABLE.has(state.purchase.status)) throw new Error('There is no pending purchase to cancel.');
      await tool('cancel_wallet_handoff', { operationId: state.purchase.operationId });
      const out = await tool('get_purchase_status', { operationId: state.purchase.operationId });
      state.purchase = purchaseView(out, state.purchase);
    },
    async 'identity-add'({ kind = 'github' } = {}) {
      requireSignIn();
      const slots = identitySlots(kind);
      const reuse = Boolean(slots.add?.operationId) && !IDENTITY_FINISHED.has(slots.add.status);
      await startIdentity(slots, 'add', reuse, () => ({ idempotencyKey: newKey(kind === 'github' ? 'add' : 'add-tw') }), { action: 'add', kind, walletAddress: wallet() });
    },
    async 'identity-remove'({ username, kind = 'github' } = {}) {
      requireSignIn();
      const slots = identitySlots(kind);
      const name = kind === 'github' ? 'GitHub' : 'Twitter';
      const observed = state.identity.observed?.[kind === 'github' ? 'githubHandles' : 'twitterHandles'] ?? [];
      if (typeof username !== 'string' || !HANDLE.test(username) || !observed.includes(username)) throw new Error(`Choose a ${name} handle observed in the last identity readback (refresh identities first).`);
      const reuse = Boolean(slots.remove?.operationId) && !IDENTITY_FINISHED.has(slots.remove.status) && slots.remove.username === username;
      await startIdentity(slots, 'remove', reuse, () => ({ idempotencyKey: newKey(kind === 'github' ? 'rm' : 'rm-tw'), username }), { action: 'remove', kind, username, walletAddress: wallet() });
    },
    async 'refresh-identities'() {
      requireSignIn();
      const out = await tool('get_identities', { walletAddress: wallet() });
      const w = (out.wallets ?? []).find((x) => x.address === wallet()) ?? null;
      state.identity.observed = w
        ? { status: w.status, mode: w.evidence?.mode ?? null, observedAt: w.evidence?.observedAt ?? null, web2Count: w.counts?.web2 ?? null, githubHandles: w.status === 'observed' ? githubHandles(w) : [], twitterHandles: w.status === 'observed' ? web2Handles(w, 'twitter') : [] }
        : { status: 'unavailable', mode: null, observedAt: null, web2Count: null, githubHandles: [], twitterHandles: [] };
      for (const slots of [state.identity, state.identity.twitter]) {
        for (const slot of ['add', 'remove']) {
          const mine = slots[slot];
          const op = mine && (out.operations ?? []).find((o) => o.operationId === mine.operationId);
          if (op) slots[slot] = { ...mine, status: op.status, statusHelp: op.statusHelp ?? null, username: op.username ?? mine.username };
        }
      }
    },
    async checklist({ item, done } = {}) {
      if (!CHECKLIST_ITEMS.includes(item) || typeof done !== 'boolean') throw new Error('unknown checklist item');
      state.checklist[item] = done;
    },
  };

  // Where an action's error is shown.
  const SECTION = {
    'sign-in': () => state.signIn, 'restart-sign-in': () => state.signIn, 'refresh-account': () => state.signIn,
    'buyer-start-over': () => state.signIn,
    'find-listing': () => state.listing, 'search-listings': () => state.listing, 'verify-listing': () => state.listing,
    'refresh-identities': () => state.identity, 'identity-add': () => state.identity, 'identity-remove': () => state.identity,
  };

  function record(name, ok, error) {
    if (name === 'checklist') return;
    state.activity.push({ at: new Date().toISOString(), action: name, ok, ...(error ? { error } : {}) });
    if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  }

  const counts = () => (stats ? { chain: stats.chain?.() ?? null, directory: stats.directory?.() ?? null } : { chain: null, directory: null });

  function publicState() {
    return {
      notice: DASHBOARD_NOTICE,
      evidence: 'simulated-fixture',
      runId,
      links: { wallet: embeddedWalletUrl, proofPublisher: `${proofsUrl}/`, health: `${origin}/health` },
      fixture: { label: listing.label, listingId: listing.listingId, version: listing.version, seller: listing.seller, sellerAddress: listing.sellerAddress, amount: listing.price.amount, currency: listing.price.currency },
      ...structuredClone(state),
      unfinished: unfinishedSteps(state),
      busy: [...inFlight.keys()],
    };
  }

  async function run(name, args) {
    if (!Object.hasOwn(actions, name)) throw Object.assign(new Error('unknown action'), { status: 400 });
    // One run per action at a time: a double click joins the pending run.
    if (!inFlight.has(name)) {
      const p = (async () => {
        try {
          await actions[name](args);
          const section = SECTION[name]?.();
          if (section) section.error = null;
          if (name === 'seller-register') state.seller.fieldErrors = {};
          record(name, true);
          return { ok: true };
        } catch (error) {
          const message = safeMessage(error);
          const section = SECTION[name]?.();
          if (section) section.error = message;
          else if (state.purchase && /purchase|receipt/.test(name)) state.purchase.error = message;
          record(name, false, message);
          return { ok: false, error: message, ...(error.fields ? { fields: error.fields } : {}) };
        } finally {
          inFlight.delete(name);
        }
      })();
      inFlight.set(name, p);
    }
    return inFlight.get(name);
  }

  async function oauthCallback(role, url) {
    const provider = providers[role];
    const error = url.searchParams.get('error');
    if (error) {
      provider.invalidateCredentials('verifier');
      setSignIn(role, { status: error === 'access_denied' ? 'declined' : 'error', wallets: [], authorizationUrl: null, error: error === 'access_denied' ? 'Sign-in was declined or cancelled in the portal. Nothing was linked.' : `Sign-in failed (${safeMessage(error).slice(0, 60)}).` });
      record(`${role === 'seller' ? 'seller-' : ''}sign-in-callback`, false, error === 'access_denied' ? 'declined' : 'error');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || signInOf(role).status !== 'redirected') {
      signInOf(role).error = 'This sign-in link is not the one the dashboard started. Start sign-in again.';
      return;
    }
    try {
      const outcome = await auth(provider, { serverUrl: mcpUrl, authorizationCode: code, iss: url.searchParams.get('iss') ?? undefined, scope: roles[role].scope });
      if (outcome !== 'AUTHORIZED') throw new Error(`token exchange outcome ${outcome}`);
      signInOf(role).authorizationUrl = null;
      await refreshAccount(role);
      signInOf(role).error = null;
      record(`${role === 'seller' ? 'seller-' : ''}sign-in-callback`, true);
    } catch (err) {
      setSignIn(role, { status: 'error', wallets: [], authorizationUrl: null, error: `Sign-in did not complete: ${safeMessage(err)}` });
      record(`${role === 'seller' ? 'seller-' : ''}sign-in-callback`, false, 'did not complete');
    }
  }

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('request too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  // Same-origin JSON requests from the dashboard page only.
  function sameOriginPost(req) {
    const o = req.headers.origin;
    return req.method === 'POST'
      && String(req.headers['content-type'] ?? '').startsWith('application/json')
      && req.headers['x-dacs-tester'] === '1'
      && (o === undefined || o === origin);
  }

  function handles(req) {
    const path = new URL(req.url, origin).pathname;
    return path === '/tester' || path.startsWith('/tester/');
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    try {
      if (url.pathname === '/tester') return send(res, 308, 'text/plain; charset=utf-8', 'see /tester/', { location: DASHBOARD_PATH });
      if (req.method === 'GET' && Object.hasOwn(ui, url.pathname)) return send(res, 200, ui[url.pathname].type, ui[url.pathname].body);
      if (req.method === 'GET' && url.pathname === '/tester/api/state') return json(res, 200, publicState());
      if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
        const role = 'buyer';
        await oauthCallback(role, url);
        return send(res, 303, 'text/plain; charset=utf-8', 'see /tester/', { location: roles[role].returnTo });
      }
      if (url.pathname === '/tester/api/action') {
        if (!sameOriginPost(req)) return json(res, 403, { ok: false, error: 'dashboard requests must come from the dashboard page' });
        const body = await readJson(req);
        const result = await run(String(body.action ?? ''), body.args ?? {});
        return json(res, 200, { ...result, state: publicState() });
      }
      if (url.pathname === '/tester/api/export') {
        if (!sameOriginPost(req)) return json(res, 403, { ok: false, error: 'dashboard requests must come from the dashboard page' });
        const body = await readJson(req);
        return json(res, 200, { ok: true, export: buildFeedbackExport(state, { feedback: body.feedback, app }) });
      }
      if (url.pathname === '/tester/api/evidence') {
        if (!sameOriginPost(req)) return json(res, 403, { ok: false, error: 'dashboard requests must come from the dashboard page' });
        await readJson(req);
        const c = counts();
        return json(res, 200, { ok: true, evidence: buildEvidenceExport(state, { app, runId, fixture: publicState().fixture, chain: c.chain, directory: c.directory }) });
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (error) {
      return json(res, error.status ?? 500, { ok: false, error: error.status ? error.message : 'dashboard request failed' });
    }
  }

  return {
    url: `${origin}${DASHBOARD_PATH}`,
    callbackUrl,
    sellerCallbackUrl,
    runId,
    handles,
    handle,
    publicState,
    async close() {
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
