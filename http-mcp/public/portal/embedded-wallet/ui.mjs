// EXPERIMENTAL extension-free embedded Demos wallet UI (default-off; not
// security reviewed). Key generation, import and signing happen in the SDK
// session returned by sessionFactory (sdk-provider.mjs); this module only
// handles the local states (loading, uninitialized, locked, unlocked), the
// password-encrypted vault, encrypted backup export/import and explicit
// approvals.
//
// The recovery phrase and password exist only in this page: in the deliberate
// create/import/backup forms and in memory while needed. They are never put in
// public state, provider responses, storage (plaintext), URLs, network
// requests or parent/host messages. Locking discards the live SDK session and
// clears every sensitive field. JavaScript cannot zero strings, so "cleared"
// means references are dropped and fields emptied; the garbage collector
// reclaims the memory later.
//
// This module never touches window.demos or the extension discovery events,
// so an installed Demos wallet extension keeps working as before.
import { checkPassword, decryptVault, encryptVault, parseBackup, serializeBackup, VaultError, MIN_PASSWORD_LENGTH } from './vault.mjs';
import { createMemoryVaultStore } from './stores.mjs';
import { createApprovalController } from './approval.mjs';
import { el, uniqueId } from './dom.mjs';

export { createMemoryVaultStore, createIndexedDbVaultStore } from './stores.mjs';

const ADDRESS = /^0x[0-9a-f]{64}$/;
const PUBLIC_KEY = /^[0-9a-f]{64}$/;
const SESSION_METHODS = ['create', 'importMnemonic', 'exportMnemonicForUser', 'request', 'lock'];

// Fixed local texts. Public state carries only the code. Raw SDK or storage
// error messages are never shown or forwarded, because they could echo user
// input such as recovery words.
const ERRORS = {
  weak_password: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  password_mismatch: 'The two passwords do not match.',
  wrong_password_or_corrupt: 'Wrong password, or the stored wallet is damaged.',
  invalid_backup: 'That is not a valid encrypted wallet backup from this page.',
  storage_unavailable: 'Browser storage is unavailable here. Export an encrypted backup to keep this wallet.',
  crypto_unavailable: 'This page has no Web Crypto (a secure https or localhost page is required).',
  session_unavailable: 'The wallet SDK could not be loaded on this page.',
  invalid_account: 'The wallet SDK returned an unexpected account.',
  create_failed: 'Could not create a wallet.',
  import_failed: 'Could not import that recovery phrase. Check the words and their order.',
  unlock_failed: 'Could not unlock the wallet.',
  address_mismatch: 'The decrypted wallet does not match the stored address. Nothing was unlocked.',
  vault_exists: 'A wallet is already stored on this device. Back it up and forget it first.',
  no_vault: 'No wallet is stored on this device.',
  confirm_required: 'Tick the confirmation box first.',
  export_failed: 'Could not export the encrypted backup.',
  restore_failed: 'Could not restore the encrypted backup.',
  reveal_failed: 'Could not show the recovery phrase.',
  forget_failed: 'Could not remove the stored wallet.',
  interrupted: 'The wallet was locked before that finished. Nothing was changed.',
};

const STATUS_TEXT = {
  loading: 'Checking this device for a stored wallet…',
  uninitialized: 'No wallet on this device yet.',
  locked: 'Locked. Enter your password to unlock.',
  unlocked: 'Unlocked. Lock the wallet when you are done.',
};

const STORAGE_TEXT = {
  memory: 'Storage: this tab’s memory only. Closing or reloading the page erases the wallet unless you export an encrypted backup.',
  indexeddb: 'Storage: encrypted, in this browser’s storage for this site only. Browsers, private windows and embedded frames (such as ChatGPT) can clear it at any time, and it is not synced to other devices or ChatGPT sessions. Export an encrypted backup to keep it.',
  custom: 'Storage: encrypted vault provided by the host page. Export an encrypted backup to keep it.',
};

class UiError extends Error {
  constructor(code) {
    super(ERRORS[code] ?? code);
    this.code = code;
  }
}

const errorCode = (error, fallback) => ((error instanceof VaultError || error instanceof UiError) && ERRORS[error.code] ? error.code : fallback);

const providerError = (code, message) => ({ success: false, data: null, error: { code, message } });

function publicAccount(value) {
  if (!ADDRESS.test(value?.address ?? '') || !PUBLIC_KEY.test(value?.publicKey ?? '')) throw new UiError('invalid_account');
  return Object.freeze({
    address: value.address,
    publicKey: value.publicKey,
    network: typeof value.network === 'string' ? value.network : 'unconfigured',
    evidenceMode: typeof value.evidenceMode === 'string' ? value.evidenceMode : 'local-key-only',
  });
}

const normalizePhrase = (text) => String(text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');

function passwordField(label, autocomplete, hint) {
  const hintId = hint ? uniqueId('ew-hint') : null;
  const input = el('input', { type: 'password', autocomplete, required: true, 'data-sensitive': true, 'aria-describedby': hintId });
  const wrap = el('div', { class: 'ew-field' }, el('label', {}, label, input), hint ? el('p', { id: hintId, class: 'ew-muted ew-hint' }, hint) : null);
  return { wrap, input };
}

export function mountEmbeddedWallet(root, { sessionFactory, vaultStore = createMemoryVaultStore(), onPublicState, onProviderReady } = {}) {
  if (!root || typeof root.append !== 'function') throw new TypeError('mountEmbeddedWallet needs a root element');
  if (typeof sessionFactory !== 'function') throw new TypeError('sessionFactory must be an async function returning an SDK wallet session');

  let status = 'loading';
  let hasVault = false;
  let storedAddress = null; // public, shown locally only
  let live = null; // { session, account, ticket } while unlocked
  let busy = false;
  let error = null;
  let epoch = 0; // bumped by lock(); async work started earlier is discarded
  let destroyed = false;
  let phrase = null; // { words, justCreated } only while deliberately shown
  let backupUrl = null;

  const notice = el('section', { class: 'ew-notice', role: 'note', 'aria-label': 'Experimental wallet notice' },
    el('p', {}, el('strong', {}, 'Experimental · local-only · no live transactions.')),
    el('p', {}, 'This wallet runs only inside this browser page and has not been security reviewed. It does not connect to the Demos network or send transactions on its own. Nothing here is a live or funded transaction.'),
    el('p', {}, 'Your recovery phrase and password never leave this page. They are not sent to ChatGPT, to an AI model or to any server.'),
    el('p', { class: 'ew-muted' }, 'Already use the Demos wallet extension? It keeps working as before. This embedded wallet does not replace or intercept it.'),
  );
  const statusLine = el('p', { class: 'ew-status', role: 'status', 'aria-live': 'polite' });
  const errorLine = el('p', { class: 'ew-error', role: 'alert', hidden: true });
  const panel = el('div', { class: 'ew-panel' });
  const storageNote = el('p', { class: 'ew-muted ew-storage' }, STORAGE_TEXT[vaultStore?.kind] ?? STORAGE_TEXT.custom);
  root.classList.add('ew-root');
  root.replaceChildren(notice, statusLine, errorLine, panel, storageNote);
  const approvals = createApprovalController(root);

  // ---------------- public state and provider ----------------
  const getPublicState = () => Object.freeze({
    status,
    locked: !live,
    address: live ? live.account.address : null,
    network: live ? live.account.network : null,
    evidenceMode: live ? live.account.evidenceMode : null,
    error,
  });

  function publish() {
    root.dataset.walletState = status;
    statusLine.textContent = STATUS_TEXT[status];
    if (typeof onPublicState !== 'function') return;
    try {
      onPublicState(getPublicState());
    } catch {
      // A failing host callback must not break the wallet.
    }
  }

  // Local object for this page only. It exposes request() and nothing that
  // can reach the recovery phrase.
  const provider = Object.freeze({
    isDacsEmbeddedWallet: true,
    experimental: true,
    isLocked: () => !live,
    // Public: the writes the unlocked session can perform, or null.
    writeProfile: () => {
      try {
        return live?.session.getWriteProfile?.() ?? null;
      } catch {
        return null;
      }
    },
    async request(args) {
      const current = live;
      if (!current) return providerError('locked', 'The embedded wallet is locked.');
      const method = args?.method;
      if (typeof method !== 'string' || !method) return providerError('invalid_request', 'method is required');
      try {
        return await current.session.request({ method, params: args.params });
      } catch {
        return providerError('wallet_error', 'The embedded wallet could not complete this request.');
      }
    },
  });

  // ---------------- session lifecycle ----------------
  async function openSession() {
    const ticket = {};
    // Approvals reach the dialog only while this exact session is unlocked.
    const approve = (request) => (live?.ticket === ticket && !destroyed ? approvals.approve(request) : Promise.resolve(false));
    let session;
    try {
      session = await sessionFactory({ approve });
    } catch {
      throw new UiError('session_unavailable');
    }
    if (!SESSION_METHODS.every((name) => typeof session?.[name] === 'function')) throw new UiError('session_unavailable');
    return { session, ticket };
  }

  const discard = (session) => {
    try {
      session?.lock();
    } catch {
      // already unusable
    }
  };

  function activate(started, { session, ticket }, account, shownPhrase = null) {
    if (started !== epoch || destroyed) throw new UiError('interrupted');
    live = { session, ticket, account };
    hasVault = true;
    storedAddress = account.address;
    phrase = shownPhrase;
    status = 'unlocked';
    render({ focus: true });
    publish();
    if (typeof onProviderReady !== 'function') return;
    try {
      onProviderReady(provider);
    } catch {
      // A failing host callback must not break the wallet.
    }
  }

  function scrub() {
    for (const node of root.querySelectorAll('[data-sensitive]')) {
      if ('value' in node) node.value = '';
      else node.replaceChildren();
    }
  }

  function lock() {
    epoch += 1;
    approvals.cancel();
    const session = live?.session;
    live = null;
    phrase = null;
    discard(session);
    scrub();
    if (status !== 'loading') status = hasVault ? 'locked' : 'uninitialized';
    render({ focus: status !== 'loading' });
    publish();
  }

  // Store, then show: the encrypted vault is saved before the new phrase is
  // displayed, so nothing is lost if the page closes while it is on screen.
  async function saveNewWallet(started, opened, account, password) {
    const mnemonic = await opened.session.exportMnemonicForUser();
    const record = await encryptVault({ mnemonic, password, account });
    if (started !== epoch) throw new UiError('interrupted');
    if (await vaultStore.get()) throw new UiError('vault_exists');
    await vaultStore.put(record);
    return mnemonic;
  }

  // ---------------- busy / error ----------------
  function setBusy(value) {
    busy = value;
    root.setAttribute('aria-busy', String(value));
    for (const control of panel.querySelectorAll('button, input, textarea')) control.disabled = value;
  }

  function setError(code) {
    if (code === error) return;
    error = code;
    errorLine.hidden = !code;
    errorLine.textContent = code ? ERRORS[code] ?? '' : '';
    publish();
  }

  const run = (fallback, fn) => async (event) => {
    event?.preventDefault?.();
    if (busy || destroyed) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (failure) {
      setError(errorCode(failure, fallback));
    } finally {
      setBusy(false);
    }
  };

  // ---------------- views ----------------
  const heading = (text) => el('h2', { tabindex: '-1' }, text);
  const form = (onsubmit, ...children) => el('form', { novalidate: true, onsubmit }, ...children);

  function backupSection() {
    const output = el('textarea', { readonly: true, rows: '6', hidden: true, 'aria-label': 'Encrypted backup text (copy and keep it safe)', class: 'ew-backup-text' });
    const links = el('p', { class: 'ew-download' });
    const exportButton = el('button', { type: 'button' }, 'Export encrypted backup');
    exportButton.addEventListener('click', run('export_failed', async () => {
      const record = await vaultStore.get();
      if (!record) throw new UiError('no_vault');
      const text = serializeBackup(record);
      output.value = text;
      output.hidden = false;
      revokeBackupUrl();
      backupUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      links.replaceChildren(el('a', { href: backupUrl, download: `dacs-embedded-wallet-backup-${record.address.slice(2, 10)}.json` }, 'Download encrypted backup file'), ' or copy the text below.');
    }));
    return el('section', { class: 'ew-section' },
      el('h3', {}, 'Encrypted backup'),
      el('p', { class: 'ew-warn' }, 'Keep an encrypted backup somewhere safe, away from this device. It is your recovery path: storage on this page can be cleared at any time, and this wallet is not synced to other devices or ChatGPT sessions.'),
      el('p', { class: 'ew-muted' }, 'The backup file is encrypted with your password and is useless without it. The password cannot be reset, so keep it too. Your recovery phrase restores the wallet even without the password.'),
      exportButton, links, output,
    );
  }

  function forgetSection() {
    const id = uniqueId('ew-forget');
    const confirm = el('input', { type: 'checkbox', id });
    const button = el('button', { type: 'button', class: 'ew-danger' }, 'Forget wallet on this device');
    button.addEventListener('click', run('forget_failed', async () => {
      if (!confirm.checked) throw new UiError('confirm_required');
      lock();
      await vaultStore.delete();
      hasVault = false;
      storedAddress = null;
      status = 'uninitialized';
      render({ focus: true });
      publish();
    }));
    return el('section', { class: 'ew-section' },
      el('h3', {}, 'Forget this wallet'),
      el('p', { class: 'ew-muted' }, 'Removes the encrypted wallet from this device. Without your recovery phrase or an encrypted backup and its password, it cannot be recovered.'),
      el('p', {}, confirm, ' ', el('label', { for: id }, 'I have my recovery phrase or an encrypted backup with its password, or I no longer need this wallet.')),
      button,
    );
  }

  function setupView() {
    const create = { pw: passwordField('Password', 'new-password', `At least ${MIN_PASSWORD_LENGTH} characters. It encrypts the wallet on this device and cannot be reset.`), confirm: passwordField('Repeat password', 'new-password') };
    const createForm = form(run('create_failed', async () => {
      const password = create.pw.input.value;
      checkPassword(password, create.confirm.input.value);
      if (await vaultStore.get()) throw new UiError('vault_exists');
      const started = epoch;
      const opened = await openSession();
      try {
        const account = publicAccount(await opened.session.create({ strength: 256 }));
        const mnemonic = await saveNewWallet(started, opened, account, password);
        activate(started, opened, account, { words: mnemonic.split(/\s+/), justCreated: true });
      } catch (failure) {
        discard(opened.session);
        throw failure;
      }
    }),
      el('h3', {}, 'Create a new wallet'),
      el('p', { class: 'ew-muted' }, 'Choose a password to encrypt the wallet on this device. Your new recovery phrase is shown right after creation, for you to write down.'),
      create.pw.wrap, create.confirm.wrap,
      el('button', { type: 'submit', class: 'ew-primary' }, 'Create wallet'),
    );

    const phraseId = uniqueId('ew-phrase');
    const phraseInput = el('textarea', { id: phraseId, rows: '3', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, 'data-sensitive': true });
    const imp = { pw: passwordField('Password', 'new-password', `At least ${MIN_PASSWORD_LENGTH} characters, to encrypt the wallet on this device.`), confirm: passwordField('Repeat password', 'new-password') };
    const importForm = form(run('import_failed', async () => {
      const password = imp.pw.input.value;
      checkPassword(password, imp.confirm.input.value);
      if (await vaultStore.get()) throw new UiError('vault_exists');
      const started = epoch;
      const opened = await openSession();
      try {
        const account = publicAccount(await opened.session.importMnemonic(normalizePhrase(phraseInput.value)));
        phraseInput.value = '';
        await saveNewWallet(started, opened, account, password);
        activate(started, opened, account);
      } catch (failure) {
        discard(opened.session);
        throw failure;
      }
    }),
      el('h3', {}, 'Import a recovery phrase'),
      el('p', { class: 'ew-muted' }, 'Type your existing recovery phrase. It stays in this page and is stored only encrypted with your password.'),
      el('div', { class: 'ew-field' }, el('label', { for: phraseId }, 'Recovery phrase (words separated by spaces)'), phraseInput),
      imp.pw.wrap, imp.confirm.wrap,
      el('button', { type: 'submit' }, 'Import wallet'),
    );

    const fileId = uniqueId('ew-file');
    const fileInput = el('input', { type: 'file', id: fileId, accept: '.json,application/json' });
    const textId = uniqueId('ew-restore');
    const textInput = el('textarea', { id: textId, rows: '4', autocomplete: 'off', spellcheck: 'false' });
    const restoreForm = form(run('restore_failed', async () => {
      const file = fileInput.files?.[0];
      const record = parseBackup(file ? await file.text() : textInput.value);
      if (await vaultStore.get()) throw new UiError('vault_exists');
      await vaultStore.put(record);
      hasVault = true;
      storedAddress = record.address;
      status = 'locked';
      render({ focus: true });
      publish();
    }),
      el('h3', {}, 'Restore an encrypted backup'),
      el('p', { class: 'ew-muted' }, 'Choose a backup file exported from this page, or paste its text. You need the backup’s password to unlock it.'),
      el('div', { class: 'ew-field' }, el('label', { for: fileId }, 'Backup file'), fileInput),
      el('div', { class: 'ew-field' }, el('label', { for: textId }, 'Or paste backup text'), textInput),
      el('button', { type: 'submit' }, 'Restore backup'),
    );

    return [
      heading('Set up the experimental wallet'),
      el('p', {}, 'No wallet is stored on this device. Create a new one, import a recovery phrase you already have, or restore an encrypted backup file.'),
      el('section', { class: 'ew-section' }, createForm),
      el('section', { class: 'ew-section' }, importForm),
      el('section', { class: 'ew-section' }, restoreForm),
    ];
  }

  function lockedView() {
    const pw = passwordField('Password', 'current-password');
    const unlockForm = form(run('unlock_failed', async () => {
      const password = pw.input.value;
      pw.input.value = '';
      const record = await vaultStore.get();
      if (!record) {
        hasVault = false;
        status = 'uninitialized';
        render({ focus: true });
        publish();
        throw new UiError('no_vault');
      }
      const started = epoch;
      let { mnemonic } = await decryptVault(record, password);
      const opened = await openSession();
      try {
        const account = publicAccount(await opened.session.importMnemonic(mnemonic));
        mnemonic = null;
        if (account.address !== record.address) throw new UiError('address_mismatch');
        activate(started, opened, account);
      } catch (failure) {
        discard(opened.session);
        throw failure;
      }
    }),
      pw.wrap,
      el('button', { type: 'submit', class: 'ew-primary' }, 'Unlock'),
    );
    return [
      heading('Wallet locked'),
      el('p', {}, 'An encrypted wallet is stored on this device. Unlocking decrypts it in this page only.'),
      storedAddress ? el('dl', {}, el('dt', {}, 'Stored address'), el('dd', {}, storedAddress)) : null,
      unlockForm,
      backupSection(),
      forgetSection(),
    ];
  }

  function phraseSection() {
    if (phrase) {
      const hide = el('button', { type: 'button' }, phrase.justCreated ? 'I have written it down. Hide it' : 'Hide recovery phrase');
      hide.addEventListener('click', () => {
        phrase = null;
        scrub();
        render({ focus: true });
      });
      return el('section', { class: 'ew-section ew-phrase', 'aria-label': 'Recovery phrase' },
        el('h3', {}, phrase.justCreated ? 'Write down your new recovery phrase' : 'Your recovery phrase'),
        el('p', { class: 'ew-warn' }, 'Anyone who has these words controls this wallet. Write them down in order, on paper, and keep them offline. Never paste them into ChatGPT, a chat, a website or an email. DACS will never ask for them.'),
        el('ol', { class: 'ew-words', 'data-sensitive': true }, ...phrase.words.map((word) => el('li', {}, word))),
        el('p', { class: 'ew-muted' }, 'This phrase restores the wallet on any device without a password. It is shown only here, on your request.'),
        hide,
      );
    }
    const pw = passwordField('Password', 'current-password');
    const reveal = form(run('reveal_failed', async () => {
      const password = pw.input.value;
      pw.input.value = '';
      const record = await vaultStore.get();
      if (!record) throw new UiError('no_vault');
      await decryptVault(record, password); // proves the password; result dropped
      const current = live;
      if (!current) throw new UiError('interrupted');
      const mnemonic = await current.session.exportMnemonicForUser();
      if (live !== current) throw new UiError('interrupted');
      phrase = { words: String(mnemonic).split(/\s+/), justCreated: false };
      render({ focus: true });
    }),
      el('h3', {}, 'Recovery phrase'),
      el('p', { class: 'ew-muted' }, 'Enter your password to show the recovery phrase on this screen. Make sure nobody can see your screen.'),
      pw.wrap,
      el('button', { type: 'submit' }, 'Show recovery phrase'),
    );
    return el('section', { class: 'ew-section' }, reveal);
  }

  function unlockedView() {
    const { account } = live;
    const lockButton = el('button', { type: 'button', class: 'ew-primary' }, 'Lock wallet');
    lockButton.addEventListener('click', () => lock());
    return [
      heading('Wallet unlocked'),
      el('dl', {},
        el('dt', {}, 'Address'), el('dd', {}, account.address),
        el('dt', {}, 'Public key'), el('dd', {}, account.publicKey),
        el('dt', {}, 'Network'), el('dd', {}, account.network === 'unconfigured' ? 'not configured (local key only)' : account.network),
        el('dt', {}, 'Evidence'), el('dd', {}, account.evidenceMode),
      ),
      el('p', { class: 'ew-muted' }, 'Requests to sign show an approval dialog here with the exact content. Nothing is signed or sent without your click.'),
      account.evidenceMode === 'simulated-fixture'
        ? el('p', { class: 'ew-warn' }, 'SIMULATED: this page is configured with a local fixture chain. Approved payments, listing publications and identity changes go only to that fixture, never to the live Demos testnet, and involve no real funds.')
        : null,
      account.evidenceMode === 'testnet-held-no-writes'
        ? el('p', { class: 'ew-warn' }, 'HELD: this page names a Demos testnet, but testnet writes from this wallet are held. The external security review is on hold. No transaction is signed for or sent to the testnet from here.')
        : null,
      lockButton,
      phraseSection(),
      backupSection(),
      forgetSection(),
    ];
  }

  function revokeBackupUrl() {
    if (backupUrl) URL.revokeObjectURL(backupUrl);
    backupUrl = null;
  }

  function render({ focus = false } = {}) {
    if (destroyed) return;
    revokeBackupUrl();
    scrub();
    const views = { loading: () => [el('p', { class: 'ew-muted' }, STATUS_TEXT.loading)], uninitialized: setupView, locked: lockedView, unlocked: unlockedView };
    panel.replaceChildren(...views[status]().filter(Boolean));
    if (busy) setBusy(true);
    if (focus) panel.querySelector('h2')?.focus();
  }

  // ---------------- boot ----------------
  const onPageHide = () => {
    if (live) lock();
  };
  globalThis.addEventListener?.('pagehide', onPageHide);

  render();
  publish();
  const ready = (async () => {
    try {
      const record = await vaultStore.get();
      hasVault = Boolean(record);
      storedAddress = record?.address ?? null;
    } catch (failure) {
      hasVault = false;
      error = errorCode(failure, 'storage_unavailable');
      errorLine.hidden = false;
      errorLine.textContent = ERRORS[error];
    }
    if (destroyed) return;
    status = hasVault ? 'locked' : 'uninitialized';
    render();
    publish();
  })();

  function destroy() {
    if (destroyed) return;
    lock();
    destroyed = true;
    revokeBackupUrl();
    globalThis.removeEventListener?.('pagehide', onPageHide);
    root.replaceChildren();
    root.classList.remove('ew-root');
  }

  return { ready, lock: () => lock(), getPublicState, destroy };
}
