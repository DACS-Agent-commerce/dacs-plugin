# Embedded wallet UI (experimental, default-off)

An extension-free browser wallet UI for plugin 0.1.0 phase 1. It is
**experimental, local-only and default-off**. It is not security reviewed. The external security review is on hold.
It has not been checked against a real ChatGPT host, an installed wallet or a
live network, and it does not send live transactions. The existing portal
(`public/portal/index.html`, `portal.js`) and its Demos extension flow are
unchanged.

The UI owns local wallet state and user consent. The SDK seam (`sdk-provider.mjs`,
`demos-runtime.mjs`, documented in
`EMBEDDED-WALLET-SDK.md`) owns key generation, import and signing. This UI
does not implement or mock them.

## Files

All live in `public/portal/embedded-wallet/`. The current
`/portal/assets` static route serves them, so the page is at
`/portal/assets/embedded-wallet/index.html`.

| File | Role |
| --- | --- |
| `ui.mjs` | `mountEmbeddedWallet(root, options)`; re-exports the two stores |
| `vault.mjs` | Password-encrypted vault record and backup format (Web Crypto) |
| `stores.mjs` | `createMemoryVaultStore()`, optional `createIndexedDbVaultStore()` |
| `approval.mjs` | Explicit approval dialog (`createApprovalController`, `describeRequest`) |
| `dom.mjs` | `el`/`uniqueId` helpers (text nodes only, no inline styles) |
| `main.mjs` | Standalone bootstrap used by `index.html` |
| `index.html`, `embedded-wallet.css` | Standalone page; uses `../portal.css` as its base |
| `sdk-provider.mjs`, `demos-runtime.mjs` | **SDK seam files. Not part of this UI module.** |

`index.html` contains no inline script or style, so the portal CSP
(`script-src 'self'; style-src 'self'`) holds. It loads `./main.mjs`. That module
imports `./ui.mjs` and `./stores.mjs` statically, and dynamically imports
`./sdk-provider.mjs` and `./demos-runtime.mjs` on the first create, import or
unlock. If the SDK bundle is missing, the page still renders and shows "The
wallet SDK could not be loaded on this page."

## UI API

```js
import { mountEmbeddedWallet, createMemoryVaultStore } from './ui.mjs';

const wallet = mountEmbeddedWallet(rootElement, {
  sessionFactory,       // required: async ({ approve }) => SDK session
  vaultStore,           // optional: defaults to createMemoryVaultStore()
  onPublicState,        // optional: (state) => void
  onProviderReady,      // optional: (provider) => void
});
await wallet.ready;     // initial vault lookup finished
wallet.getPublicState();
wallet.lock();
wallet.destroy();
```

`mountEmbeddedWallet` returns synchronously, so `await mountEmbeddedWallet(...)`
also works. `ready` resolves once the status is `uninitialized` or `locked`.

### sessionFactory

`sessionFactory` is called with `{ approve }`, once per create, import or
unlock. It must resolve to the SDK seam session, which needs `create`,
`importMnemonic`, `exportMnemonicForUser`, `request` and `lock`. The standalone
bootstrap does:

```js
const [{ createSdkWalletSession }, { Demos, Identities }] =
  await Promise.all([import('./sdk-provider.mjs'), import('./demos-runtime.mjs')]);
return createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, approve });
```

It passes no `transactionTransport`, so sendTransaction and identity writes stay
unavailable, as the contract requires. A test harness can inject a fresh
loopback transport through its own factory.

**About `approve(request)`.** It resolves `true` only after a trusted click on
**Approve** in the dialog. It resolves `false` in all other cases: Reject,
Escape, a 5-minute timeout, a second concurrent request, a lock, a session that
is not the current unlocked one, or a scripted `click()` (`isTrusted === false`).
The UI accepts these request shapes:

- a bare message string, treated as `sign`;
- `{ method, params, purpose?, message?, content? }`.

The dialog shows the purpose and the method, followed by the exact content. For
`sign` that content is `message` or `params[0]`. For anything else it is
`content` or `params`, pretty-printed as JSON. **Seam assumption:** the SDK
agent's actual `approve` argument shape is not visible in this checkout. The
integrator must confirm it matches one of these shapes.

### Vault store interface

The interface is `{ kind, get(): Promise<record|null>, put(record), delete() }`,
with one slot. Every `put` and `get` passes through `assertVaultRecord`. That
function keeps only the known public and ciphertext fields, so a plaintext field
cannot reach storage.

- `createMemoryVaultStore(initial?)` keeps the record in tab memory only. Tests
  use it, and it is the fallback when storage is unavailable.
- `createIndexedDbVaultStore({ dbName?, indexedDB? })` is optional and stores
  ciphertext only, in the origin's IndexedDB. **It is not durable.** It can be
  cleared or never persisted in private windows, under storage pressure, when
  the user clears site data, or in partitioned or sandboxed embedded frames
  such as a ChatGPT iframe. It is also not synced across devices or ChatGPT
  sessions.
- The **exported encrypted backup file** is the only portable recovery path,
  apart from the recovery phrase itself. Re-importing a backup restores it on
  this origin; it does not promise cross-device persistence.

`index.html` picks the store through `data-vault-store="indexeddb"` on
`#embedded-wallet`. Any other value means memory only. If IndexedDB cannot be
opened, the page falls back to memory and the storage note says so.

### onPublicState

Called with a frozen object containing only:

```js
{ status: 'loading'|'uninitialized'|'locked'|'unlocked',
  locked: boolean,
  address: string|null,        // only while unlocked
  network: string|null,        // only while unlocked, e.g. 'unconfigured'
  evidenceMode: string|null,   // only while unlocked, e.g. 'local-key-only'
  error: string|null }         // fixed code, e.g. 'wrong_password_or_corrupt'
```

Error codes come from a fixed list in `ui.mjs`. Raw SDK and storage messages are
never displayed or published, because they could echo user input. While the
wallet is locked, the address is `null` in public state; locally the page still
shows the stored address. A callback that throws does not break the wallet.

### onProviderReady

Called on each transition to `unlocked`, always with the same frozen local
object:

```js
{ isDacsEmbeddedWallet: true, experimental: true, isLocked(), request({ method, params }) }
```

`request` forwards `{method, params}` to the live SDK session and returns its
`{success, data, error}` envelope. While locked, it returns
`{success:false, error:{code:'locked'}}`. If the SDK call throws, it returns
`{success:false, error:{code:'wallet_error'}}`. Nothing on the provider can
reach `exportMnemonicForUser`. The UI never assigns `window.demos`, never
listens to or dispatches `demosRequestProvider`/`demosAnnounceProvider`, and
never posts to a parent frame.

## States and behavior

- **Initial state**: `loading`, which becomes `locked` if a vault record exists
  and `uninitialized` otherwise. No SDK session exists and nothing is unlocked.
  The notice at the top always reads "Experimental · local-only · no live
  transactions", says the wallet is not security reviewed, and says the phrase
  and password never leave the page. It also says the Demos extension keeps
  working as before.
- **Create**: the user enters a password (at least 12 characters) and repeats
  it. The UI calls `session.create({strength: 256})` and
  `exportMnemonicForUser()`, encrypts the result and saves the vault, and only
  then shows the words. That ordering means a page close cannot lose an
  unsaved wallet. The words appear in a numbered list with a backup warning
  ("Anyone who has these words controls this wallet… DACS will never ask for
  them") and the button "I have written it down. Hide it".
- **Import**: the user enters the recovery phrase in a textarea with
  autocomplete, autocorrect and spellcheck off, plus a password. The phrase
  is normalized (trimmed, lowercased, single spaces) and passed to
  `importMnemonic`. The field is cleared on success, and on lock.
- **Restore backup**: the user picks a file or pastes text.
  `parseBackup` validates it (size, format and KDF bounds) and stores it, and
  the wallet becomes `locked`. The backup's password is then needed to unlock.
- **Unlock**: the UI decrypts the vault and passes the phrase to a new session's
  `importMnemonic`. The resulting address must equal the stored address,
  otherwise it reports `address_mismatch` and nothing unlocks. The password
  field is cleared on every attempt.
- **Show recovery phrase** (unlocked only): the password must be re-entered,
  which is proven by decrypting the vault. The words come from
  `session.exportMnemonicForUser()`.
- **Export encrypted backup** works while locked or unlocked, because the backup
  is ciphertext. It offers a `blob:` download link (revoked on re-render) and a
  read-only textarea to copy, for frames where downloads are blocked.
- **Forget wallet on this device**: requires a confirmation checkbox, locks the
  wallet, and deletes the stored record.
- **Lock** comes from the button, `wallet.lock()`, `pagehide` or `destroy()`. It
  cancels any open approval (resolving `false`), calls `session.lock()`, drops
  the session reference, clears every `[data-sensitive]` field and the phrase
  list, and makes any in-flight create, import or unlock discard its result
  (`interrupted`). JavaScript strings cannot be zeroed. "Cleared" means
  references are dropped and fields emptied; the memory is reclaimed later by
  garbage collection.
- **Busy/accessibility**: `aria-busy` is set on the root and controls are
  disabled while busy. There is a `role="status"` live line, a `role="alert"`
  error line, and labelled inputs with hints linked through `aria-describedby`.
  The `h2` of each new state receives focus. The approval is a native
  `<dialog>` with `aria-labelledby` and `aria-describedby`, and Reject has
  focus first. No inline styles are used.

## Cryptography (standard primitives only)

`vault.mjs` uses only Web Crypto. Key derivation is **PBKDF2-HMAC-SHA-256 with
600,000 iterations** and a random 16-byte salt, producing an **AES-GCM-256**
key. Encryption uses a random 12-byte IV and a 128-bit tag. The
additional authenticated data is the JSON of the public header: format,
version, address, publicKey, KDF name, hash, iterations and salt, cipher and IV.
Changing the address or weakening the KDF in a record therefore makes
decryption fail. The plaintext is `{"mnemonic": …}`, and plaintext byte buffers
are zero-filled after use. Passwords are NFC-normalized and never trimmed.
Imported records must use between 100,000 and 5,000,000 iterations and fit size
limits. The vault record and the backup file share one format:

```json
{ "notice": "…", "format": "dacs-embedded-wallet-vault", "version": 1,
  "address": "0x…64hex", "publicKey": "…64hex",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
  "cipher": { "name": "AES-GCM", "iv": "<b64>" },
  "ciphertext": "<b64>", "createdAt": "<ISO>" }
```

Web Crypto requires a secure context (https or localhost). Without one, the UI
reports `crypto_unavailable`.

## Integration (not done in this module)

1. Combine this output with `sdk-provider.mjs` and
   `demos-runtime.mjs` in the same directory, then run the
   contract and browser tests. Until that combination exists, real wallet and
   browser integration is **BLOCKED**, not passed.
2. Confirm the SDK's `approve(request)` argument shape matches `describeRequest`
   (see above). Also confirm that `exportMnemonicForUser` returns a
   space-separated phrase string.
3. Choose whether the standalone page keeps `data-vault-store="indexeddb"` or
   switches to memory only. Either way, keep the backup warning.
4. Embedding inside ChatGPT is a separate gate. The portal router currently
   sends `frame-ancestors 'none'` and `cross-origin-opener-policy: same-origin`,
   so this page cannot be framed as-is. Changing that needs the host gate and is not
   part of this phase.
5. If the main portal later offers this wallet as an alternative to the
   extension, wire it in additively. Pass `onProviderReady` into the existing
   `provider` variable only when the user picks the embedded wallet, and keep
   extension discovery unchanged. Forward only `onPublicState` fields to any
   host.

## Not claimed

The following are not claimed: security approval, real SDK compatibility
(unverified in this checkout), installed-wallet compatibility, ChatGPT
embedding or installation, live, funded or testnet transactions, durability of
browser storage, v0.1 acceptance, or a v0.2 bump.
