// Trusted signing portal client. Provider discovery and request shapes follow
// the Community DACS Directory wallet contract (useDemosWallet.ts @074f040):
// window.__demosProviderCaptured / window.demos / "demosAnnounceProvider"
// (CustomEvent detail.provider) with "demosRequestProvider" retries, and
// provider.request({method, params}) for connect, sign and sendTransaction.
// Purchase payments are never handed to an installed extension: this page
// cannot verify which network an extension would send on (needPaymentNetwork).
// The experimental embedded wallet (embedded-wallet-bridge.mjs) is an explicit
// opt-in alternative with the same provider envelope; it is loaded only on
// request and supports connect and sign. Payments, identity add/remove and
// seller listing publication are available in it only when the server reports
// the simulated-loopback profile (a local fixture chain). The explicit testnet
// profile is held: the page says so and the wallet refuses every write.
// All rendering uses textContent; server data is never parsed as HTML.

import { renderShowcaseProgress } from './showcase-progress.mjs';
import { sellerNamePanel } from './seller-name.mjs';
import { sellerIdentityPanel } from './seller-identity.mjs';
import { checkSellerSessionDelegation, describeSellerSessionDelegation } from './seller-session-delegation.mjs';
import { renderPurchasedReport } from './purchased-report.mjs';

const showcaseReportView = document.body.dataset.showcaseReportView === '1';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
  return node;
};
const log = (message, cls = '') => $('log').append(el('p', { class: cls }, `${new Date().toLocaleTimeString()} ${message}`));

// SIMULATED offline profile: the server's embedded-wallet profile reports a
// local fixture chain (simulated-loopback). Page headings, the title and the
// primary approval labels then say SIMULATED and never present the page as
// Demos testnet. Every other profile keeps the existing wording.
let simulatedProfile = false;
const sim = (text) => (simulatedProfile ? `${text} (SIMULATED fixture, not Demos testnet)` : text);
const simLabel = (text) => (simulatedProfile ? `${text} (SIMULATED fixture)` : text);
const flow = (...nodes) => $('flow').replaceChildren(...nodes);
const details = (pairs) => el('dl', {}, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

// ---------------- wallet provider ----------------
let provider = null;
let address = null;
// 'extension' (default: provider discovery) or 'embedded' (the person chose
// the experimental embedded wallet). Discovery never overrides that choice.
let walletSource = 'extension';
let embedded = null; // UI handle {ready, lock, getPublicState, destroy}
let embeddedWritesConfigured = false; // server profile is simulated-loopback
let embeddedTestnetHeld = false; // server profile is the held testnet profile
let offlineAgreementBroker = null; // explicit loopback public-envelope client
const WRITE_METHODS = ['sendTransaction', 'addGithubIdentity', 'addTwitterIdentity', 'removeWeb2Identity'];

function discoverProvider() {
  return new Promise((resolve) => {
    const found = window.__demosProviderCaptured || window.demos;
    if (found?.request) return resolve(found);
    let attempts = 0;
    const onAnnounce = (event) => {
      const p = event?.detail?.provider;
      if (p?.request) {
        window.removeEventListener('demosAnnounceProvider', onAnnounce);
        clearInterval(timer);
        resolve(p);
      }
    };
    window.addEventListener('demosAnnounceProvider', onAnnounce);
    const timer = setInterval(() => {
      attempts += 1;
      window.dispatchEvent(new Event('demosRequestProvider'));
      if (attempts >= 10) {
        clearInterval(timer);
        window.removeEventListener('demosAnnounceProvider', onAnnounce);
        resolve(null);
      }
    }, 300);
    window.dispatchEvent(new Event('demosRequestProvider'));
  });
}

// The wallet's structured code (e.g. payment_cancelled) goes with its error.
function envelopeError(res) {
  if (res && typeof res === 'object' && res.success === false) {
    throw Object.assign(new Error(res.error?.message || 'wallet rejected the request'),{code:res.error?.code});
  }
}

async function connect() {
  const res = await provider.request({ method: 'connect' });
  envelopeError(res);
  let value = typeof res?.data === 'string' ? res.data : res?.data?.address ?? res?.address;
  if (typeof value !== 'string') throw new Error('wallet did not return an address');
  if (!value.startsWith('0x')) value = `0x${value}`;
  address = value.toLowerCase();
  walletState('connected', walletSource === 'embedded' ? `Connected: ${address} (experimental embedded wallet)` : `Connected: ${address}`);
  return address;
}

// Wallet presence as the portal can actually observe it: searching, unavailable
// (no provider answered), awaiting_wallet (provider found, not connected) or
// connected. It never reports which network the wallet uses.
function walletState(state, text) {
  const status = $('wallet-status');
  status.dataset.state = state;
  status.textContent = text;
  $('wallet-setup').hidden = state !== 'unavailable';
}

// On the extension path, account creation and import happen only inside the
// user's own wallet; the portal just explains that and looks for the provider
// again afterwards.
let connectBound = false;
function enableConnect() {
  const button = $('connect');
  button.disabled = false;
  if (!connectBound) {
    button.addEventListener('click', run(connect));
    connectBound = true;
  }
}

async function findWallet() {
  if (walletSource !== 'extension') return false;
  walletState('searching', 'Looking for a Demos wallet extension…');
  const found = await discoverProvider();
  // The person chose the embedded wallet while discovery was running: keep it.
  if (walletSource !== 'extension') return false;
  provider = found;
  if (!provider) {
    walletState('unavailable', 'No Demos wallet extension found. Set it up as shown below, then check again.');
    return false;
  }
  walletState('awaiting_wallet', 'Wallet found. Connect to continue.');
  enableConnect();
  return true;
}

// ---------------- experimental embedded wallet (explicit opt-in) ----------------
// Loaded only after a deliberate click. The portal sees the UI's public state
// and its local provider object; the recovery phrase and password stay inside
// the wallet UI. window.demos and an installed extension are left untouched.
function forgetConnection() {
  provider = null;
  address = null;
  $('connect').disabled = true;
}

function onEmbeddedState(state) {
  if (walletSource !== 'embedded' || !state?.locked) return;
  // Locked (or not yet unlocked): no provider, no connected address.
  forgetConnection();
  walletState('embedded_locked', 'Experimental embedded wallet selected. Create, import or unlock it below, then connect.');
}

function onEmbeddedProvider(embeddedProvider) {
  if (walletSource !== 'embedded') return;
  provider = embeddedProvider;
  address = null;
  walletState('awaiting_wallet', 'Experimental embedded wallet unlocked. Connect to continue.');
  enableConnect();
}

// The server's embedded-wallet write profile. Only the explicit simulated
// loopback profile, with a same-origin relay URL, becomes a writing transport;
// the default ("off") leaves payments, publication and identity changes
// unavailable. The held testnet profile becomes a transport that carries only
// its network label, so the wallet itself answers held_for_review.
// Each optional publication block in a source binding, with its exact fields.
const SOURCE_PUBLICATIONS={settlementPublication:['policy','artifactKind','phase','railId','phaseIndex','authority'],
  deliveryPublication:['policy','artifactKind','phase','phaseIndex','authority'],demoArtifactPublication:['policy','artifactKinds','authority']};
function sameSourceBinding(a,b){
  const base=['source','bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority'];
  const extensions=Object.keys(SOURCE_PUBLICATIONS).filter(k=>a?.[k]!==undefined||b?.[k]!==undefined),keys=[...base,...extensions];
  const sameValue=(x,y)=>Array.isArray(x)?Array.isArray(y)&&x.length===y.length&&x.every((v,i)=>v===y[i]):x===y;
  const samePublication=(x,y,fields)=>Boolean(x&&y&&Object.keys(x).length===fields.length&&Object.keys(y).length===fields.length&&fields.every(k=>Object.hasOwn(x,k)&&Object.hasOwn(y,k)&&sameValue(x[k],y[k])));
  return Boolean(a&&b&&Object.keys(a).length===keys.length&&Object.keys(b).length===keys.length&&base.every(k=>Object.hasOwn(a,k)&&Object.hasOwn(b,k)&&a[k]===b[k])
    &&extensions.every(k=>samePublication(a[k],b[k],SOURCE_PUBLICATIONS[k])));
}
async function embeddedTransport() {
  const match = /^\/portal\/purchase\/([^/]+)$/.exec(location.pathname);
  const token = match && (fragment.get('t') || sessionStorage.getItem(`dacs:${match[1]}`));
  if(match && token){
    const view=await api(`/portal/api/purchase/${match[1]}/view`,{token});
    const binding=view.terms?.protocol?.transportBinding;
    if(binding?.source==='devnet-agreement-transport/v1'){
      const profile=await api('/portal/api/devnet-native-wallet-profile');
      if(profile.profile!=='devnet-agreement'||!sameSourceBinding(binding,profile.transportBinding)||view.terms.domain?.mode!=='public-chain-read'||view.terms.domain.chainIdentity!==binding.chainIdentity||view.terms.domain.network!==binding.network)throw new Error('The separately supplied source transport does not match these signed purchase terms. Nothing is sent.');
      const {createOfflineAgreementBrokerClient}=await import('/portal/assets/offline-agreement-broker.mjs');
      offlineAgreementBroker=createOfflineAgreementBrokerClient({id:match[1],token,api});
      const {createDevnetAgreementWalletTransport}=await import('/portal/assets/embedded-wallet/sdk-provider.mjs');
      return createDevnetAgreementWalletTransport(profile);
    }
  }
  let profile;
  try {
    profile = await api('/portal/api/embedded-wallet/profile');
  } catch {
    return undefined;
  }
  if (profile?.testnet?.profile === 'held' && typeof profile.testnet.network === 'string' && profile.testnet.network) {
    return { profile: 'testnet-held', network: profile.testnet.network };
  }
  if (profile?.writes !== 'simulated-loopback' || typeof profile.rpcUrl !== 'string') return undefined;
  let rpc;
  try {
    rpc = new URL(profile.rpcUrl);
  } catch {
    return undefined;
  }
  if (rpc.origin !== location.origin) return undefined;
  if (profile.agreementBroker?.enabled === true && profile.agreementBroker.kind === 'loopback-test-only') {
    const match = /^\/portal\/purchase\/([^/]+)$/.exec(location.pathname);
    const token = match && (fragment.get('t') || sessionStorage.getItem(`dacs:${match[1]}`));
    if (match && token) {
      const { createOfflineAgreementBrokerClient } = await import('/portal/assets/offline-agreement-broker.mjs');
      offlineAgreementBroker = createOfflineAgreementBrokerClient({ id: match[1], token, api });
    }
  }
  return {
    profile: 'simulated-loopback',
    rpcUrl: rpc.href,
    network: String(profile.network ?? 'simulated'),
    resolveGithubUser: profile.githubLookup ? (username) => api('/portal/api/wallet-rpc/github-user', { username }) : undefined,
  };
}

// Read once at boot, before any flow renders.
async function detectSimulatedProfile() {
  let profile;
  try {
    profile = await api('/portal/api/embedded-wallet/profile');
  } catch {
    return;
  }
  simulatedProfile = profile?.writes === 'simulated-loopback' && profile?.evidenceMode === 'simulated-fixture';
  if (!simulatedProfile) return;
  const title = 'DACS wallet portal — SIMULATED offline fixture';
  document.title = title;
  $('portal-title').textContent = title;
  $('network-scope').textContent = 'SIMULATED offline fixture — not Demos testnet, no real funds, not ChatGPT.';
  $('wallet-network-note').textContent = 'This server uses a local SIMULATED fixture chain, not Demos testnet. A wallet extension’s network does not apply here; use the experimental embedded wallet below.';
}

async function useEmbeddedWallet() {
  if (walletSource === 'embedded') return;
  walletSource = 'embedded';
  forgetConnection();
  $('embedded-choice').hidden = true;
  $('embedded-panel').hidden = false;
  walletState('embedded_loading', 'Loading the experimental embedded wallet…');
  if (!document.querySelector('link[data-embedded-wallet]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/portal/assets/embedded-wallet/embedded-wallet.css', 'data-embedded-wallet': 'true' }));
  }
  try {
    const transactionTransport = await embeddedTransport();
    embeddedWritesConfigured = transactionTransport?.profile === 'simulated-loopback';
    embeddedTestnetHeld = transactionTransport?.profile === 'testnet-held';
    const { openEmbeddedWallet } = await import('/portal/assets/embedded-wallet-bridge.mjs');
    if (walletSource !== 'embedded') return;
    embedded = await openEmbeddedWallet($('embedded-wallet'), { onPublicState: onEmbeddedState, onProviderReady: onEmbeddedProvider, transactionTransport, anchorJournal: offlineAgreementBroker?.anchorJournal });
    await embedded.ready;
  } catch (error) {
    walletState('embedded_unavailable', 'The experimental embedded wallet could not be loaded on this page.');
    throw error;
  }
}

async function useExtensionWallet() {
  if (walletSource !== 'embedded') return;
  embedded?.destroy();
  embedded = null;
  embeddedWritesConfigured = false;
  embeddedTestnetHeld = false;
  walletSource = 'extension';
  forgetConnection();
  $('embedded-panel').hidden = true;
  $('embedded-choice').hidden = false;
  await findWallet();
}

const EMBEDDED_NO_WRITES = 'The experimental embedded wallet cannot send payments, publish listings or change identities.';
const EMBEDDED_HELD = 'Testnet writes from the experimental embedded wallet are held. The external security review is on hold. Nothing was signed or sent.';
// What else this page offers: the extension may publish or change identities,
// but its purchase payments are held (needPaymentNetwork).
const otherWallet = (writes) => (writes === 'payment'
  ? 'Payments from an installed wallet extension are held as well, so no wallet on this page can pay.'
  : 'Use the Demos wallet extension for this page.');
const EXTENSION_PAYMENT_HELD = 'Payments from an installed wallet extension are held: this page cannot verify which Demos network the extension would send on. Nothing was signed or sent.';

// A payment leaves only a wallet whose network this page can match to the
// purchase's bound network. An installed extension reports none, so it is
// held. The embedded wallet's session network is the server's simulated
// loopback relay, accepted only for a purchase bound to that same simulated
// network. Called before the approval signature and again before sending.
function needPaymentNetwork(terms) {
  if (walletSource !== 'embedded' || provider?.isDacsEmbeddedWallet !== true) throw new Error(EXTENSION_PAYMENT_HELD);
  const session = provider.writeProfile?.() ?? null;
  const bound = terms?.domain ?? null;
  if(terms?.protocol?.transportBinding?.source==='devnet-agreement-transport/v1'){
    if(bound?.mode==='public-chain-read'&&session?.profile==='devnet-agreement'&&session.evidenceMode==='explicit-pinned-transport-single-node'&&session.network===bound.network&&bound.chainIdentity===terms.protocol.transportBinding.chainIdentity&&sameSourceBinding(session.transportBinding,terms.protocol.transportBinding))return;
    throw new Error('This wallet source capability does not match the exact pin and domain in these approved terms. Nothing was signed or sent.');
  }
  if (bound?.mode !== 'simulated-fixture' || session?.profile !== 'simulated-loopback' || session.evidenceMode !== 'simulated-fixture' || session.network !== bound.network) {
    throw new Error(`This wallet session's network (${session?.network ?? 'unknown'}) is not the network this purchase is bound to (${bound?.network ?? 'unbound'}). Nothing was signed or sent.`);
  }
}

// The reviewed Demos wallet 0.5.7 source (pin cafb747) reads sign params[0] as
// the plain message string, so that is exactly what is sent. Source
// compatibility only: not confirmed against an installed wallet.
async function walletSign(message) {
  if (typeof message !== 'string') throw new Error('sign message must be a string');
  const res = await provider.request({ method: 'sign', params: [message] });
  if (typeof res === 'string') return res;
  envelopeError(res);
  const sig = res?.data?.signature ?? res?.data?.data ?? (typeof res?.data === 'string' ? res.data : null) ?? res?.signature;
  if (typeof sig !== 'string') throw new Error('wallet did not return a signature');
  return sig;
}

// Only values under hash-named keys count; a bare 64-hex string elsewhere
// (for example an address in data) is never taken as a transaction hash.
function findHash(value, depth = 0) {
  // A bare string response, or {data: "<hash>"}, is accepted as a pointer too;
  // the server verifies it against the chain and rejects anything else.
  if (depth <= 1 && typeof value === 'string') return /^(0x)?[0-9a-fA-F]{64}$/.test(value) ? value : null;
  if (depth > 4 || value == null || typeof value !== 'object') return null;
  for (const key of ['hash', 'txHash', 'transactionHash']) {
    if (typeof value[key] === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(value[key])) return value[key];
  }
  for (const key of ['data', 'response', 'result']) {
    const hit = findHash(value[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

const UNKNOWN_OUTCOME = {
  payment: (hash) => `Payment outcome unknown: the wallet may have sent transaction ${hash}. It was not retried. Check the purchase status in ChatGPT before doing anything else.`,
};

async function walletSend(tx, { kind = 'payment' } = {}) {
  const res = await provider.request({ method: 'sendTransaction', params: [tx] });
  // The embedded wallet's broadcast may have reached the node: never retried.
  // The hash is shown so the person can give it to verify_deal or re-check.
  if (res?.success === false && res.error?.code === 'outcome_unknown') {
    const hash = typeof res.data?.hash === 'string' ? res.data.hash : 'unknown';
    throw Object.assign(new Error(UNKNOWN_OUTCOME[kind](hash)), { txHash: hash === 'unknown' ? null : hash });
  }
  envelopeError(res);
  return findHash(res);
}

// ---------------- server API ----------------
async function api(path, body) {
  const reportRead = showcaseReportView && /^\/portal\/api\/purchase\/[^/]+\/(view|report|protocol\/recheck|auto\/recheck)$/.test(path);
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error([data.message || `request failed (${response.status})`, data.buyerFunding?.message].filter(Boolean).join(' ')), { code: data.error });
    // Every purchase status read carries evidence; an unreadable body (read as {} above) is a failed read.
    if (reportRead && !data.evidence) throw new Error('the response carried no purchase status');
    if (reportRead && $('purchased-report')) renderPurchasedReport($('purchased-report'), data.evidence?.protocol);
    return data;
  } catch (error) {
    if (reportRead && $('purchased-report')) renderPurchasedReport($('purchased-report'), null, `Fresh purchase status read failed: ${error.message}`);
    throw error;
  }
}

// Re-check DACS steps in short polls. The server answers within about a
// second with the settled result or the current pending view; each pending
// view goes to onPending as it arrives. Polling stops at the deadline (about
// the old 70 s long-poll bound, inside a tunnel's 100 s response limit) and
// returns the latest view marked deadlineReached. Polls only read: the
// server runs one workflow per purchase, and nothing is resent.
async function recheckPurchase(id, token, { onPending = null, deadlineMs = 90000, now = () => Date.now() } = {}) {
  const deadline = now() + deadlineMs;
  for (;;) {
    const view = await api(`/portal/api/purchase/${id}/protocol/recheck`, { token });
    if (!view.poll?.pending) return view;
    if (now() >= deadline) return { ...view, poll: { ...view.poll, deadlineReached: true } };
    onPending?.(view);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - now()))));
  }
}

const fragment = new URLSearchParams(location.hash.slice(1));
// Remove the handoff token from the address bar and history.
if (location.hash) history.replaceState(null, '', location.pathname);
const path = location.pathname.split('/').filter(Boolean); // ['portal', kind, id]

// Embedded payments and identity changes require the server's explicit
// simulated-loopback transport. Unconfigured and held profiles keep their
// existing refusals; consent alone never grants a write capability.
function needWallet({ writes = false } = {}) {
  if (writes && walletSource === 'embedded') {
    // Locked: no session yet, so the server profile decides; unlocked: the
    // session's own write profile must agree.
    const profile = provider ? provider.writeProfile?.() : null;
    if (profile?.held || (!provider && embeddedTestnetHeld)) throw new Error(`${EMBEDDED_HELD} ${otherWallet(writes)}`);
    const methods = provider ? profile?.methods : embeddedWritesConfigured ? WRITE_METHODS : null;
    const allowed = (writes === 'payment' && methods?.includes('sendTransaction'))
      || (writes === 'identity' && methods?.includes('removeWeb2Identity'));
    if (!allowed) throw new Error(`${EMBEDDED_NO_WRITES} ${otherWallet(writes)}`);
  }
  if (!address) throw new Error('connect your wallet first');
}

const run = (fn) => async () => {
  try {
    await fn();
  } catch (error) {
    log(error.message, 'bad');
  }
};

// Action buttons lock every portal action while a request or wallet prompt is
// in flight (no double signature prompts) and unlock after ordinary failures.
// Secondary actions (cancel) never reach the wallet; they are marked apart
// from the step actions but share the same lock.
let busy = false;
const LOCKABLE = 'button[data-action], button[data-secondary-action]';
function action(label, fn, { cls = 'primary', step, secondary = false, id } = {}) {
  const button = el('button', { class: cls, type: 'button', [secondary ? 'data-secondary-action' : 'data-action']: 'true', ...(step ? { 'data-publish-step': step } : {}), ...(id ? { id } : {}) }, label);
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const all = [...document.querySelectorAll(LOCKABLE)];
    for (const b of all) b.disabled = true;
    try {
      await fn();
    } catch (error) {
      log(error.message, 'bad');
    } finally {
      busy = false;
      // Re-enable only buttons still on the page; a re-render replaces them.
      for (const b of document.querySelectorAll(LOCKABLE)) b.disabled = false;
    }
  });
  return button;
}

// Evidence labels come only from what the server recorded; a configured
// network name alone never implies live evidence.
const MODE_TEXT = {
  'simulated-fixture': 'SIMULATED fixture (not live Demos testnet)',
  'public-chain-read': 'public Demos chain read',
  'public-directory-read': 'public directory read',
};
const modeText = (mode) => (mode ? MODE_TEXT[mode] ?? mode : 'no chain evidence recorded yet');
function simulatedBanner(simulated) {
  return simulated
    ? el('p', { class: 'warn', role: 'status' }, 'SIMULATED: this evidence comes from local fixture services, not the live Demos testnet. No real funds or chain writes are involved.')
    : null;
}
const compact = (...nodes) => nodes.filter(Boolean);
const fmtTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString() : '(not set)');

// ---------------- flows ----------------
async function authorizeFlow(uid) {
  const view = await api(`/portal/authorize/${uid}/api/view`);
  const go = action(simLabel('Sign in and allow'), async () => {
    needWallet();
    const challenge = await api(`/portal/authorize/${uid}/api/challenge`, { address });
    log('Sign the login challenge in your wallet.');
    const signature = await walletSign(challenge.message);
    const done = await api(`/portal/authorize/${uid}/api/complete`, { challengeId: challenge.challengeId, signature });
    log('Signed in. Returning to ChatGPT…', 'ok');
    location.assign(done.redirectTo);
  });
  flow(
    el('h2', {}, sim('Link your DACS account')),
    details([['Requesting app', view.clientName], ...(view.clientNote ? [['Warning', view.clientNote]] : []), ['Returns to', view.redirectOrigin], ['Resource', view.resource]]),
    el('p', {}, 'Requested permissions:'),
    el('ul', {}, ...view.scopes.map((s) => el('li', {}, `${s.description} (${s.scope})`))),
    el('p', { class: 'muted' }, 'Signing proves you control this wallet. It does not move funds.'),
    go,
  );
}

async function linkFlow() {
  // The fragment is stripped from the address bar on first load, so keep the
  // link for this tab to render its true state after a reload.
  let body = null;
  if (fragment.get('n')) {
    body = { accountId: fragment.get('a'), expires: Number(fragment.get('e')), nonce: fragment.get('n'), token: fragment.get('t') };
    sessionStorage.setItem('dacs:link', JSON.stringify(body));
  } else {
    try {
      body = JSON.parse(sessionStorage.getItem('dacs:link') ?? 'null');
    } catch {
      body = null;
    }
  }
  const ended = (title, text) => flow(el('h2', {}, sim(title)), el('p', {}, text));
  if (!body) return ended('Wallet link unavailable', 'This page was opened without a complete link. Ask ChatGPT for a new wallet link (start_wallet_link).');
  const state = await api('/portal/api/link/view', body);
  if (state.state === 'used') return ended('Wallet link already used', 'This one-time link has already linked a wallet. Ask ChatGPT for a new link to add another wallet.');
  if (state.state === 'expired') return ended('Wallet link expired', `This link expired at ${new Date(state.expiresAt).toLocaleString()}. Ask ChatGPT for a new link.`);
  if (state.state !== 'valid') return ended('Wallet link invalid', 'This link is not valid. Ask ChatGPT for a new wallet link.');
  flow(
    el('h2', {}, sim('Link a wallet to your account')),
    details([['Account', state.accountId], ['Wallets on this account', state.accountWallets], ['Link expires', new Date(state.expiresAt).toLocaleString()]]),
    el('p', { class: 'muted' }, 'Only continue if you started this from your own ChatGPT conversation. This link works once.'),
    action(simLabel('Sign and link'), async () => {
      needWallet();
      const challenge = await api('/portal/api/link/challenge', { ...body, address });
      const signature = await walletSign(challenge.message);
      const done = await api('/portal/api/link/complete', { ...body, challengeId: challenge.challengeId, signature });
      log(done.alreadyLinked ? 'This wallet was already linked.' : `Linked ${done.address}.`, 'ok');
      ended('Wallet linked', 'This one-time link is now used. You can return to ChatGPT.');
    }),
  );
}

// DACS protocol purchase (offline fixture builds): what each layer means is
// stated separately; none of them is shown as "done" for another.
const LAYER_TEXT = {
  transfer: { 'observed-by-one-rpc-tuple-only': 'Observed by one RPC node (tuple-only; finality not established)', 'not-observed': 'Not observed' },
  dacsPurchase: { 'payment-evidence-verified': 'Evidenced: seller-signed DACS-4 payment evidence verified at its canonical address for your transaction, block and amount', 'not-evidenced': 'Not evidenced yet' },
  service: { 'test-report-delivered-and-verified': 'Delivered: the test report verifies on chain', 'not-delivered': 'Not delivered yet' },
  completedCopies: { 'both-copies-verified': 'Both completed DACS-5 copies verified (yours and the seller\'s)', 'not-exchanged': 'Not exchanged yet' },
  humanAcceptance: { 'not-recorded': 'Not recorded: your counter-signature records protocol completion, not satisfaction with the service' },
};
// The seller's delivery evidence is a separate, later write: the report can
// verify while its evidence is still pending, did not verify, or is not
// published by this profile. Shown apart so "Delivered" never implies it.
const EVIDENCE_TEXT = {
  'native-read-back': 'Verified: the seller\'s delivery evidence read back on chain',
  'pending-readback': 'Not read back yet; checking the purchase again re-reads it',
  'held-evidence-rejected': 'Did not verify against the delivered report',
  'deferred-to-explicit-sdk-finaliser': 'Not published in this purchase profile',
};
function deliveryEvidenceText(delivery) {
  const text = EVIDENCE_TEXT[delivery?.evidencePublication] ?? 'Unknown';
  return delivery?.evidenceHold?.reason ? `${text} (${delivery.evidenceHold.reason})` : text;
}
// Complete-profile stage ledger: achieved (simulated) and held stages apart.
const DEVNET_STAGE_TEXT = { 'achieved-simulated': 'Achieved (SIMULATED loopback fixture only)', pending: 'Not reached yet', stopped: 'Stopped' };
function devnetNodes(d) {
  const t = d.target ?? {};
  return el('div', { id: 'dacs-devnet' },
    el('p', { class: 'warn', role: 'note' }, `Target ${t.label} (${t.rpcOrigin}): live execution held. Its observed chain identity is not a trusted pin. This purchase ran on the ${d.execution} fixture.`),
    details(d.stages.map((s) => [s.stage, s.status === 'held' ? `Held: ${s.reason}` : DEVNET_STAGE_TEXT[s.status] ?? s.status])));
}
function protocolNodes(p, showNext = true, sourceBinding = null) {
  if (!p) return [];
  const rows = [
    ['DACS job', p.jobId],
    ['DACS step', p.stage],
    ['Seller agent', `${p.sellerAgent} (seller acts as phase orchestrator)`],
    ['Anchors', sourceBinding ? 'Native Agreement CREATE on explicit source pin; seller commitment on SIMULATED fixture substrate (mixed, not strict finality)' : `${p.substrate} — SIMULATED fixture substrate, not Demos storage`],
  ];
  if (p.agreement) rows.push(['Agreement', `${p.agreement.hash} (signed by you and the seller)`], ['Committed payee', p.agreement.payee], ['Committed amount', `${p.agreement.price.amount} DEM (${p.agreement.price.amountOs} OS)`]);
  if (p.deliveryDeadline) rows.push(['Delivery deadline', p.deliveryDeadline.deadlineIso], ['Deadline elapsed', `${Math.floor(p.deliveryDeadline.pastDueMs / 1000)} seconds`]);
  if (p.commitment) rows.push(['Seller commitment', `${p.commitment.contentHash} by ${p.commitment.signer}, read back independently`]);
  const layers = [
    ['Transfer', LAYER_TEXT.transfer[p.layers.transfer]],
    ['DACS purchase', LAYER_TEXT.dacsPurchase[p.layers.dacsPurchase]],
    ['Service', LAYER_TEXT.service[p.layers.service]],
    ...(p.delivery ? [['Delivery evidence', deliveryEvidenceText(p.delivery)]] : []),
    ['Completed bundle', LAYER_TEXT.completedCopies[p.layers.completedCopies]],
    ['Human acceptance', LAYER_TEXT.humanAcceptance[p.layers.humanAcceptance]],
  ];
  return [
    el('h3', {}, 'DACS purchase'),
    details(rows),
    p.deliveryDeadline?.message ? el('p', { id: 'delivery-deadline-observation', class: 'warn', role: 'note' }, p.deliveryDeadline.message) : null,
    p.deliveryDeadline?.laterDelivery ? el('p', { id: 'delivery-deadline-later-delivery', role: 'note' }, p.deliveryDeadline.deliveryMessage) : null,
    el('div', { id: 'dacs-layers' }, details(layers)),
    el('p', { id: 'dacs-limits', class: 'warn', role: 'note' }, sourceBinding ? 'Explicit source-pinned native Agreement and DEM transport; mixed SIMULATED seller commitment. Single-node inclusion is not consensus finality. Vet, claims, delivery and completion remain held. Source capability is not supplied live authority or independent review.' : 'Offline fixture only: anchors are a SIMULATED substrate, DACS-2 vetting is not performed, and finality is not independently established.'),
    p.devnet ? devnetNodes(p.devnet) : null,
    p.lastAttempt && p.lastAttempt.outcome !== 'verified' && p.lastAttempt.outcome !== 'anchored' && p.lastAttempt.outcome !== 'accepted' && p.lastAttempt.outcome !== 'ready'
      ? el('p', { class: 'muted' }, `Last DACS step: ${p.lastAttempt.step} ${p.lastAttempt.outcome}${p.lastAttempt.reason ? ` (${p.lastAttempt.reason})` : ''}`)
      : null,
    showNext && p.next ? el('p', {}, p.next) : null,
  ].filter(Boolean);
}

async function purchaseFlow(id) {
  const token = fragment.get('t') || sessionStorage.getItem(`dacs:${id}`);
  if (token) sessionStorage.setItem(`dacs:${id}`, token);
  // Only the wallet bound to this purchase signs any of its DACS messages.
  const needBoundWallet = (t) => {
    if (address !== t.buyer.wallet) throw new Error('connect the wallet bound to this purchase');
  };
  // The plan step can outlive its request (seller approvals can hold it past a
  // tunnel's response limit; the server then answers 202 plan_in_progress),
  // and the server runs one per purchase. Every attempt, after an error or a
  // reload alike, reads the purchase status before anything is signed, and
  // continues from a plan saved meanwhile: the server returns a saved plan as
  // it is, without a signature.
  async function savedPlan() {
    const view = await api(`/portal/api/purchase/${id}/view`, { token });
    const p = view.evidence?.protocol;
    if (view.status === 'agreement_pending' && p?.stage === 'agreement-signing' && !p.notSaved) {
      log('The Agreement plan is saved; continuing from it. Nothing before the Agreement is signed again.');
      return api(`/portal/api/purchase/${id}/agreement/plan`, { token });
    }
    if (view.status !== 'agreement_pending') {
      render(view);
      return false;
    }
    return null;
  }
  async function planAgreement(t) {
    const identity = await api(`/portal/api/purchase/${id}/agreement/identity`, { token, address });
    // Check the delegation against these purchase terms before the wallet
    // signs anything; a mismatch throws and nothing is signed.
    const delegation = identity.signRequest.delegation ? checkSellerSessionDelegation(identity.signRequest.delegation, t) : null;
    log('Sign your identity presentation in your wallet (no funds move).');
    const presentation = await walletSign(identity.signRequest.message);
    let delegationSignature;
    if (delegation) {
      log(describeSellerSessionDelegation(delegation));
      log('Sign this app-session authorization in your wallet.');
      delegationSignature = await walletSign(identity.signRequest.delegation.message);
    }
    try {
      const planned = await api(`/portal/api/purchase/${id}/agreement/plan`, { token, signature: presentation, delegationSignature });
      // 202: the step is still running on the server.
      if (!planned.signRequest) throw Object.assign(new Error(planned.message || 'the Agreement plan step is still running'), { code: planned.error ?? 'plan_in_progress', indeterminate: true });
      return planned;
    } catch (error) {
      const saved = await savedPlan().catch(() => null);
      if (saved) return saved;
      // Only a 202 or an answer that never arrived can leave the step
      // running; a refusal the server gave (it carries a code) is final.
      const unsettled = error.code === 'plan_in_progress' || error.indeterminate === true || !error.code;
      if (saved === null && unsettled) log('The Agreement plan step may still be running for this purchase. Nothing new was sent. Use “Sign the DACS Agreement” to check its status and continue from a saved plan.', 'warn');
      throw error;
    }
  }
  async function signAgreement(t) {
    // Only a wallet that could later pay on the bound network signs anything.
    needWallet({ writes: 'payment' });
    needPaymentNetwork(t);
    needBoundWallet(t);
    let planned = await savedPlan();
    if (planned === false) return;
    planned ??= await planAgreement(t);
    const s = planned.signRequest.summary;
    log(`Agreement ${planned.signRequest.agreementHash}: ${s.amount} (${s.amountOs} OS) to ${s.payee}, deadline ${s.deadline}.`);
    log('Sign the Agreement in your wallet (no funds move).');
    const agreementSignature = await walletSign(planned.signRequest.agreementMessage);
    let anchorSignature;
    if (planned.signRequest.anchorMessage) {
      log('Sign the Agreement anchor authorization in your wallet (SIMULATED fixture write; no funds move).');
      anchorSignature = await walletSign(planned.signRequest.anchorMessage);
    } else {
      if (offlineAgreementBroker) {
        log('Authenticate this exact Agreement browser session with your linked wallet. Payment remains held.');
        await offlineAgreementBroker.authenticate({ address, sign: walletSign });
      } else log('The explicitly injected packaged wallet must approve the exact simulated storage CREATE and its network debit. Payment remains held.');
    }
    let next = await api(`/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature, anchorSignature });
    if (offlineAgreementBroker && !planned.signRequest.anchorMessage && next.evidence?.protocol?.stage === 'agreement-signing') {
      log('Review and deliberately approve the exact Agreement CREATE and complete simulated debit in the packaged wallet.');
      await offlineAgreementBroker.approveOne(provider);
      next = await recheckUntilSettled();
    }
    log(`DACS step: ${next.evidence?.protocol?.stage ?? next.status}.`, next.status === 'awaiting_approval' ? 'ok' : '');
    render(next);
  }
  async function countersign(t) {
    needWallet();
    needBoundWallet(t);
    let request;
    try {
      request = await api(`/portal/api/purchase/${id}/completion/request`, { token });
    } catch (error) {
      // Counter-signed already (another tab or an earlier attempt): re-check reads the copy back; nothing is signed again.
      if (error.code !== 'already_countersigned') throw error;
      log(error.message);
      render(await api(`/portal/api/purchase/${id}/protocol/recheck`, { token }));
      return;
    }
    log(`Counter-sign the completed bundle ${request.signRequest.bundleHash} in your wallet. This records protocol completion, not satisfaction with the service.`);
    const bundleSignature = await walletSign(request.signRequest.bundleMessage);
    log('Sign the anchor authorization for your bundle copy (SIMULATED fixture write; no funds move).');
    const anchorSignature = await walletSign(request.signRequest.anchorMessage);
    const next = await api(`/portal/api/purchase/${id}/completion/countersign`, { token, bundleSignature, anchorSignature });
    log(`DACS step: ${next.evidence?.protocol?.stage ?? next.status}.`, next.evidence?.protocol?.stage === 'completed' ? 'ok' : '');
    render(next);
  }
  // Show each new pending view while the server is still checking; actions
  // stay locked until polling ends. At the deadline the latest view stays
  // on screen with its Re-check action.
  async function recheckUntilSettled() {
    let shown = '';
    const view = await recheckPurchase(id, token, { onPending: (pending) => {
      const next = JSON.stringify({ ...pending, poll: undefined });
      if (next === shown) return;
      shown = next;
      render(pending);
      for (const b of document.querySelectorAll(LOCKABLE)) b.disabled = true;
    } });
    if (view.poll?.deadlineReached) log('Still checking the DACS steps. Nothing was resent; the server keeps checking. Use “Re-check DACS steps” to look again.', 'warn');
    return view;
  }
  const recheckAction = () => action('Re-check DACS steps', async () => render(await recheckUntilSettled()), { cls: 'secondary', id: 'dacs-recheck' });
  let lastSellerIdentity;
  const termsRows = (view) => {
    const t = view.terms;
    return [
      ['Status', view.status],
      ['Listing', `${t.listing.listingId} v${t.listing.version}`],
      ['Listing hash', t.listing.contentHash],
      ['Seller', view.sellerIdentity ? el('div', {}, el('p', {}, t.seller.claim), view.sellerName ? sellerNamePanel(view.sellerName, el) : null, sellerIdentityPanel(view.sellerIdentity, el)) : t.seller.claim],
      ['Pay to', t.seller.payee],
      ['Amount', `${t.price.amount} DEM (${t.price.amountOs} OS)`],
      ['Network', simulatedProfile ? `${t.network} · ${t.rail} (configured label; SIMULATED fixture chain, not Demos testnet)` : `${t.network} · ${t.rail} (configured)`],
      ['Network identity', view.evidence?.networkIdentity ?? 'unbound'],
      ['Your wallet', t.buyer.wallet],
      ['Terms hash', view.termsHash],
      ['Purchase commitment', `${view.evidence?.commitment ?? '(none)'} (signed in your approval only; a DEM transfer cannot carry it)`],
      ['Listing evidence', modeText(view.evidence?.listingMode)],
    ];
  };
  const render = (view) => {
    if (view.sellerIdentity) lastSellerIdentity = view.sellerIdentity;
    else if (lastSellerIdentity) view = { ...view, sellerIdentity: lastSellerIdentity };
    const ev = view.evidence ?? {};
    const t = view.terms;
    const report = showcaseReportView ? el('section', { id: 'purchased-report', class: 'purchased-report' }) : null;
    if (report) renderPurchasedReport(report, ev.protocol);
    if (view.status === 'settled_verified' && ev.receipt) {
      const r = ev.receipt;
      // The heading names the simulated page as before; what the evidence is
      // (and is not) is stated below it.
      flow(...compact(
        el('h2', {}, t.protocol?.transportBinding ? 'Native payment observation (mixed fixture commitment)' : ev.simulated || simulatedProfile ? 'Simulated purchase receipt' : 'Payment observation (single RPC node, tuple-only)'),
        t.protocol?.transportBinding ? el('p',{class:'warn'},'Explicit source-pinned native Agreement and DEM transport; directory and seller commitment are TEST fixtures. One node observed the tuple; finality, delivery, completion and human acceptance are not established.') : simulatedBanner(ev.simulated),
        details([
          ['Status', 'settled_verified'],
          ['Transaction', r.txHash],
          ['Block', r.blockNumber ?? '(not reported)'],
          ['Included at', r.includedAt ? new Date(r.includedAt).toLocaleString() : '(not reported)'],
          ['Amount', `${t.price.amount} DEM (${r.amountOs ?? t.price.amountOs} OS)`],
          ['Paid to', t.seller.payee],
          ['From', t.buyer.wallet],
          ['Listing', `${t.listing.listingId} v${t.listing.version} · ${t.listing.contentHash}`],
          ...(view.sellerIdentity ? [termsRows(view).find(([key]) => key === 'Seller')] : []),
          ['Payment evidence', modeText(r.chainMode)],
          ['Network identity', ev.networkIdentity ?? 'unbound'],
          ['Observed by', `one RPC node${r.rpcOrigin ? ` (${r.rpcOrigin})` : ''}; finality not established`],
          ['Matched on', 'payer, payee, amount and the reserved nonce slot only (tuple-only)'],
          ['Purchase commitment', `${ev.commitment ?? '(none)'} (in your signed approval, not in the transfer)`],
          ['Verified at', new Date(r.verifiedAt).toLocaleString()],
          ['Terms hash', view.termsHash],
        ]),
        el('p', { id: 'payment-observation-limits', class: 'warn', role: 'note' }, 'This is one RPC node’s view of a transfer that matches your approved payer, payee, amount and reserved nonce slot. It is not finality, it is not a purchase-specific receipt (a DEM transfer carries no purchase commitment), and it does not start or confirm delivery of the service.'),
        renderShowcaseProgress(view.showcaseProgress, el),
        ...protocolNodes(ev.protocol, true, t.protocol?.transportBinding),
        report,
        // A notSaved view is one check that lost to newer saved progress, and a
        // saved counter-signature is only read back: re-check, never sign again.
        ev.protocol?.stage === 'awaiting-countersignature' && !ev.protocol.notSaved && !ev.protocol.bundle?.counterSigned ? action(simLabel('Counter-sign completed bundle'), () => countersign(t), { id: 'dacs-countersign' }) : null,
        ev.protocol && (ev.protocol.notSaved || ev.protocol.bundle?.counterSigned || !['completed', 'awaiting-countersignature'].includes(ev.protocol.stage)) ? recheckAction() : null,
      ));
      return;
    }
    // Simulated profile: own headings. The status heading keeps the phrase
    // "DEM testnet purchase status" only in negated form, and one muted line
    // names the "Approve DEM testnet purchase" step it stands in for, because
    // existing tests outside core find these pages by those phrases.
    let heading;
    if (view.status === 'agreement_pending') heading = sim('Review and sign the DACS Agreement');
    else if (simulatedProfile) heading = view.status === 'awaiting_approval' ? 'Approve simulated DEM purchase (SIMULATED fixture, not Demos testnet)' : 'Simulated DEM purchase status (SIMULATED fixture, not a DEM testnet purchase status)';
    else heading = view.status === 'awaiting_approval' ? 'Approve DEM testnet purchase' : 'DEM testnet purchase status';
    const nodes = [
      el('h2', {}, heading),
      simulatedBanner(ev.simulated),
      simulatedProfile && view.status === 'awaiting_approval'
        ? el('p', { class: 'muted' }, 'This simulated step stands in for “Approve DEM testnet purchase” on a real server: the seller, chain and payment here are local fixtures, and no real DEM moves.')
        : null,
      details([...termsRows(view), ...(view.status === 'awaiting_approval' ? [['Approve before', new Date(t.approvalExpiresAt).toLocaleString()]] : [])]),
      renderShowcaseProgress(view.showcaseProgress, el),
      ...protocolNodes(ev.protocol, ['agreement_pending', 'awaiting_approval', 'approved', 'payment_handoff'].includes(view.status), t.protocol?.transportBinding),
      report,
    ];
    if (view.status === 'agreement_pending') {
      const agreementOnly = ev.protocol?.limits?.payment === 'held';
      nodes.push(el('p', { class: 'muted' }, agreementOnly ? 'Payment remains held. Agreement storage approval includes only the exact simulated CREATE and the network debit displayed by the packaged wallet.' : 'Total debit when you pay later: the amount above plus the network fee your wallet shows before sending; the wallet refuses a different debit.'));
      if (!ev.protocol?.notSaved && (!agreementOnly || ['identity', 'agreement-signing'].includes(ev.protocol.stage))) nodes.push(action(simLabel('Sign the DACS Agreement'), () => signAgreement(t), { id: 'dacs-sign-agreement' }));
      nodes.push(recheckAction());
    } else if (view.status === 'awaiting_approval') {
      nodes.push(action(simLabel('Approve exact terms'), async () => {
        needWallet({ writes: 'payment' });
        let challenge;
        try {
          challenge = await api(`/portal/api/purchase/${id}/challenge`, { token, address });
        } catch (error) {
          // The pre-signature listing or network re-check found different
          // terms: show the persisted state instead of asking for a signature.
          if (['terms_changed', 'network_identity_mismatch', 'network_identity_unpinned', 'network_identity_unverified'].includes(error.code)) {
            render(await api(`/portal/api/purchase/${id}/view`, { token }));
          }
          throw error;
        }
        // The server's re-checks passed; only a wallet on the bound network signs.
        needPaymentNetwork(t);
        log('Sign the exact purchase terms in your wallet.');
        const signature = await walletSign(challenge.message);
        const next = await api(`/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.challengeId, signature });
        log('Approval recorded.', 'ok');
        await pay(next);
      }));
    } else if (view.status === 'payment_handoff' && ev.protocol?.nativePayment) {
      nodes.push(el('p', {}, 'The native payment was delivered to the wallet once. This operation is readback-only; use verify_deal with the wallet transaction hash. No resend is offered.'));
    } else if (view.status === 'approved' || view.status === 'payment_handoff') {
      nodes.push(action(simLabel('Send payment from wallet'), async () => {
        needWallet({ writes: 'payment' });
        needPaymentNetwork(t);
        await pay(await api(`/portal/api/purchase/${id}/handoff`, { token }));
      }));
    } else {
      if (ev.reportedTxHash) nodes.push(details([['Reported transaction', ev.reportedTxHash], ['Payment evidence', modeText(ev.paymentMode)]]));
      nodes.push(el('p', {}, ev.next ?? 'Nothing more to do here. Check status in ChatGPT.'));
      if (view.verification?.outcome) nodes.push(el('p', { class: 'muted' }, `Verification: ${view.verification.outcome}`));
    }
    flow(...compact(...nodes));
  };
  async function pay(view) {
    if (!view.payload) {
      render(view);
      // A handoff the server refused before signing says why (its fixed text).
      if (view.refusal) throw new Error(view.refusal);
      log(`No transaction to send (status ${view.status}).`);
      return;
    }
    // Same network gate on the exact handoff, right before the wallet is asked.
    needPaymentNetwork(view.terms);
    log('Confirm the transfer in your wallet.');
    let txHash = null;
    try {
      if (view.evidence?.protocol?.nativePayment) offlineAgreementBroker?.useNativePaymentLane();
      txHash = await walletSend(view.payload);
    } catch (error) {
      const reported = await api(`/portal/api/purchase/${id}/report`, { token, walletError: error.message, ...(view.evidence?.protocol?.nativePayment && error.txHash ? { txHash: error.txHash } : {}), ...(view.evidence?.protocol?.nativePayment && error.code ? { walletErrorCode: error.code } : {}) });
      // A native payment's report carries the wallet's code; the server
      // decides from the operator's own records.
      render(reported);
      // A native payment cancelled meanwhile: the server refuses the wallet's
      // lane read and the operator's source refuses its transfer (signature
      // lease, confirmTx, broadcast), so this attempt was not sent. An earlier
      // attempt (one read back as failed) may have been. Say so, from the
      // server's own state.
      if (view.evidence?.protocol?.nativePayment && reported.status === 'cancelled') {
        throw new Error('This purchase was cancelled. The operator refused this attempt at its transfer, so it was not sent. An earlier attempt may have been sent; the purchase status reads it back.');
      }
      // Still payment_handoff after a refused attempt: the transfer has the
      // terms of another purchase's cancelled payment, so the operator's
      // source refused it and this purchase was not cancelled.
      if (view.evidence?.protocol?.nativePayment && reported.status === 'payment_handoff') {
        throw new Error('The operator refused this attempt at its transfer, so it was not sent: the transfer has the same terms as a cancelled purchase\'s payment. This purchase was not cancelled. Cancel it (cancel_wallet_handoff) and prepare it again: the new purchase pays at a new nonce.');
      }
      throw error;
    }
    const reported = await api(`/portal/api/purchase/${id}/report`, { token, txHash });
    log(`Wallet result reported; verification: ${reported.verification?.outcome ?? 'pending'}.`, reported.status === 'settled_verified' ? 'ok' : '');
    render(reported);
  }
  render(await api(`/portal/api/purchase/${id}/view`, { token }));
}

// ---------------- identity add/remove (offline candidate) ----------------
// Provider methods follow the reviewed Demos wallet 0.5.7 source; they are not
// verified against an installed wallet. The portal asks the wallet exactly
// once, with the request the server recorded, and never retries.
async function sha256HexOf(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Which wallet answered, reported with its outcome: the server closes the
// action on the embedded wallet's own stopped-before-broadcast codes only
// when that wallet answered; an extension's codes keep the outcome unknown.
const answeringWallet = () => (walletSource === 'embedded' && provider?.isDacsEmbeddedWallet === true ? 'embedded' : 'extension');

async function walletOutcome(req) {
  const wallet = answeringWallet();
  let res;
  try {
    res = await provider.request({ method: req.method, params: req.params });
  } catch (error) {
    return { success: false, code: null, message: String(error?.message ?? error), wallet };
  }
  if (res && typeof res === 'object' && res.success === true) return { success: true, dataSha256: await sha256HexOf(res.data), wallet };
  if (res && typeof res === 'object' && res.success === false) return { success: false, code: res.error?.code ?? null, message: res.error?.message ?? null, wallet };
  return { success: false, code: null, message: 'unrecognized wallet response', wallet };
}

// Embedded wallet error codes whose contract (embedded-wallet/sdk-provider.mjs)
// is "failed before anything was signed or broadcast". Display only: the
// server decides the status (src/identities.mjs).
const EMBEDDED_PRE_SEND_CODES = new Set(['user_rejected', 'locked', 'invalid_params', 'not_configured', 'unsupported', 'upstream_unavailable', 'identity_mismatch', 'sdk_error', 'payload_mismatch', 'confirm_rejected', 'busy', 'held_for_review', 'invalid_request']);
// GitHub usernames: letters, digits and single inner hyphens, at most 39.
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Recovery as src/identities.mjs implements it: once the wallet was asked and
// its answer does not show that nothing was sent, the action stays in flight
// (wallet_requested / readback_pending / outcome_unknown) until readback shows
// the change, and new identity actions for the same wallet are refused
// meanwhile. Cancelling is possible only before the wallet is asked.
const IN_FLIGHT_NEXT = 'What happens next: this server keeps the action open until chain readback shows the change; “Check chain again” re-reads the chain. Until then, a new identity action for this wallet, whether started from ChatGPT or from the tester dashboard, is refused (identity_operation_in_progress), and that stays so after this one turns “outcome unknown” 10 minutes after the wallet was asked. An identity action can be cancelled only before your wallet is asked; this one was already asked. Other linked wallets, purchases are not affected.';
const CLOSED_NEXT = {
  rejected_before_send: 'This action is closed. You can start a new identity action for this wallet, from ChatGPT or from the tester dashboard.',
  failed_before_send: 'This action is closed and nothing was retried. Fix what the wallet reported (for example, publish the proof first or use your real handle), then start a new identity action for this wallet, from ChatGPT or from the tester dashboard.',
};

// The wallet's own answer for this action, from the server's persisted record.
function walletAnswer(view, tabSource) {
  const w = view.walletOutcome;
  if (!w || w.success !== false) return null;
  const source = w.wallet ?? tabSource;
  const said = w.message ? `Your wallet answered: ${w.message}` : 'Your wallet answered with an error and no message';
  let sent = 'The wallet did not say whether anything was sent.';
  if (source === 'embedded' && EMBEDDED_PRE_SEND_CODES.has(w.code)) sent = 'Nothing was signed or sent.';
  else if (source === 'embedded' && w.code === 'outcome_unknown') sent = 'The request may or may not have reached the node. It was not retried.';
  else if (source === 'embedded' && w.code === 'broadcast_rejected') sent = 'The node answered the request with a refusal.';
  let next = CLOSED_NEXT[view.status] ?? null;
  if (['wallet_requested', 'readback_pending', 'outcome_unknown'].includes(view.status)) next = IN_FLIGHT_NEXT;
  return el('div', { id: 'wallet-answer', class: 'bad', role: 'alert', 'data-wallet-code': w.code ?? '' },
    ...compact(el('p', {}, `${said}${w.code ? ` (${w.code})` : ''}. ${sent}`), next ? el('p', { class: 'muted' }, next) : null));
}

async function identityFlow(id) {
  const token = fragment.get('t') || sessionStorage.getItem(`dacs:${id}`);
  if (token) sessionStorage.setItem(`dacs:${id}`, token);
  // Which wallet answered, kept for this tab so a reload still explains it.
  const sourceKey = `dacs:${id}:wallet`;
  const rows = (view) => {
    const t = view.terms;
    return [
      ['Status', view.status],
      ['Action', t.action === 'add' ? `Add a ${t.kind} link` : `Remove a ${t.kind} link`],
      ['Handle', view.username ?? '(from the proof URL you provide)'],
      ['Your wallet', t.wallet],
      ['Network', simulatedProfile ? `${t.network} (configured label; SIMULATED fixture chain, not Demos testnet)` : `${t.network} (configured on this server; this page cannot see your wallet's network)`],
      ['Evidence', modeText(view.evidenceMode)],
    ];
  };
  const render = (view) => {
    const simulated = view.evidenceMode === 'simulated-fixture';
    const t = view.terms;
    const head = [el('h2', {}, sim('Demos identity link')), simulatedBanner(simulated), details(rows(view)), el('p', { class: 'muted' }, view.statusHelp ?? '')];
    // Before the wallet is asked the person can close the action here; the
    // server refuses once the wallet was asked.
    const cancel = () => action('Cancel this identity action', async () => {
      const cancelled = await api(`/portal/api/identity/${id}/cancel`, { token });
      log(cancelled.status === 'cancelled' ? 'Identity action cancelled. Nothing was sent to your wallet.' : `This identity action is ${cancelled.status}.`, 'ok');
      render(cancelled);
    }, { cls: '', secondary: true, id: 'identity-cancel' });
    if (view.status === 'awaiting_wallet') {
      return flow(...compact(...head, action('Use my connected wallet', async () => {
        needWallet({ writes: 'identity' });
        render(await api(`/portal/api/identity/${id}/connected`, { token, address }));
      }), cancel()));
    }
    if (view.status === 'awaiting_public_proof') {
      const proofBox = el('pre', { id: 'proof-text' }, '(not requested yet)');
      const urlInput = el('input', { id: 'proof-url', type: 'url', placeholder: t.kind === 'github' ? 'https://gist.github.com/<handle>/<id>' : 'https://x.com/<handle>/status/<id>', 'aria-label': 'Public proof URL' });
      return flow(...compact(...head,
        el('p', {}, `Step 1: get the proof text from your wallet. Step 2: publish it yourself ${t.kind === 'github' ? 'as a public gist' : 'as a public post'}. Publishing is public and permanent, and links that handle to your wallet address. Step 3: paste its public URL here.`),
        action('Get proof text from my wallet', async () => {
          needWallet({ writes: 'identity' });
          const res = await provider.request({ method: 'getWeb2IdentityProofPayload', params: [] });
          envelopeError(res);
          const proof = typeof res?.data === 'string' ? res.data : null;
          if (!proof) throw new Error('wallet did not return proof text');
          proofBox.textContent = proof;
        }, { cls: '' }),
        proofBox,
        urlInput,
        action('Use this proof URL', async () => {
          render(await api(`/portal/api/identity/${id}/proof`, { token, proofUrl: urlInput.value }));
        }),
        cancel(),
      ));
    }
    if (view.status === 'review') {
      const what = t.action === 'add'
        ? `Add the ${t.kind} handle ${view.username} (proof: ${view.proofUrl}) to wallet ${t.wallet}.`
        : `Remove the ${t.kind} handle ${view.username} from wallet ${t.wallet}.`;
      // Before the wallet is asked: a handle GitHub cannot have can never be
      // looked up (the server already refuses characters GitHub never allows;
      // this covers its stricter hyphen rules).
      const impossibleGithub = t.action === 'add' && t.kind === 'github' && typeof view.username === 'string' && !GITHUB_USERNAME.test(view.username);
      return flow(...compact(...head,
        el('p', {}, what),
        impossibleGithub
          ? el('p', { id: 'identity-handle-warning', class: 'warn', role: 'note' }, `“${view.username}” cannot be a GitHub username (GitHub allows letters, digits and single hyphens, at most 39 characters), so the wallet cannot look it up and nothing would be linked. Use “Cancel this identity action” below (or let it expire at ${fmtTime(Date.parse(view.expiresAt))}), then start again with a gist under your real GitHub username.`)
          : null,
        el('p', { class: 'muted' }, 'Your wallet shows the transaction and asks you to confirm before anything is sent. The amount is 0; any network fee is whatever your wallet shows. No points or rewards are promised.'),
        t.action === 'remove' ? el('p', { class: 'muted' }, 'Removing unlinks it on chain. It does not delete your public post or gist or past transactions, and it does not disconnect your wallet or delete your account.') : null,
        action(simLabel('Approve in my wallet'), async () => {
          needWallet({ writes: 'identity' });
          const asked = await api(`/portal/api/identity/${id}/request`, { token });
          log('Asking your wallet once. Nothing is retried automatically.');
          sessionStorage.setItem(sourceKey, walletSource);
          const outcome = await walletOutcome(asked.walletRequest);
          const reported = await api(`/portal/api/identity/${id}/report`, { token, outcome });
          log(`Wallet result recorded: ${reported.walletOutcome?.classification ?? 'unknown'}.`, reported.walletOutcome?.classification === 'wallet_reported_success' ? 'ok' : '');
          render(reported);
        }),
        cancel(),
      ));
    }
    const done = ['association_observed', 'removal_observed'].includes(view.status);
    return flow(...compact(...head,
      walletAnswer(view, sessionStorage.getItem(sourceKey)),
      done ? el('p', { class: 'ok' }, view.status === 'association_observed' ? 'Association observed on chain.' : 'Association no longer observed on chain.') : null,
      ['wallet_requested', 'readback_pending', 'outcome_unknown'].includes(view.status)
        ? action('Check chain again', async () => render(await api(`/portal/api/identity/${id}/view`, { token })), { cls: '' })
        : null,
    ));
  };
  if (!token) return flow(el('h2', {}, 'Identity link unavailable'), el('p', {}, 'This page was opened without its link token. Ask ChatGPT for a new identity action (start_identity_action).'));
  render(await api(`/portal/api/identity/${id}/view`, { token }));
}

// ---------------- boot ----------------
(async () => {
  $('recheck').addEventListener('click', run(async () => {
    $('recheck').disabled = true;
    try {
      if (!(await findWallet())) log('Still no Demos wallet extension found.', 'bad');
    } finally {
      $('recheck').disabled = false;
    }
  }));
  $('use-embedded').addEventListener('click', run(useEmbeddedWallet));
  $('use-extension').addEventListener('click', run(useExtensionWallet));
  await Promise.all([findWallet(), detectSimulatedProfile()]);
  try {
    if (path[1] === 'authorize') await authorizeFlow(path[2]);
    else if (path[1] === 'link') await linkFlow();
    else if (path[1] === 'purchase') await purchaseFlow(path[2]);
    else if (path[1] === 'identity') await identityFlow(path[2]);
    else flow(el('p', {}, 'Unknown portal page.'));
  } catch (error) {
    flow(el('p', { class: 'bad' }, error.message));
  }
})();
