// Read-only view of the Demos identities associated with the caller's linked
// wallets. An identity here is a public association between a Demos address
// and another identifier (a Web2 handle, another chain's address, a domain,
// a post-quantum key, a provider score...). It is not KYC, legal identity or
// proof of personhood, and its presence says nothing about which transaction
// created it.
//
// Request, envelope and projection follow the pinned consumer: the vendored
// @kynesyslabs/dacs 0.1.0-alpha.0 resolves identities with one unified
// gcr_routine getIdentities call and projects the decoded
// {result:200, response:{xm, web2, ud, pqc, nomis, humanpassport, ethos, tlsn}}
// envelope with parseCciRecord (see src/dacs/chain.mjs for the transport).
//
// Evidence is labelled for what it is: one configured RPC endpoint's answer,
// timestamped by this server's clock. It is not authenticated, finalized or
// cross-checked chain state. With no chain RPC configured, reads fail as
// not_configured; a failed read is reported as unavailable with claims: null,
// never as an empty identity list; there is never a fixture fallback.
import { createHash } from 'node:crypto';
import { parseCciRecord } from '@kynesyslabs/dacs/identity';
import { AccountError } from './accounts.mjs';
import { NotConfiguredError } from './dacs/verification.mjs';
import { normalizeDemosAddress } from './wallet/demos-signature.mjs';
import { OperationError } from './operations.mjs';
import { sha256Hex } from './util/ids.mjs';
import { canonicalize } from './dacs/listing.mjs';

export const IDENTITY_NOTE = 'Associations reported by the configured Demos node: not KYC, legal identity or proof of personhood, and not proof of which transaction caused them.';

// Stated limits of every identity read, returned with the data.
export const IDENTITY_READ_LIMITS = Object.freeze({
  source: 'gcr_routine getIdentities on the configured Demos RPC endpoint (DACS_CHAIN_RPC_URL)',
  authority: 'One configured endpoint, read without request authentication or state proofs. Not cross-checked against other nodes, finality or consensus; a stale, partitioned or wrong node would not be detected.',
  freshness: 'observedAt is this server\'s local clock when the response arrived. It is not a block height or chain timestamp, and the state may have changed since.',
  projection: 'Projected with the pinned @kynesyslabs/dacs parseCciRecord over all eight GCR contexts. Entries it cannot represent are omitted from claims and remain only in the raw response.',
});

// Identity add/remove (start_identity_action) proposes only GitHub and
// Twitter Web2 link changes and is held by default; the read projection above
// is broader and does not imply any other context can be changed here.
export const IDENTITY_WRITE_SCOPE = 'start_identity_action can only propose GitHub or Twitter link changes, and is held unless this server runs against a simulated fixture chain. Other contexts shown by get_identities are read-only here.';

// Top-level context keys of the pinned getIdentities response.
const CONTEXT_KEYS = ['xm', 'web2', 'ud', 'pqc', 'nomis', 'humanpassport', 'ethos', 'tlsn'];
const RAW_LIMIT = 8 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function rawEvidence(value) {
  const json = JSON.stringify(value ?? null);
  return {
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Buffer.byteLength(json),
    ...(Buffer.byteLength(json) <= RAW_LIMIT ? { json } : { truncated: true }),
  };
}

// Projects one decoded getIdentities envelope (already result 200 and bounded
// by the chain reader). Returns { status: 'observed' | 'unrecognized', record }.
// 'unrecognized' (claims unknown) when the response object carries none of the
// pinned context keys or the pinned parser refuses it; never coerced to empty.
export function projectIdentities(address, envelope) {
  const response = envelope?.response;
  if (!isObject(response) || !CONTEXT_KEYS.some((k) => Object.hasOwn(response, k))) {
    return { status: 'unrecognized', record: null, error: 'response carries no recognised identity contexts' };
  }
  // The pinned parser stops at the first object with any context key (using
  // `in`). Outer contexts would hide the response object validated here.
  if (isObject(envelope) && [...CONTEXT_KEYS, 'linkedWallets', 'linkedSocials'].some((k) => k in envelope)) {
    return { status: 'unrecognized', record: null, error: 'outer identity contexts would hide the response' };
  }
  if (Object.hasOwn(response, 'result') && response.result !== 200) {
    return { status: 'unrecognized', record: null, error: 'identity response carries a non-200 result' };
  }
  try {
    const record = parseCciRecord(address, envelope);
    // The pinned parser accepts maps for xm/web2/nomis/ethos and maps or
    // arrays for ud/pqc/humanpassport/tlsn. Validate its owned snapshot.
    for (const key of CONTEXT_KEYS) {
      if (!Object.hasOwn(record.raw.response, key)) continue;
      const value = record.raw.response[key];
      if (!isObject(value) && !(['ud', 'pqc', 'humanpassport', 'tlsn'].includes(key) && Array.isArray(value))) {
        return { status: 'unrecognized', record: null, error: `invalid identity context container: ${key}` };
      }
    }
    return { status: 'observed', record, error: null };
  } catch (error) {
    return { status: 'unrecognized', record: null, error: String(error?.message ?? error).slice(0, 200) };
  }
}

const counts = (record) => ({
  web2: record.web2.length,
  wallets: record.wallets.length,
  ud: record.ud.length,
  pqc: record.pqc.length,
  nomis: record.nomis.length,
  humanPassport: record.humanPassport.length,
  ethos: record.ethos.length,
  tlsn: record.tlsn.length,
});

export function createIdentityService({ chain, accounts, now = () => Date.now() }) {
  const capability = () => (chain ? 'configured' : 'not_configured');

  function walletsFor(accountId, walletAddress) {
    const linked = accounts.listWallets(accountId).map((w) => w.address);
    if (walletAddress === undefined) return linked;
    const wanted = normalizeDemosAddress(walletAddress);
    if (!linked.includes(wanted)) throw new AccountError('wallet_not_linked', 'that wallet is not linked to this account');
    return [wanted];
  }

  async function readOne(address) {
    const evidence = () => ({
      mode: chain.evidenceMode === 'simulated-fixture' ? 'simulated-fixture' : 'configured-rpc-read',
      network: chain.network,
      rpcOrigin: chain.rpcOrigin,
      observedAt: new Date(now()).toISOString(),
    });
    let envelope;
    try {
      envelope = await chain.getIdentities(address);
    } catch (error) {
      // An unreadable chain is unavailable: claims are unknown (null), not empty.
      return { address, status: 'unavailable', claims: null, counts: null, raw: null, error: String(error?.message ?? error).slice(0, 200), evidence: evidence() };
    }
    const projected = projectIdentities(address, envelope);
    const record = projected.record;
    return {
      address,
      status: projected.status,
      claims: record ? record.claims : null,
      counts: record ? counts(record) : null,
      raw: rawEvidence(envelope),
      error: projected.error,
      evidence: evidence(),
    };
  }

  // Read the reported association state for the caller's own wallets.
  // Unavailability is an error, never a successful empty answer: no chain
  // configured -> not_configured; every attempted read failed ->
  // identity_reads_unavailable. A partial result marks each failed wallet
  // unavailable with claims: null.
  async function observe({ accountId, walletAddress }) {
    if (!chain) throw new NotConfiguredError('identity reads (DACS_CHAIN_RPC_URL)');
    const wallets = walletsFor(accountId, walletAddress);
    const out = [];
    for (const address of wallets) out.push(await readOne(address));
    if (out.length > 0 && out.every((w) => w.status === 'unavailable')) {
      throw new OperationError('identity_reads_unavailable', 'identity reads are unavailable from the configured Demos RPC; identities are unknown, not empty', {
        wallets: out.map((w) => ({ address: w.address, error: w.error })),
        readLimits: IDENTITY_READ_LIMITS,
      });
    }
    return out;
  }

  return { capability, observe };
}

// ---------------------------------------------------------------------------
// Identity add/remove: OFFLINE CANDIDATE.
//
// The user's own wallet performs every identity write: it builds, signs and
// (after its own confirmation popup) broadcasts the transaction. This server
// never signs, never broadcasts and never calls the wallet's internal APIs. It
// prepares a durable, owner-bound operation, hands the portal the one provider
// request to make, records what the wallet reported, and then compares chain
// readback for the exact wallet, kind and handle.
//
// Real writes are HELD by default (DACS_IDENTITY_WRITES unset or "held"):
// wallet sign-parameter compatibility, the web2 proof format/fork on Demos
// testnet and the installed wallet's network are not positively established.
// "simulated-fixture-only" enables the flow only while the configured chain is
// a simulated fixture; against any other chain the capability stays held.
//
// Provider methods and parameters follow the reviewed Demos wallet 0.5.7
// source (pin cafb747) and @kynesyslabs/demosdk 4.0.12; they are not verified
// against an installed wallet.
// ---------------------------------------------------------------------------

export const IDENTITY_KINDS = Object.freeze(['github', 'twitter']);
export const REQUIRED_LIVE_CHECKS = Object.freeze([
  'wallet sign() with an installed wallet: the portal now sends params[0] as the plain message string the reviewed wallet 0.5.7 source reads; this matches the source only and is unconfirmed with a real wallet',
  'web2 proof format: wallet 0.5.7 / demosdk 4.0.12 sign the legacy "dw2p" payload; whether the web2ProofBinding fork is active on Demos testnet is unknown',
  'installed wallet network: the wallet source default RPC is labelled Mainnet; the tester wallet must be confirmed on Demos testnet in the wallet itself',
  'wallet identity methods (getWeb2IdentityProofPayload, addGithubIdentity, addTwitterIdentity, removeWeb2Identity) exercised against a real installed wallet',
  'node gcr_routine getIdentities on Demos testnet: the actual response shape, and whether the node answers without the SDK\'s signed identity/signature/timestamp request headers (this server sends none)',
]);

// SDK 4.0.12 Identities.formats.web2 hosts accepted for each proof kind.
const PROOF_HOSTS = {
  github: ['gist.github.com', 'gist.githubusercontent.com', 'raw.githubusercontent.com'],
  twitter: ['x.com', 'twitter.com'],
};
const HANDLE = /^[A-Za-z0-9_-]{1,39}$/;
// Characters GitHub usernames can have; same rule as the wallet's github-user
// relay (src/portal/wallet-rpc.mjs). Any other handle can never be looked up.
export const GITHUB_HANDLE = /^[A-Za-z0-9-]{1,39}$/;
// The wallet has not been asked in these: cancel and expiry close them.
const OPEN_STATUSES = new Set(['prepared', 'awaiting_wallet', 'awaiting_public_proof', 'review']);
const IN_FLIGHT = new Set([...OPEN_STATUSES, 'wallet_requested', 'readback_pending', 'outcome_unknown']);
// Codes the experimental embedded wallet (public/portal/embedded-wallet/
// sdk-provider.mjs identityWrite and request(), plus its ui.mjs provider
// wrapper) raises for identity methods before its one broadcast. They count
// only when the portal reports that this wallet answered. Its broadcast-time
// codes (outcome_unknown, broadcast_rejected) and catch-alls (internal_error,
// wallet_error) are not here: those stay unknown.
const EMBEDDED_STOPPED_BEFORE_SEND = new Set(['locked', 'busy', 'invalid_params', 'invalid_request', 'not_configured', 'unsupported', 'held_for_review', 'upstream_unavailable', 'identity_mismatch', 'confirm_rejected', 'payload_mismatch']);
const WALLET_KINDS = new Set(['embedded', 'extension']);
const READBACK_WINDOW_MS = 10 * 60 * 1000;
const OPERATION_TTL_MS = 30 * 60 * 1000;
// Purchases and publications share the wallet's nonce space (see purchases.mjs).
const BLOCKING_WALLET_STATUSES = ['payment_handoff', 'broadcast_reported', 'payment_uncertain', 'publication_handoff'];

export const IDENTITY_STATUS_HELP = Object.freeze({
  prepared: 'Prepared. Open the portal link in the browser where your Demos wallet is installed.',
  awaiting_wallet: 'Waiting for you to connect the exact wallet this action is for.',
  awaiting_public_proof: 'Get the proof text from your wallet, publish it yourself, then give the portal its public URL.',
  review: 'Review the exact action, then approve it in your wallet.',
  wallet_requested: 'Your wallet was asked once. Its result has not been reported yet; the outcome is unknown until readback.',
  readback_pending: 'Your wallet reported a result. Waiting to see the association change on chain.',
  association_observed: 'The association is now observed on chain for this wallet. This shows current chain state, not which transaction caused it.',
  removal_observed: 'The association is no longer observed on chain for this wallet. Your public post or gist and past transactions are not deleted.',
  rejected_before_send: 'You rejected the request in your wallet before anything was sent.',
  failed_before_send: 'Your experimental embedded wallet reported that it stopped before broadcasting anything (its answer is shown). Nothing was retried. This action is closed: fix the input or missing step and start a new identity action.',
  outcome_unknown: 'The outcome is unknown: the wallet request may or may not have been executed. Nothing is retried automatically; check get_identities later.',
  expired: 'This identity action expired before it was sent to your wallet. Start a new one if you still want it.',
  cancelled: 'You cancelled this identity action before your wallet was asked. Nothing was sent. Start a new one if you still want it.',
});

// Derive the handle a proof URL claims, the same way the SDK does
// (payload.split("/")[3], i.e. the first path segment).
export function claimedHandle(kind, proofUrl) {
  let url;
  try {
    url = new URL(proofUrl);
  } catch {
    throw new OperationError('invalid_proof_url', 'the proof URL is not a valid URL');
  }
  if (url.protocol !== 'https:' || !PROOF_HOSTS[kind]?.includes(url.hostname) || url.username || url.password || url.port) {
    throw new OperationError('invalid_proof_url', `a ${kind} proof must be a public https URL on ${PROOF_HOSTS[kind].join(', ')}`);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (kind === 'twitter' && (parts.length < 3 || parts[1] !== 'status' || !/^\d{1,25}$/.test(parts[2]))) {
    throw new OperationError('invalid_proof_url', 'a twitter proof must be a post URL (https://x.com/<handle>/status/<id>)');
  }
  if (kind === 'github' && parts.length < 2) throw new OperationError('invalid_proof_url', 'a github proof must be a public gist URL');
  if (!HANDLE.test(parts[0] ?? '')) throw new OperationError('invalid_proof_url', 'the proof URL does not name a valid handle');
  // Refused here, before the wallet is asked, so the person can paste a
  // corrected URL in the same action.
  if (kind === 'github' && !GITHUB_HANDLE.test(parts[0])) {
    throw new OperationError('invalid_proof_url', `“${parts[0]}” cannot be a GitHub username (letters, digits and hyphens only), so your wallet could not look it up. Nothing was sent to your wallet. Publish the gist under your real GitHub username and paste its URL.`);
  }
  return parts[0];
}

export function createIdentityActions({ config, ops, accounts, coordinates, chain, now = () => Date.now() }) {
  const iso = (t = now()) => new Date(t).toISOString();

  function capability() {
    if (config.identityWrites !== 'simulated-fixture-only') return 'held';
    if (!chain) return 'not_configured';
    return 'simulated-fixture-only';
  }

  function held() {
    return new OperationError('identity_writes_held', 'Identity add/remove is not available on this server: real-wallet compatibility, the proof format and the wallet network have not been positively established.', { requiredLiveChecks: REQUIRED_LIVE_CHECKS });
  }

  // Readback for the write candidate: the same unified read as get_identities,
  // narrowed to its Web2 claims (the only context these actions can change).
  async function readWeb2(wallet) {
    const envelope = await chain.getIdentities(wallet);
    const projected = projectIdentities(wallet, envelope);
    const entries = projected.record ? projected.record.web2.map((c) => ({ context: c.platform, username: c.handle })) : [];
    return { status: projected.status, entries, sha256: sha256Hex(JSON.stringify(envelope ?? null)) };
  }

  const matches = (entries, kind, handle) => entries.some((e) => e.context === kind && e.username.toLowerCase() === handle.toLowerCase());

  function selectWallet(accountId, requested) {
    const wallets = accounts.listWallets(accountId).map((w) => w.address);
    if (wallets.length === 0) throw new OperationError('wallet_required', 'link a wallet to your account first (start_wallet_link)');
    if (requested) {
      const wanted = normalizeDemosAddress(requested);
      if (!wallets.includes(wanted)) throw new OperationError('wallet_not_linked', 'that wallet is not linked to your account');
      return wanted;
    }
    if (wallets.length > 1) throw new OperationError('wallet_ambiguous', 'several wallets are linked; specify walletAddress');
    return wallets[0];
  }

  function expireIfNeeded(operation) {
    if (OPEN_STATUSES.has(operation.status) && Date.parse(operation.expiresAt) <= now()) {
      return ops.transition(operation.id, operation.status, 'expired', { data: { reason: 'expired before the wallet was asked' } });
    }
    return operation;
  }

  async function start({ accountId, idempotencyKey, walletAddress, action, kind, username }) {
    if (capability() === 'held') throw held();
    if (!chain) throw new NotConfiguredError('identity actions (DACS_CHAIN_RPC_URL)');
    if (!IDENTITY_KINDS.includes(kind)) throw new OperationError('unsupported_identity_kind', `only ${IDENTITY_KINDS.join(' and ')} identities are supported; cross-chain (xm) is deferred`);
    const wallet = selectWallet(accountId, walletAddress);
    const request = { action, kind, wallet, username: username ?? null };
    const existing = ops.findByKey(accountId, 'identity', idempotencyKey);
    if (existing) {
      const replay = ops.createIdempotent({ accountId, kind: 'identity', idempotencyKey, request });
      return { operation: expireIfNeeded(replay.operation), handoffToken: replay.handoffToken, created: false };
    }
    if (action === 'remove' && !(typeof username === 'string' && HANDLE.test(username))) throw new OperationError('username_required', 'removing an identity needs the exact handle to remove');
    if (action === 'add' && username !== undefined) throw new OperationError('username_not_accepted', 'for add, the handle comes from the public proof URL you provide in the portal');
    const inFlight = ops.listForSubject(accountId, 'identity', wallet).map(expireIfNeeded).find((o) => IN_FLIGHT.has(o.status));
    if (inFlight) {
      const cancellable = OPEN_STATUSES.has(inFlight.status);
      throw new OperationError('identity_operation_in_progress', cancellable
        ? `another identity action for this wallet is still in progress; it has not reached your wallet yet: cancel it on its portal page, or it expires at ${inFlight.expiresAt}`
        : 'another identity action for this wallet is still in progress; your wallet was already asked, so its outcome is settled only by chain readback (get_identities)',
      { operationId: inFlight.id, status: inFlight.status, expiresAt: inFlight.expiresAt, cancellable });
    }
    const blocking = coordinates.unresolvedForSender(wallet, '', BLOCKING_WALLET_STATUSES);
    if (blocking.length > 0) throw new OperationError('unresolved_wallet_operation', 'another wallet operation from this wallet has an unresolved outcome; resolve it first', { operationId: blocking[0].operationId, status: blocking[0].status });

    // Baseline readback before anything else: the action must make sense
    // against current chain state, and the chain must be the fixture.
    const baseline = await readWeb2(wallet);
    if (chain.evidenceMode !== 'simulated-fixture') throw held();
    if (baseline.status !== 'observed') throw new OperationError('identity_readback_unavailable', 'current identities could not be read in a recognised shape; not starting');
    // For remove, use the handle exactly as the chain records it.
    const observed = action === 'remove' ? baseline.entries.find((e) => e.context === kind && e.username.toLowerCase() === username.toLowerCase()) : null;
    if (action === 'remove' && !observed) throw new OperationError('identity_not_associated', `no ${kind} association for ${username} is observed on this wallet`);

    const terms = { action, kind, wallet, network: chain.network, username: observed ? observed.username : null };
    const created = ops.createIdempotent({
      accountId, kind: 'identity', idempotencyKey, request, status: 'prepared', subjectId: wallet,
      terms, termsHash: sha256Hex(canonicalize(terms)), expiresAt: iso(now() + OPERATION_TTL_MS),
      state: { baseline: { sha256: baseline.sha256, observedAt: iso(), evidenceMode: chain.evidenceMode } },
    });
    return { operation: created.operation, handoffToken: created.handoffToken, created: true };
  }

  function portalOperation(id, token) {
    const found = ops.getByHandoff(id, token);
    if (!found || found.kind !== 'identity') throw new OperationError('not_found', 'unknown or invalid identity link');
    return expireIfNeeded(found);
  }

  async function opened(id, token) {
    const operation = portalOperation(id, token);
    if (operation.status === 'prepared') return ops.transition(id, 'prepared', 'awaiting_wallet', { data: { reason: 'portal opened' } });
    return chain ? reconcile(operation) : operation;
  }

  function connected({ id, token, address }) {
    const operation = portalOperation(id, token);
    if (operation.status !== 'awaiting_wallet') throw new OperationError('invalid_state', `operation is ${operation.status}`, { status: operation.status });
    if (normalizeDemosAddress(address) !== operation.terms.wallet) throw new OperationError('wallet_mismatch', `connect the wallet this action is for (${operation.terms.wallet})`);
    return ops.transition(id, 'awaiting_wallet', operation.terms.action === 'add' ? 'awaiting_public_proof' : 'review', { data: { connected: operation.terms.wallet } });
  }

  async function submitProof({ id, token, proofUrl }) {
    const operation = portalOperation(id, token);
    if (operation.status !== 'awaiting_public_proof') throw new OperationError('invalid_state', `operation is ${operation.status}`, { status: operation.status });
    const handle = claimedHandle(operation.terms.kind, String(proofUrl ?? ''));
    const current = await readWeb2(operation.terms.wallet);
    if (current.status === 'observed' && matches(current.entries, operation.terms.kind, handle)) {
      throw new OperationError('already_associated', `${handle} is already associated with this wallet on chain`);
    }
    return ops.transition(id, 'awaiting_public_proof', 'review', { state: { proofUrl, username: handle }, data: { proofUrl, claimedHandle: handle } });
  }

  // The single provider request for this operation, recorded durably before
  // the portal asks the wallet. A second request is refused (no retry).
  function walletRequest(operation) {
    const { action, kind } = operation.terms;
    if (action === 'remove') return { method: 'removeWeb2Identity', params: [{ context: kind, username: operation.terms.username }] };
    return { method: kind === 'github' ? 'addGithubIdentity' : 'addTwitterIdentity', params: [operation.state.proofUrl] };
  }

  function request({ id, token }) {
    const operation = portalOperation(id, token);
    if (operation.status !== 'review') throw new OperationError('invalid_state', `operation is ${operation.status}; the wallet can be asked only once`, { status: operation.status });
    const req = walletRequest(operation);
    const updated = ops.transition(id, 'review', 'wallet_requested', { state: { requestedAt: iso(), walletMethod: req.method }, data: { method: req.method } });
    return { operation: updated, walletRequest: req };
  }

  // The person closes an action the wallet has not been asked for. Once the
  // wallet was asked, only its reported answer and chain readback decide.
  function cancel({ id, token }) {
    const operation = portalOperation(id, token);
    if (operation.status === 'cancelled' || operation.status === 'expired') return operation;
    if (!OPEN_STATUSES.has(operation.status)) {
      throw new OperationError('invalid_state', `operation is ${operation.status}; an identity action can be cancelled only before the wallet is asked`, { status: operation.status });
    }
    return ops.transition(id, operation.status, 'cancelled', { data: { reason: 'cancelled by the user before the wallet was asked' } });
  }

  // Wallet envelope classification. USER_REJECTED is the extension wallet's
  // reject-before-send code and user_rejected the embedded wallet's (its
  // approval is asked before anything is signed); success means the wallet
  // reported a broadcast result. The embedded wallet's own stopped-before-
  // broadcast codes close the action only when the portal says that wallet
  // answered. Everything else (cancel, timeout, window closed, ambiguous
  // error, no envelope, any extension code) leaves execution UNKNOWN.
  function classify(outcome) {
    if (outcome?.success === true) return 'wallet_reported_success';
    if (outcome?.code === 'USER_REJECTED' || outcome?.code === 'user_rejected') return 'rejected_before_send';
    if (outcome?.wallet === 'embedded' && EMBEDDED_STOPPED_BEFORE_SEND.has(outcome?.code)) return 'failed_before_send';
    return 'unknown';
  }

  async function report({ id, token, outcome }) {
    const operation = portalOperation(id, token);
    if (operation.status !== 'wallet_requested') throw new OperationError('invalid_state', `operation is ${operation.status}`, { status: operation.status });
    const classification = classify(outcome);
    const walletOutcome = {
      classification,
      success: outcome?.success === true,
      code: typeof outcome?.code === 'string' ? outcome.code.slice(0, 64) : null,
      message: typeof outcome?.message === 'string' ? outcome.message.slice(0, 200) : null,
      dataSha256: typeof outcome?.dataSha256 === 'string' && /^[0-9a-f]{64}$/.test(outcome.dataSha256) ? outcome.dataSha256 : null,
      wallet: WALLET_KINDS.has(outcome?.wallet) ? outcome.wallet : null,
      reportedAt: iso(),
    };
    if (classification === 'rejected_before_send' || classification === 'failed_before_send') {
      return { operation: ops.transition(id, 'wallet_requested', classification, { state: { walletOutcome }, data: walletOutcome }) };
    }
    const pending = ops.transition(id, 'wallet_requested', 'readback_pending', { state: { walletOutcome }, data: walletOutcome });
    return { operation: await reconcile(pending) };
  }

  // Compare chain readback for the exact wallet, kind and handle. Observing the
  // expected state is reported as such, never as proof of which transaction
  // caused it. Not observing it within the window leaves the outcome unknown.
  async function reconcile(operation) {
    if (!['wallet_requested', 'readback_pending', 'outcome_unknown'].includes(operation.status)) return operation;
    const handle = operation.terms.action === 'remove' ? operation.terms.username : operation.state.username;
    let current;
    try {
      current = await readWeb2(operation.terms.wallet);
    } catch (error) {
      ops.record(operation.id, 'readback_unavailable', { message: String(error?.message ?? error).slice(0, 200) });
      return operation;
    }
    if (current.status !== 'observed') {
      ops.record(operation.id, 'readback_unrecognized', { sha256: current.sha256 });
      return operation;
    }
    const present = matches(current.entries, operation.terms.kind, handle);
    const reached = operation.terms.action === 'add' ? present : !present;
    if (reached) {
      const to = operation.terms.action === 'add' ? 'association_observed' : 'removal_observed';
      return ops.transition(operation.id, operation.status, to, {
        state: { readback: { sha256: current.sha256, observedAt: iso(), evidenceMode: chain.evidenceMode } },
        data: { readbackSha256: current.sha256, evidenceMode: chain.evidenceMode, note: 'current chain state; not proof of which transaction caused it' },
      });
    }
    const requestedAt = Date.parse(operation.state.requestedAt ?? operation.updatedAt);
    if (operation.status !== 'outcome_unknown' && now() - requestedAt > READBACK_WINDOW_MS) {
      return ops.transition(operation.id, operation.status, 'outcome_unknown', { data: { reason: 'expected chain state not observed within the readback window', readbackSha256: current.sha256 } });
    }
    return operation;
  }

  function summary(operation) {
    return {
      operationId: operation.id,
      action: operation.terms.action,
      kind: operation.terms.kind,
      walletAddress: operation.terms.wallet,
      username: operation.terms.username ?? operation.state.username ?? null,
      status: operation.status,
      statusHelp: IDENTITY_STATUS_HELP[operation.status] ?? null,
      walletOutcome: operation.state.walletOutcome?.classification ?? null,
      updatedAt: operation.updatedAt,
      expiresAt: operation.expiresAt,
    };
  }

  // Owner-scoped list with lazy expiry and readback for in-flight operations.
  async function listForAccount(accountId, limit = 20) {
    const out = [];
    for (const op of ops.list(accountId, 100).filter((o) => o.kind === 'identity').slice(0, limit)) {
      let current = expireIfNeeded(op);
      if (chain) current = await reconcile(current);
      out.push(summary(current));
    }
    return out;
  }

  function portalView(operation, extra = {}) {
    return {
      id: operation.id,
      status: operation.status,
      statusHelp: IDENTITY_STATUS_HELP[operation.status] ?? null,
      terms: operation.terms,
      proofUrl: operation.state.proofUrl ?? null,
      username: operation.terms.username ?? operation.state.username ?? null,
      expiresAt: operation.expiresAt,
      evidenceMode: operation.state.baseline?.evidenceMode ?? null,
      walletOutcome: operation.state.walletOutcome ?? null,
      history: ops.history(operation.id),
      ...extra,
    };
  }

  return { capability, start, opened, connected, submitProof, request, cancel, report, reconcile, listForAccount, portalOperation, portalView, summary };
}
