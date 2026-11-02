import { createExtensionProbeAdapter } from './adapter.mjs';
import { MESSAGE_VECTORS, PROBE_NONCE, nativeVector, storageVector } from './vectors.mjs';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
// An honest SDK-based wallet adds gcr_edits and from_ed25519_address and
// replaces the fee values, all in one SDK fork format, so its ok:false must not
// read as a nonce rewrite.
const TRANSACTION_READINGS = Object.freeze({
  'no-field-diffs': 'Fields: unchanged.',
  'sdk-expected-only': 'Fields: only the verified changes an honest SDK-based wallet makes (adds the exact requested SDK gcr_edits and from_ed25519_address, replaces the transaction_fee values), so the hash differs too. Nonce, recipient and signer are unchanged; ok:false here is not a nonce rewrite. The fee values are not shown or bounded beyond the 10 DEM balance cap.',
  'nonce-recipient-or-signer-changed': 'Finding: the wallet changed the nonce, recipient or signing account. See nonceChanged, recipientChanged and signerChanged.',
  'other-unexpected-diffs': 'Finding: the wallet changed fields beyond the SDK\'s expected ones, or mixed pre-fork and post-fork SDK formats. See diffs and unexpected; unexpected state edits can change transaction effects.',
});
const SDK_FORMATS = Object.freeze({
  'pre-fork': ' Format: the SDK\'s pre-fork one, with amounts and fees as DEM numbers.',
  'post-fork': ' Format: the SDK\'s post-fork one, with amounts and fees as OS strings (P5\'s amount 0 becomes "0").',
});
const AMOUNT_REWRITE = ' The amount was rewritten, in value or in format (amountChanged).';
const PRE_FORK_P4_REWRITE = ' A pre-fork SDK wallet does this to P4: it cannot represent one OS and signs amount 0, with zero-amount transfer edits. That is an unexpected denomination rewrite, not an SDK-expected change.';
// vector: 'native' for P4, 'storage' for P5. Only pre-fork P4 gets the SDK cause.
const readTransaction = (vector) => (result) => {
  const summary = result?.diffSummary, reading = TRANSACTION_READINGS[summary?.reading] ?? '';
  const preForkP4 = vector === 'native' && summary?.sdkProfile === 'pre-fork';
  return reading + (summary?.reading === 'sdk-expected-only' ? SDK_FORMATS[summary.sdkProfile] ?? '' : '') + (summary?.amountChanged === true ? AMOUNT_REWRITE + (preForkP4 ? PRE_FORK_P4_REWRITE : '') : '');
};
export function mountProbe(root, { adapter = createExtensionProbeAdapter(), clipboard = navigator.clipboard } = {}) {
  let address = null, running = false;
  const buttons = [], status = el('p', { role: 'status' }), report = el('textarea', { readonly: true, rows: 16, 'aria-label': 'Public JSON probe report' });
  const refresh = () => { report.value = JSON.stringify(adapter.report(), null, 2); };
  const button = (label, action, describe) => {
    const node = el('button', { type: 'button', onclick: async () => {
      if (running) return;
      running = true; for (const b of buttons) b.disabled = true;
      status.textContent = 'Waiting for probe result. A timeout will never retry a request.';
      try { const result = await action(), text = JSON.stringify(result ?? { state: 'recorded' }); status.textContent = describe ? `${describe(result)} ${text}` : text; }
      catch { status.textContent = 'Probe failed. Inspect the public report. No request was retried.'; }
      finally { running = false; for (const b of buttons) b.disabled = false; refresh(); }
    } }, label);
    buttons.push(node); return node;
  };
  const field = (label, node) => el('label', {}, label, node);
  const ready = el('input', { type: 'checkbox' });
  const coordinates = () => {
    if (!ready.checked || !address) throw new Error('owner_readiness_required');
    return { from: address, nonce: PROBE_NONCE, timestamp: Date.now() };
  };
  const observations = el('select', {}, ...['approval-window', 'toolbar-popup', 'nothing-observed', 'origin-matches', 'origin-differs'].map((v) => el('option', { value: v }, v)));
  root.replaceChildren(
    el('section', { class: 'card' }, el('h2', {}, 'P1, P2 and P8 — discovery and approval UI'),
      el('p', {}, 'Use a disposable wallet. Import and unlock only inside the extension. Verify its RPC routing independently before connect or signing; this page cannot authenticate its network. Repeat on another owner-controlled origin to inspect site permissions.'),
      button('P1 Discover and read accounts', async () => { address = null; const found = await adapter.discover(); return found.state === 'present' ? adapter.accounts() : found; }),
      button('P2 / P8 Connect (approve or deny in wallet)', async () => { address = null; const result = await adapter.connect(); address = result.address; return result; }),
      button('P2 Sign before connect (deny in wallet)', async () => { if (address) throw new Error('reload_before_preconnect_probe'); return adapter.signMessage(MESSAGE_VECTORS[0]); }),
      button('P8 Request raw openpopup once', () => adapter.openPopup()), field('Observed extension UI / origin ', observations),
      button('Record UI observation', () => adapter.observeUi(observations.value))),
    el('section', { class: 'card' }, el('h2', {}, 'P3 — exact UTF-8 signatures'),
      el('p', {}, 'Connect first. Each button requests one harmless signature. A failure includes prefix, prehash, algorithm or account mismatch.'),
      ...MESSAGE_VECTORS.map((message, i) => el('div', {}, el('pre', {}, message), button(`P3 Sign vector ${i + 1}`, () => { if (!address) throw new Error('connect_first'); return adapter.signMessage(message); })))),
    el('section', { class: 'card' }, el('h2', {}, 'P4 and P5 — optional sign-only transactions'),
      el('p', {}, 'Only the already-used nonce 1 is requested. The wallet is asked to sign only if the plugin\'s chain reports that the connected account has used nonce 1 and holds at most 10 DEM, and the extension still reports that account just before signing. P4 signs one OS to the sender itself. P5 signs a storage CREATE of an unsigned ASCII fixture. All field changes are reported; verified SDK changes are counted separately from unexpected differences.'),
      el('p', {}, 'What can still happen: the page cannot control the extension. P4 risks one self-transfer plus fees. P5 risks a public storage-program create in the dacs3:agreement: namespace plus storage fees. If the extension switches accounts after the last account check, a short race before signing remains that the page cannot detect, and that other account\'s nonce and balance are never checked; keep only the probe key in the extension. A deposit landing between the balance read and signing is not detected.'),
      el('p', {}, 'Condition of use: this remaining risk is accepted on testnet only if the probe key is fresh, used nowhere else and holds at most 10 testnet DEM. Use a fresh key used nowhere else. The page cannot check that a key is fresh; that is your responsibility.'),
      field('I confirm: I independently verified testnet or loopback routing, and the connected account is a fresh key created only for this probe and used nowhere else, holding at most 10 testnet DEM. ', ready),
      button('P4 Sign native transfer only', async () => adapter.signTransaction(nativeVector(coordinates())), readTransaction('native')),
      button('P5 Sign storage CREATE only', async () => adapter.signTransaction(await storageVector(coordinates())), readTransaction('storage'))),
    el('section', { class: 'card' }, el('h2', {}, 'Public report'), status,
      el('p', {}, 'Kept in page memory only; reload clears it. Copy before reloading. Transaction reports contain only hashes, field paths and verification results; no transaction body or signature is retained. Timed-out provider calls fence this session; dismiss the wallet prompt before starting another manual session.'),
      report, button('Copy JSON report', async () => { refresh(); await clipboard.writeText(report.value); return { state: 'copied' }; })),
  );
  refresh();
  return { refresh };
}
if (typeof document !== 'undefined' && document.getElementById('probe-root')) mountProbe(document.getElementById('probe-root'));
