// Portal entry for the one Start approval (DACS_INTENT_APPROVAL=on only; the
// server mounts /portal/assets/intent/ only then). portal.js loads it on
// purchase pages when the person picks the embedded wallet.
//
// openEmbeddedWallet is embedded-wallet-bridge.mjs's, with two additions: each
// SDK session's approve() goes through its own intent gate (gate.mjs), and its
// SDK class is the gate's fenced one (gate.fenceSdk, passed through the
// bridge's switch-on hook in src/portal/intent-hooks.mjs). Without
// an active Start the gate passes every request to the normal dialog, so
// sign-in, linking and payment approvals are unchanged. Wallet extensions and
// other signers never reach this module: portal.js keeps their per-step flow.
import { createIntentGate } from './gate.mjs';
import { intentProfile } from './intent.mjs';
import { createSignatureJournal } from './signature-journal.mjs';
import { runStart } from './start-flow.mjs';

const claimSignature = createSignatureJournal();
let gate = null; // the gate of the newest embedded wallet session
let sourcePhaseFence = false; // the session module carries the switch-on hook
let durable = false; // the signature journal's storage opened
// Other tabs of this origin: a Start opened in one ends any Start for the
// same wallet in the others (gate.mjs peerStarted).
const CHANNEL = 'dacs-chatgpt-plugin/start-intent';
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
tabs?.unref?.(); // Node verification must be able to exit; browsers keep their channel.
if (tabs) tabs.onmessage = (event) => gate?.peerStarted(event.data);
const announce = (message) => tabs?.postMessage(message);

async function chooseStore({ createIndexedDbVaultStore, createMemoryVaultStore }) {
  const store = createIndexedDbVaultStore();
  try {
    await store.get();
  } catch (error) {
    if (error?.code === 'storage_unavailable') return createMemoryVaultStore();
  }
  return store;
}

export async function openEmbeddedWallet(root, { onPublicState, onProviderReady, transactionTransport, anchorJournal } = {}) {
  const [{ sessionFactory }, ui, { checkSellerSessionDelegation }] = await Promise.all([
    import('/portal/assets/embedded-wallet-bridge.mjs'),
    import('/portal/assets/embedded-wallet/ui.mjs'),
    import('/portal/assets/seller-session-delegation.mjs'),
  ]);
  const vaultStore = await chooseStore(ui);
  durable = await claimSignature.available();
  const factory = async ({ approve }) => {
    // The bridge's own SDK module (loaded on create/import/unlock, as there).
    const { EmbeddedWalletError, INTENT_SOURCE_PHASE_FENCE } = await import('/portal/assets/embedded-wallet/sdk-provider.mjs');
    const next = createIntentGate({ approve, checkDelegation: checkSellerSessionDelegation, announce, claimSignature });
    const session = await sessionFactory({ approve: next.approve, transactionTransport, anchorJournal: next.fenceJournal(anchorJournal, EmbeddedWalletError), fenceSdk: (DemosCtor) => next.fenceSdk(DemosCtor, EmbeddedWalletError) });
    sourcePhaseFence = INTENT_SOURCE_PHASE_FENCE === true;
    next.attach(session);
    gate?.finish();
    gate = next;
    return session;
  };
  const publicState = (state) => {
    if (state?.locked) gate?.finish();
    onPublicState?.(state);
  };
  return ui.mountEmbeddedWallet(root, { sessionFactory: factory, vaultStore, onPublicState: publicState, onProviderReady });
}

// Only the unlocked embedded wallet, on a purchase profile the intent covers,
// with durable storage for the signature journal and its SDK signatures
// fenced by the gate (a bridge without the hook keeps the per-step dialogs).
export function covers({ provider, terms }) {
  const profile = intentProfile(terms);
  return provider?.isDacsEmbeddedWallet === true && !provider.isLocked() && gate !== null && gate.fencesSdk && durable && profile !== null && (profile.kind !== 'devnet' || sourcePhaseFence);
}

export function run({ id, token, address, provider, broker, api, log, recheck }) {
  if (!gate) throw new Error('unlock the embedded wallet first');
  return runStart({ id, token, address, gate, api, origin: location.origin, broker, provider, recheck, log });
}
