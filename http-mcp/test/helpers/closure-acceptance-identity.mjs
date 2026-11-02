// Closure acceptance helpers for identity recovery (SIMULATED fixtures only).
// Source-aware ordinary functional testing; NOT a security review, NOT live
// Demos testnet, NOT ChatGPT, NOT full v0.1 acceptance.
//
// Expected results come from the public user contract, independently of the
// identity service's own classifier:
// - IDENTITY_STATUS_HELP texts and docs/OVERNIGHT-CORE.md "Identity actions":
//   before the wallet answers, and while a reported outcome waits for readback
//   (wallet_requested / readback_pending / outcome_unknown), the action is in
//   flight and a new identity action for the wallet is refused.
// - docs/EMBEDDED-WALLET-SDK.md error codes: the embedded wallet's
//   upstream_unavailable for a GitHub user it cannot read is returned before
//   any approval dialog ("nothing was signed"); after broadcast has started
//   the answer is broadcast_accepted / broadcast_rejected / outcome_unknown.
// - A wallet that signed and sent nothing has not changed the chain, so a
//   truthful terminal status for it is neither "observed" nor "expired", and
//   the wallet must be able to start a new identity action in the same run.

// - Closure identity interface (the embedded wallet's published
//   interface): an embedded documented pre-send code reported from
//   wallet_requested ends the action as failed_before_send (terminal, not in
//   flight); a GitHub proof URL with characters outside [A-Za-z0-9-] is now
//   refused at the proof step (invalid_proof_url), so an underscore handle
//   no longer reaches the wallet.
//
// Deterministic user-reachable pre-send trigger after the repair: a Twitter
// add whose pasted post URL is mistyped. The server checks only its shape;
// the embedded wallet asks the node for the post (getTweet), the fixture
// does not know it, and the wallet answers upstream_unavailable before any
// approval dialog ("nothing was signed").
export const FAILED_BEFORE_SEND = 'failed_before_send';

// The same post URL with the last digit of its status id changed.
export function mistypedPost(url) {
  const m = /^(https:\/\/x\.com\/[^/]+\/status\/\d*)(\d)$/.exec(url);
  if (!m) throw new Error(`not an x.com post URL: ${url}`);
  return `${m[1]}${(Number(m[2]) + 1) % 10}`;
}

// Statuses during which the action is still open (documented in-flight set).
export const IN_FLIGHT = Object.freeze(['prepared', 'awaiting_wallet', 'awaiting_public_proof', 'review', 'wallet_requested', 'readback_pending', 'outcome_unknown']);
// Terminal statuses that would claim a chain change or a timeout instead.
const NOT_A_REFUSAL = Object.freeze(['association_observed', 'removal_observed', 'expired']);

// True only for a closed, nothing-sent outcome: not in flight, and not a
// status that claims an observed chain change or an expiry before asking.
export function isClosedNotSent(status) {
  return typeof status === 'string' && status.length > 0 && !IN_FLIGHT.includes(status) && !NOT_A_REFUSAL.includes(status);
}

// The identity portal's "Status" row (public page text only).
export async function portalStatus(page) {
  const dd = page.locator('#flow dl dt', { hasText: /^Status$/ }).first().locator('xpath=following-sibling::dd[1]');
  return (await dd.innerText({ timeout: 10000 })).trim();
}

// Publishes proof text on the launcher's local proof publisher (a fixture
// stand-in for a gist/post) and returns the public proof URL it shows.
export async function publishProof(context, proofsOrigin, kind, handle, proofText) {
  const pub = await context.newPage();
  try {
    await pub.goto(`${proofsOrigin}/`);
    await pub.selectOption('select[name=kind]', kind);
    await pub.fill('input[name=username]', handle);
    await pub.fill('input[name=proof]', proofText);
    await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
    const shown = await pub.locator('#proof-url').count();
    if (!shown) throw new Error(`proof publisher did not publish "${handle}": ${(await pub.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
    return (await pub.locator('#proof-url').innerText()).trim();
  } finally {
    await pub.close();
  }
}

// Identity operations for one wallet from get_identities (public summaries).
export function operationsFor(identities, address) {
  return (identities.operations ?? []).filter((o) => o.walletAddress === address);
}
