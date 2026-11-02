// Opt-in bridge from the trusted portal to the EXPERIMENTAL embedded wallet
// (default-off, not security reviewed). portal.js imports this module only
// after the person explicitly chooses the embedded wallet; this module in turn
// loads the wallet UI, and the UI loads the SDK only on create/import/unlock.
// Everything is a local same-origin module; no CDN, no network work here.
//
// The portal receives only what the UI's public callbacks give it: public
// state (status, locked, address, network, evidence mode, error code) and the
// local provider object. The recovery phrase and password stay inside the
// wallet UI. Nothing here touches window.demos or the extension discovery
// events. Transactions and identity writes stay unavailable unless the portal
// passes the server's simulated-loopback profile as transactionTransport
// (rpcUrl is the server's same-origin relay; see src/portal/wallet-rpc.mjs).

// The SDK's own recovery-phrase check (validateMnemonic from demos-runtime.mjs)
// is required: without it importMnemonic, and so unlock, fails closed.
export async function sessionFactory({ approve, transactionTransport, anchorJournal }) {
  const [{ createSdkWalletSession }, { Demos, Identities, validateMnemonic }] = await Promise.all([
    import('./embedded-wallet/sdk-provider.mjs'),
    import('./embedded-wallet/demos-runtime.mjs'),
  ]);
  return createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, approve, transactionTransport, anchorJournal });
}

// Same choice as the standalone page: the ciphertext vault in this origin's
// IndexedDB when reachable, otherwise tab memory only.
async function chooseStore({ createIndexedDbVaultStore, createMemoryVaultStore }) {
  const store = createIndexedDbVaultStore();
  try {
    await store.get();
  } catch (error) {
    if (error?.code === 'storage_unavailable') return createMemoryVaultStore();
  }
  return store;
}

// Mounts the wallet UI into root. Returns the UI handle {ready, lock,
// getPublicState, destroy}. Callback failures never break the wallet.
// transactionTransport (optional): {profile:"simulated-loopback", rpcUrl,
// network, resolveGithubUser?} built by the portal from the server profile.
export async function openEmbeddedWallet(root, { onPublicState, onProviderReady, transactionTransport, anchorJournal } = {}) {
  const ui = await import('./embedded-wallet/ui.mjs');
  const vaultStore = await chooseStore(ui);
  const factory = transactionTransport ? ({ approve }) => sessionFactory({ approve, transactionTransport, anchorJournal }) : sessionFactory;
  return ui.mountEmbeddedWallet(root, { sessionFactory: factory, vaultStore, onPublicState, onProviderReady });
}
