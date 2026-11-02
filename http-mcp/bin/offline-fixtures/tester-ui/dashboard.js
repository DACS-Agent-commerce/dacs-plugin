// DACS offline tester dashboard (SIMULATED ONLY). Renders the operator's
// public dashboard state; every server value is written with textContent or as
// a checked same-origin/loopback link. This page never handles a password,
// recovery phrase, backup, token or signature.
const $ = (id) => document.getElementById(id);
let state = null;
const pending = new Set();
const transient = {};
const RUN_KEY = 'dacs-offline-tester:run';

// Buttons whose data-action is a dashboard alias of a server action.
const ALIASES = {
  'identity-add-twitter': ['identity-add', { kind: 'twitter' }],
  'identity-remove-twitter': ['identity-remove', { kind: 'twitter' }],
};
const serverAction = (name) => (ALIASES[name] ? ALIASES[name][0] : name);

function text(id, value) {
  $(id).textContent = value === null || value === undefined || value === '' ? '—' : String(value);
}
function show(id, on) {
  $(id).hidden = !on;
}
// Only http(s) links on this page's host are rendered; anything else is dropped.
function link(id, href) {
  const a = $(id);
  let ok = false;
  try {
    const u = new URL(href, location.href);
    ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === location.hostname;
  } catch {
    ok = false;
  }
  if (ok) a.href = href;
  else a.removeAttribute('href');
  return ok;
}
function error(id, message) {
  text(id, message);
  show(id, Boolean(message));
}
function announce(message) {
  $('live').textContent = message;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}
// Moves keyboard focus to a message or section so the reason is read first.
function focusOn(id) {
  const target = $(id);
  if (!target || target.hidden) return;
  target.focus({ preventScroll: false });
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dacs-tester': '1' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const out = await res.json().catch(() => ({ ok: false, error: `dashboard request failed (HTTP ${res.status})` }));
  if (!res.ok && out.ok !== false) out.ok = false;
  return out;
}

async function act(action, args = {}) {
  if (pending.has(action)) return null;
  pending.add(action);
  render();
  try {
    const out = await post('/tester/api/action', { action, args });
    if (out.state) state = out.state;
    // A problem the state has no slot for (for example Prepare before any
    // purchase exists) stays visible until that section's next action.
    const target = ERROR_TARGET[action];
    if (target) transient[target] = out.ok ? null : out.error ?? 'request failed';
    show('offline-notice', false);
    announce(out.ok ? 'Done.' : `Problem: ${out.error ?? 'request failed'}`);
    return out;
  } catch {
    show('offline-notice', true);
    announce('The dashboard could not reach the offline launcher. Is it still running?');
    return null;
  } finally {
    pending.delete(action);
    render();
  }
}

// Where each action's problem is shown (and focused).
const ERROR_TARGET = {
  'sign-in': 'sign-in-error', 'restart-sign-in': 'sign-in-error', 'refresh-account': 'sign-in-error',
  'buyer-start-over': 'sign-in-error',
  'find-listing': 'listing-error', 'search-listings': 'listing-error', 'verify-listing': 'listing-error',
  'prepare-purchase': 'purchase-error', 'refresh-receipt': 'purchase-error', 'cancel-purchase': 'purchase-error',
  'identity-add': 'identity-error', 'identity-remove': 'identity-error', 'refresh-identities': 'identity-error',
};
function afterAction(name, out) {
  if (out && !out.ok) focusOn(ERROR_TARGET[name]);
}

const signedIn = (s = state?.signIn) => s?.status === 'signed_in' && s.wallets.length > 0;
const PURCHASE_PENDING = ['awaiting_approval', 'approved', 'payment_handoff'];
// Closed identity actions (same set as the operator): no portal link, and Add
// or Remove starts a new action.
const IDENTITY_DONE = ['association_observed', 'removal_observed', 'rejected_before_send', 'failed_before_send', 'cancelled', 'expired'];

function renderButtons() {
  const verified = state?.listing.verification?.transactable === true;
  const p = state?.purchase;
  const enabled = {
    'sign-in': state && state.signIn.status !== 'signed_in',
    'restart-sign-in': true,
    'refresh-account': true,
    'buyer-start-over': true,
    'find-listing': true,
    'search-listings': true,
    'prepare-purchase': signedIn() && verified,
    'refresh-receipt': signedIn() && Boolean(p?.operationId),
    'cancel-purchase': signedIn() && Boolean(p?.operationId),
    'identity-add': signedIn(),
    'identity-add-twitter': signedIn(),
    'refresh-identities': signedIn(),
    'identity-remove': signedIn() && (state?.identity.observed?.githubHandles?.length ?? 0) > 0,
    'identity-remove-twitter': signedIn() && (state?.identity.observed?.twitterHandles?.length ?? 0) > 0,
  };
  for (const button of document.querySelectorAll('button[data-action]')) {
    const name = button.dataset.action;
    const server = serverAction(name);
    const busy = pending.has(server) || Boolean(state?.busy?.includes(server));
    button.disabled = busy || !enabled[name];
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  for (const button of document.querySelectorAll('button[data-verify]')) {
    const busy = pending.has('verify-listing') || Boolean(state?.busy?.includes('verify-listing'));
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

function signInLabels(s, who) {
  return {
    signed_out: who === 'seller' ? 'Seller not signed in.' : 'Not signed in.',
    redirected: 'Sign-in started: finish it in the portal (it opens in this tab).',
    signed_in: who === 'seller' ? `Seller signed in. Linked wallet: ${s.wallets[0] ?? ''}` : `Signed in. Linked wallet: ${s.wallets[0] ?? ''}`,
    no_wallet: 'Signed in, but no wallet is linked yet.',
    declined: 'Sign-in was declined or cancelled. Nothing was linked.',
    error: 'Sign-in did not complete.',
  };
}

function renderSignInFor(s, who, ids) {
  const labels = signInLabels(s, who);
  text(ids.status, labels[s.status] ?? s.status);
  $(ids.status).classList.toggle('ok', s.status === 'signed_in');
  const hasLink = s.status === 'redirected' && s.authorizationUrl && link(ids.link, s.authorizationUrl);
  show(ids.fallback, Boolean(hasLink));
  document.querySelector(`[data-action="${ids.restart}"]`).hidden = !['redirected', 'declined', 'error'].includes(s.status);
  document.querySelector(`[data-action="${ids.refresh}"]`).hidden = s.status !== 'signed_in' && s.status !== 'no_wallet';
  // Offered whenever this role has a sign-in (or one in progress) to leave.
  document.querySelector(`[data-action="${ids.startOver}"]`).hidden = s.status === 'signed_out';
  error(ids.error, s.error);
}

const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a ?? 'no wallet');
function renderEarlier() {
  const buyers = state.earlier?.buyer ?? [];
  show('buyer-earlier', buyers.length > 0);
  $('buyer-earlier-list').replaceChildren(...buyers.map((e) => el('li', {},
    `Wallet ${short(e.wallet)} (left ${new Date(e.leftAt).toLocaleTimeString()}): `,
    e.purchase ? `purchase ${e.purchase.operationId} for ${e.purchase.listingId} was ${e.purchase.status}${e.purchase.receiptObserved ? ' (simulated receipt observed)' : ''}` : 'no purchase',
    e.completedPurchases?.length ? `; earlier finished purchases: ${e.completedPurchases.map((c) => `${c.operationId} for ${c.listingId} ${c.status}${c.receiptObserved ? ' (simulated receipt observed)' : ''}`).join(', ')}` : '',
    e.identities.length ? `; identity ${e.identities.map((i) => `${i.kind} ${i.action} ${i.status}`).join(', ')}` : '',
    '. Last observed status, not refreshed; only that wallet can approve anything still pending.')));
}

function renderSignIn() {
  renderSignInFor(state.signIn, 'buyer', { status: 'sign-in-status', link: 'sign-in-link', fallback: 'sign-in-fallback', restart: 'restart-sign-in', refresh: 'refresh-account', startOver: 'buyer-start-over', error: 'sign-in-error' });
  renderEarlier();
}

function renderListing() {
  const { discovery: d, verification: v, error: e, search } = state.listing;
  show('discovery-empty', !d);
  show('discovery', Boolean(d));
  if (d && d.found) {
    const seller = d.seller ?? state.fixture.seller;
    text('d-title', d.title);
    text('d-seller', d.sellerName ? `${d.sellerName} (${seller})` : seller);
    text('d-price', d.priceHint ? `${d.priceHint} ${d.currency ?? ''}`.trim() : null);
    text('d-evidence', `${d.evidenceMode} directory hint (not verified)`);
  } else if (d) {
    text('d-title', 'The fixture listing was not found in the directory.');
    text('d-seller', null);
    text('d-price', null);
    text('d-evidence', d.evidenceMode);
  }
  show('verify-empty', !v);
  show('verification', Boolean(v));
  if (v) {
    text('v-result', v.transactable ? 'Verified: transactable' : `Not transactable (${v.failedChecks.join(', ') || v.eligibility})`);
    text('v-title', v.title);
    text('v-price', v.amount ? `${v.amount} ${v.currency ?? 'DEM'} (${v.amountOs} OS, fixture DEM)` : null);
    text('v-seller', v.seller);
    text('v-checks', `${v.passedChecks} passed, ${v.failedChecks.length} failed`);
    text('v-evidence', v.chainMode === 'simulated-fixture' ? 'simulated-fixture chain readback (SIMULATED)' : v.chainMode);
  }
  show('search-summary', Boolean(search));
  if (search) {
    text('search-summary', search.results.length
      ? `${search.results.length} result(s) for "${search.query}" (unverified directory hints). Choose one to verify it.`
      : `No listing matched "${search.query}". Check the spelling, or wait until the seller's publication shows "Discoverable".`);
  }
  const results = search?.results ?? [];
  $('search-results').replaceChildren(...results.map((r, i) => {
    const chosen = v && v.listingId === r.listingId && v.seller === r.seller && v.version === r.version;
    return el('li', { class: chosen ? 'chosen' : '' },
      el('span', { class: 'result-title' }, r.title),
      ` — ${r.priceHint ?? '?'} ${r.currency ?? ''} · ${r.sellerName ?? 'seller'} `,
      r.baseline ? el('span', { class: 'tag' }, 'baseline fixture') : el('span', { class: 'tag' }, 'seller-published'),
      ' ',
      el('button', { type: 'button', class: 'secondary', 'aria-label': `Verify and choose "${r.title}"`, dataset: { verify: String(i) } }, chosen ? 'Chosen (verify again)' : 'Verify and choose'));
  }));
  error('listing-error', e);
}

function renderPurchase() {
  const p = state.purchase;
  const v = state.listing.verification;
  text('p-target', v?.transactable ? `Buying: "${v.title ?? v.listingId}" for ${v.amount} ${v.currency ?? 'DEM'} (fixture DEM), verified.` : 'Buying: nothing verified yet (step 3).');
  show('purchase-empty', !p?.operationId);
  show('purchase-body', Boolean(p?.operationId));
  if (p?.operationId) {
    const pendingReview = PURCHASE_PENDING.includes(p.status);
    show('purchase-review', pendingReview && Boolean(p.approvalUrl) && link('purchase-review', p.approvalUrl));
    text('p-status', p.replayed ? `${p.status} (same pending purchase returned, not a new one)` : p.status);
    text('p-next', p.next);
    text('p-listing', p.terms ? `${p.terms.listingId} v${p.terms.version}` : null);
    text('p-amount', p.terms ? `${p.terms.amount} (${p.terms.amountOs} OS)` : null);
    text('p-network', p.terms?.network);
    text('p-payee', p.terms?.payee);
    text('p-op', p.operationId);
    text('p-key', p.idempotencyKey);
    const r = p.receipt;
    show('receipt', Boolean(r));
    show('receipt-waiting', !r);
    if (r) {
      text('r-amount', `${p.terms?.amount ?? ''} (${r.amountOs} OS)`);
      text('r-network', p.terms?.network);
      text('r-payer', r.payer);
      text('r-payee', r.payee);
      text('r-tx', r.txHash);
      text('r-mode', `${r.chainMode} (SIMULATED receipt from the fixture chain; not settlement)`);
    }
    document.querySelector('[data-action="cancel-purchase"]').hidden = !pendingReview;
  } else {
    document.querySelector('[data-action="cancel-purchase"]').hidden = true;
  }
  renderCompletedPurchases();
  error('purchase-error', p?.error ?? null);
}

// Finished purchases kept from this sign-in, newest first, with the receipt
// the dashboard read for each (a cancelled or failed one has none).
function renderCompletedPurchases() {
  const kept = [...(state.completedPurchases ?? [])].reverse();
  show('purchase-history', kept.length > 0);
  $('purchase-history-list').replaceChildren(...kept.map((c) => {
    const t = c.terms;
    const r = c.receipt;
    return el('li', { dataset: { operation: c.operationId, status: c.status } },
      `${t ? `${t.listingId} v${t.version}, ${t.amount} (${t.amountOs} OS)` : c.operationId}: ${c.status}. `,
      r ? `Receipt: payer ${r.payer}, payee ${r.payee}, transaction ${r.txHash}, ${r.chainMode} (SIMULATED receipt from the fixture chain; not settlement).` : 'No receipt.',
      ` Operation ${c.operationId}.`);
  }));
}

function renderHandles(selectId, handles) {
  const select = $(selectId);
  const current = select.value;
  select.replaceChildren(...handles.map((h) => {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    return opt;
  }));
  if (handles.includes(current)) select.value = current;
}

function renderIdentity() {
  const id = state.identity;
  link('proof-link', state.links.proofPublisher);
  const slots = [['add', id.add, ''], ['remove', id.remove, ''], ['add', id.twitter?.add, 'tw-'], ['remove', id.twitter?.remove, 'tw-']];
  for (const [slot, op, prefix] of slots) {
    show(`${prefix}${slot}-body`, Boolean(op?.operationId));
    if (op?.operationId) {
      text(`${prefix}${slot}-status`, `${op.status}${op.username ? ` (${op.username})` : ''}${op.statusHelp ? `: ${op.statusHelp}` : ''}`);
      const done = IDENTITY_DONE.includes(op.status);
      show(`${prefix}${slot}-review`, !done && Boolean(op.portalUrl) && link(`${prefix}${slot}-review`, op.portalUrl));
    }
  }
  const o = id.observed;
  show('identity-empty', !o);
  show('observed', Boolean(o));
  if (o) {
    text('o-status', o.status === 'observed' ? `observed (${o.mode}; fixture chain observation, not KYC)` : `${o.status}: unknown, not empty`);
    text('o-handles', o.status === 'observed' ? (o.githubHandles.length ? o.githubHandles.join(', ') : 'none observed') : 'unknown');
    const tw = o.twitterHandles ?? [];
    text('o-twitter', o.status === 'observed' ? (tw.length ? tw.join(', ') : 'none observed') : 'unknown');
    text('o-at', o.observedAt);
  }
  const handles = o?.githubHandles ?? [];
  show('remove-form', handles.length > 0);
  renderHandles('remove-handle', handles);
  const twHandles = o?.twitterHandles ?? [];
  show('tw-remove-form', twHandles.length > 0);
  renderHandles('tw-remove-handle', twHandles);
  error('identity-error', id.error);
}

function renderChecklist() {
  for (const box of document.querySelectorAll('input[data-item]')) {
    box.checked = state.checklist[box.dataset.item] === true;
    box.disabled = pending.has('checklist');
  }
}

const RESUME_TARGET = { 'buyer-sign-in': 'sign-in', purchase: 'purchase' };
const RESUME_LABEL = {
  'buyer-sign-in': 'Buyer sign-in', purchase: 'Simulated purchase',
  'identity-add': 'GitHub identity add', 'identity-remove': 'GitHub identity remove', 'identity-twitter-add': 'Twitter identity add', 'identity-twitter-remove': 'Twitter identity remove',
};
function renderResume() {
  const items = state.unfinished ?? [];
  show('resume', items.length > 0);
  $('resume-list').replaceChildren(...items.map((u) => el('li', {},
    el('a', { href: `#${RESUME_TARGET[u.step] ?? 'identity'}` }, RESUME_LABEL[u.step] ?? u.step),
    ` (${u.status}): ${u.next}`)));
}

function renderActivity() {
  const items = [...(state.activity ?? [])].reverse().slice(0, 12);
  show('activity-empty', items.length === 0);
  $('activity').replaceChildren(...items.map((a) => el('li', { class: a.ok ? '' : 'bad' }, `${new Date(a.at).toLocaleTimeString()} ${a.action}: ${a.ok ? 'ok' : `problem: ${a.error ?? 'failed'}`}`)));
}

// The next step a tester would usually take, from the public state only.
function nextStep() {
  const p = state.purchase;
  if (state.unfinished?.length) return ['resume', 'Unfinished steps'];
  if (!signedIn()) return ['sign-in', '2 Buyer sign-in'];
  if (!state.listing.verification?.transactable) return ['listing', '3 Find and verify a service'];
  if (!p?.receipt) return ['purchase', '4 Simulated purchase'];
  if (!state.identity.observed) return ['identity', '5 GitHub and Twitter identities'];
  return ['evidence', '8 Evidence download'];
}

function renderNav() {
  const [target, label] = nextStep();
  const a = $('next-step-link');
  a.href = `#${target}`;
  a.textContent = label;
  for (const item of document.querySelectorAll('#steps-nav ol a')) {
    if (item.getAttribute('href') === `#${target}`) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

function render() {
  if (!state) return;
  link('wallet-link', state.links.wallet);
  text('run-id', state.runId);
  renderSignIn();
  renderListing();
  renderPurchase();
  renderIdentity();
  renderChecklist();
  renderResume();
  renderActivity();
  renderNav();
  renderButtons();
  for (const [target, message] of Object.entries(transient)) {
    if (message && $(target).hidden) error(target, message);
  }
}

function checkRun() {
  let previous = null;
  try {
    previous = sessionStorage.getItem(RUN_KEY);
    sessionStorage.setItem(RUN_KEY, state.runId);
  } catch {
    previous = null;
  }
  // Once seen, the notice stays until this tab is reloaded.
  if (previous && previous !== state.runId) show('restart-notice', true);
}

async function refreshState() {
  const res = await fetch('/tester/api/state', { credentials: 'same-origin' });
  state = await res.json();
  show('offline-notice', false);
  checkRun();
  render();
}

async function refreshHealth() {
  try {
    const h = await (await fetch('/health')).json();
    const chain = h.dependencies?.chain?.configured ? 'fixture chain configured' : 'fixture chain NOT configured';
    const dir = h.dependencies?.directory?.configured ? 'fixture directory configured' : 'fixture directory NOT configured';
    text('health-status', h.status === 'ok' ? `Running (${chain}, ${dir})` : `Unhealthy: ${h.status}`);
  } catch {
    text('health-status', 'Not reachable. Is the offline launcher still running?');
    show('offline-notice', true);
  }
}


async function download(path, body, key, filename, statusId, errorId, buttonId) {
  const button = $(buttonId);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  error(errorId, null);
  try {
    const out = await post(path, body);
    if (!out.ok) throw new Error(out.error ?? 'export failed');
    const blob = new Blob([`${JSON.stringify(out[key], null, 2)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return true;
  } catch (e) {
    error(errorId, String(e?.message ?? e).slice(0, 200));
    return false;
  } finally {
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
}

function wire() {
  for (const button of document.querySelectorAll('button[data-action]')) {
    if (button.type === 'submit') continue;
    button.addEventListener('click', async () => {
      const name = button.dataset.action;
      const [action, args] = ALIASES[name] ?? [name, {}];
      const out = await act(action, args);
      afterAction(action, out);
      // After Start over, the next step is that role's sign-in button.
      if (out?.ok && name.endsWith('-start-over')) document.querySelector('[data-action="sign-in"]')?.focus();
      const role = state?.signIn;
      const url = role?.authorizationUrl;
      if (out?.ok && ['sign-in', 'restart-sign-in'].includes(name) && role.status === 'redirected' && url) {
        try {
          const u = new URL(url);
          if (u.hostname === location.hostname) location.assign(url);
        } catch {
          // The visible fallback link stays available.
        }
      }
    });
  }
  $('search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const out = await act('search-listings', { query: $('search-query').value });
    if (out && !out.ok) $('search-query').focus();
    else if (out?.ok) $('search-results').querySelector('button')?.focus();
  });
  $('search-results').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-verify]');
    if (!button) return;
    const r = state?.listing.search?.results?.[Number(button.dataset.verify)];
    if (!r) return;
    afterAction('verify-listing', await act('verify-listing', { listingId: r.listingId, version: r.version, seller: r.seller }));
  });
  $('remove-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    afterAction('identity-remove', await act('identity-remove', { username: $('remove-handle').value }));
  });
  $('tw-remove-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    afterAction('identity-remove', await act('identity-remove', { username: $('tw-remove-handle').value, kind: 'twitter' }));
  });
  for (const box of document.querySelectorAll('input[data-item]')) {
    box.addEventListener('change', () => {
      // Keep the tester's tick while saving; the server answer then confirms it.
      if (state) state.checklist[box.dataset.item] = box.checked;
      act('checklist', { item: box.dataset.item, done: box.checked });
    });
  }
  $('export-button').addEventListener('click', async () => {
    if (await download('/tester/api/export', { feedback: $('feedback-text').value }, 'export', 'dacs-offline-tester-feedback.json', 'export-status', 'export-error', 'export-button')) {
      text('export-status', 'Feedback file created on this computer. Nothing was sent.');
    }
  });
  $('evidence-button').addEventListener('click', async () => {
    if (await download('/tester/api/evidence', {}, 'evidence', 'dacs-offline-tester-evidence.json', 'evidence-status', 'evidence-error', 'evidence-button')) {
      text('evidence-status', 'Evidence file created on this computer (SIMULATED workflow states only). Nothing was sent.');
    }
  });
  // In-page step links move keyboard focus to the section, not only the view.
  document.addEventListener('click', (event) => {
    const a = event.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target && target.tabIndex === -1) setTimeout(() => target.focus(), 0);
  });
  window.addEventListener('focus', () => refreshState().catch(() => show('offline-notice', true)));
}

wire();
refreshHealth();
refreshState().catch(() => {
  text('health-status', 'The dashboard state could not be loaded. Is the offline launcher still running?');
  show('offline-notice', true);
});
