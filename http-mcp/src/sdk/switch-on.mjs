// The SDK purchases on composition.
//
// At startup it binds the SDK's approved TP-1 identity record over the node
// connection DACS_CHAIN_RPC_URL names, once, within 10 s. A refused or timed-out
// binding keeps the server up: passive readers answer as with SDK purchases off,
// and every purchase action refuses with the binding's own tp1_* code until the
// server restarts. The evidence recorder is still built, over a passive-only
// admission that admits no purchase action.
//
// After a successful startup binding, each buyer session (an account and one of
// its linked wallets) gets its own authority reader, binding, listing verifier
// and purchase service. They are built on the session's first
// purchase action and never shared. A session's claim is its wallet's, which the
// wallet-link challenge proved; a wallet named in a request only selects among
// the account's own linked wallets. A call for a wallet its account no longer
// owns, or by an expired handoff link, answers not_found before any session.
// The server holds no buyer key and opens no
// wallet journal. The client's passive purchase reader, stop seam, fee ceiling,
// HTTPS seller client and wallet handoff have no public names yet, so they are
// not composed here, and the native wallet relay stays unmounted.
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { OperationError, createAuthorityReader, createListingVerifier, createPurchaseService } from '@kynesyslabs/dacs-client';
import { createNodeAuthorityCapability, createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { purchaseStore } from '../store/database.mjs';
import { claimForAddress } from '../wallet/demos-signature.mjs';
import { PURPOSES } from '../wallet/challenges.mjs';
import { createRelayAccess, handoffExpiry } from '../wallet/relay-access.mjs';
import { createAgreementCreateDelivery } from '../portal/agreement-create-delivery.mjs';
import { createStartIntents } from '../portal/start-intent.mjs';
import { PURCHASE_SERVICE_ACTIVE, PURCHASE_SERVICE_PASSIVE, createPurchasesOff, readActivationSeams } from './activation-seams.mjs';
import { loadParticipantEnrollment } from './participant-enrollment.mjs';

// The deadline for one TP-1 binding, at startup and for each buyer session.
const BINDING_DEADLINE_MS = 10_000;
const TP1_CODE = /^tp1_[a-z0-9_]{1,59}$/;
const LOCAL_BINDING_INVALID = 'tp1_local_binding_invalid';
// Node connections prepared before createApp, each with the configuration object it was prepared for.
const preparedOwners = new WeakMap();

/**
 * Returns the TP-1 node endpoint for `config`: the chain RPC URL's origin and
 * `/`, the root form the client's node connection accepts. Throws
 * OperationError tp1_local_binding_invalid when the URL is missing, is not
 * https, or has credentials, a path, a query or a fragment.
 */
export function tp1EndpointFromConfig(config) {
  let url = null;
  try {
    url = new URL(config.chain?.rpcUrl);
  } catch { /* refused below */ }
  if (url?.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new OperationError(LOCAL_BINDING_INVALID, 'DACS_CHAIN_RPC_URL must be an https root with no credentials, path, query or fragment');
  }
  return `${url.origin}/`;
}

/**
 * Opens the process's TP-1 node connection for `config` ahead of createApp
 * and returns an opaque handle, which createApp takes once and only with the
 * same configuration object. Throws OperationError tp1_local_binding_invalid,
 * with the client's refusal as its cause, for an invalid endpoint or
 * DACS_TP1_TRANSPORT_AUTHORITY.
 */
export function prepareSwitchOnOwner({ config, fetchImpl }) {
  let owner;
  try {
    owner = createNodeTransportOwner({ endpoint: tp1EndpointFromConfig(config), transportAuthority: config.tp1TransportAuthority, fetchImpl });
  } catch (error) {
    throw new OperationError(LOCAL_BINDING_INVALID, 'the TP-1 node connection settings are invalid', undefined, { cause: error });
  }
  const handle = Object.freeze({});
  preparedOwners.set(handle, { config, owner });
  return handle;
}

/** Closes the node connection behind a prepared `handle` that was never taken; does nothing for any other value. */
export function releasePreparedOwner(handle) {
  const prepared = preparedOwners.get(handle);
  preparedOwners.delete(handle);
  prepared?.owner.close();
}

// The connection prepared for this very `config`, taken once; otherwise a new one (one for another config is closed).
function ownerFor(handle, config, fetchImpl) {
  let taken = handle;
  if (preparedOwners.get(taken)?.config !== config) {
    releasePreparedOwner(taken);
    taken = prepareSwitchOnOwner({ config, fetchImpl });
  }
  const { owner } = preparedOwners.get(taken);
  preparedOwners.delete(taken);
  return owner;
}

/** Resolves what `work()` resolves, rejecting OperationError tp1_authority_timeout after the deadline; the first result wins. */
async function withinDeadline(work) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationError('tp1_authority_timeout', 'the TP-1 binding did not finish in time')), BINDING_DEADLINE_MS);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// A failure's own tp1_* code; any other failure (a node that could not be read, a closed connection) is tp1_authority_failed.
const tp1Code = (error) => (TP1_CODE.test(error?.code) ? error.code : 'tp1_authority_failed');

// The buyer sessions, keyed by account and wallet. Building a new one first sweeps those whose account no longer owns
// the wallet; a failed binding is dropped. A call that already holds a session's objects keeps them.
function createBuyerSessions({ live, build }) {
  const sessions = new Map();
  return async function open(accountId, wallet) {
    const key = JSON.stringify([accountId, wallet]);
    if (!sessions.has(key)) {
      for (const [other, session] of sessions) if (!live(session)) sessions.delete(other);
      const objects = build(wallet);
      sessions.set(key, { accountId, wallet, objects });
      objects.catch(() => { if (sessions.get(key)?.objects === objects) sessions.delete(key); });
    }
    return sessions.get(key).objects;
  };
}

// The linked wallet a purchase call acts for, or OperationError not_found. A call naming an operation acts for that
// operation's buyer wallet: by handoff token (portal), whose handoff must still be open, or by account (MCP). prepare
// acts for the requested or only wallet of the account. Either way the account must own the wallet.
function buyerResolver({ ops, accounts, now }) {
  const notFound = () => new OperationError('not_found', 'operation not found');
  const owned = (accountId, wallet) => {
    if (typeof wallet !== 'string' || accounts.walletOwner(wallet) !== accountId) throw notFound();
    return { accountId, wallet };
  };
  const handoffOpen = ({ handoffExpiresAt }) => handoffExpiry(handoffExpiresAt) > Math.max(now(), Date.now());
  return (args = {}) => {
    if (args.operationId !== undefined) {
      const byHandoff = Object.hasOwn(args, 'token');
      const operation = byHandoff ? ops.getByHandoff(args.operationId, args.token) : ops.get(args.accountId, args.operationId);
      if (!operation || (byHandoff && !handoffOpen(operation))) throw notFound();
      return owned(operation.accountId, operation.terms?.buyer?.wallet);
    }
    const wallets = accounts.listWallets(args.accountId).map((w) => w.address);
    const wallet = args.walletAddress ?? (wallets.length === 1 ? wallets[0] : null);
    if (!wallets.includes(wallet)) throw notFound();
    return owned(args.accountId, wallet);
  };
}

/**
 * Builds the SDK purchases on composition after binding at startup.
 *
 * Returns its frozen process descriptor: `startupResult` (frozen
 * `{ ok, binding, failureCode }`) and `bindingState`, its /health view
 * (`{ state: 'bound', recordId }` or `{ state: 'refused', code }`); `owner`, the
 * one node connection (null if it could not be built); `listings`
 * (`{ isRegistered(seller) }`) and `verifier`, the listing verifier for
 * get_listing; `purchases`, frozen with the client service's member names;
 * `startupRefusal(operationId, token)`, the startup failure's error for a
 * purchase its token authenticates, else null; the one `starts`, `delivery` and
 * `relayAccess`; `createSwitchOnEvidencePorts`; and `close`, which closes the
 * node connection. `preparedOwner` is a prepareSwitchOnOwner handle and
 * `recorderNamespace` the evidence recorder's subpath namespace, or null;
 * `listingVerifierFactory` replaces the client's createListingVerifier.
 * Never rejects for a failed binding; rejects only with a database error.
 */
export async function composeSdkPurchasesOn({ config, db, accounts, ops, coordinates, challenges, directory, chain, fetchImpl, now, logger, stopped,
  preparedOwner = null, recorderNamespace = null, listingVerifierFactory = createListingVerifier }) {
  const shared = { db, config, ops, coordinates, accounts, chain, challenges, now, logger, store: purchaseStore, purposes: PURPOSES };
  const registered = new Set();
  const listings = Object.freeze({ isRegistered: (seller) => registered.has(seller) });
  const purchasesByJob = { findByJobId: (jobId) => ops.findByJobId(jobId) };
  let owner = null;
  let participantImplementations = null;
  const bind = (claim) => bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(),
    readAuthority: createAuthorityReader({ authority: createNodeAuthorityCapability({ owner, claim }), identityRecord: TP1_APPROVED_IDENTITY_RECORD,
      claim, listings, purchases: purchasesByJob, participantImplementations }) });
  let startup;
  let startupCause = null;
  try {
    owner = ownerFor(preparedOwner, config, fetchImpl);
    const binding = await withinDeadline(async () => {
      participantImplementations = await loadParticipantEnrollment({ dataDir: config.dataDir });
      return bind(() => null);
    });
    startup = { ok: true, binding, failureCode: null };
  } catch (error) {
    startup = { ok: false, binding: null, failureCode: tp1Code(error) };
    startupCause = error?.cause?.code ?? error?.code ?? 'unknown';
    logger.warn('tp1_startup_binding_refused', { code: startup.failureCode, cause: startupCause });
  }
  const startupResult = Object.freeze(startup);
  // The failure's own code, as details.cause: for example transport_mismatch or unavailable.
  const refused = () => new OperationError(startupResult.failureCode, 'the TP-1 binding at startup failed, so purchase actions are refused until the server restarts',
    { cause: startupCause });
  // A verified Listing registers its seller; nothing else does.
  const registering = (verifier) => Object.freeze({
    async verify(args) {
      const result = await verifier.verify(args);
      if (result?.transactable === true && result.seller === args?.seller) registered.add(result.seller);
      return result;
    },
  });
  const objectsFor = (binding) => {
    const admission = { binding, currentLocal: () => owner.currentLocal() };
    return { admission, verifier: registering(listingVerifierFactory({ admission, directory, chain })) };
  };
  const atStartup = startupResult.ok ? objectsFor(startupResult.binding) : null;

  const open = createBuyerSessions({
    live: ({ accountId, wallet }) => accounts.walletOwner(wallet) === accountId,
    async build(wallet) {
      const claim = claimForAddress(wallet);
      let binding;
      try {
        binding = await withinDeadline(() => bind(() => claim));
      } catch (error) {
        throw new OperationError(tp1Code(error), 'the TP-1 binding for this purchase session failed', undefined, { cause: error });
      }
      return createPurchaseService({ ...shared, ...objectsFor(binding) });
    },
  });
  const buyerFor = buyerResolver({ ops, accounts, now });
  const passive = createPurchasesOff();
  const facade = {};
  for (const name of PURCHASE_SERVICE_PASSIVE) facade[name] = passive[name];
  for (const name of PURCHASE_SERVICE_ACTIVE) {
    facade[name] = async (args) => {
      if (!startupResult.ok) throw refused();
      const { accountId, wallet } = buyerFor(args);
      const service = await open(accountId, wallet);
      return service[name](args);
    };
  }
  const purchases = Object.freeze(facade);
  const starts = createStartIntents({ purchases, accounts, chain, now });
  const delivery = createAgreementCreateDelivery({ db, starts, gates: { purchasesOn: () => true, stopped, bindingCause: () => startupResult.failureCode }, now });
  const recorderFactory = readActivationSeams(undefined, { recorderNamespace }).evidenceRecorderFactory;
  // The admission the evidence recorder takes after a failed startup binding. The recorder checks only its shape. It
  // admits no purchase action: bindTp1Profile did not make its binding, so the wire's binding check refuses it, and its
  // currentLocal throws the startup failure.
  const passiveOnlyAdmission = () => Object.freeze({ binding: Object.freeze({ state: 'refused', code: startupResult.failureCode }),
    currentLocal: () => { throw refused(); } });
  let ports = null;
  return Object.freeze({
    startupResult, owner, listings, purchases, starts, delivery, relayAccess: createRelayAccess({ db, now }),
    bindingState: startupResult.ok ? { state: 'bound', recordId: TP1_APPROVED_IDENTITY_RECORD.recordId } : { state: 'refused', code: startupResult.failureCode },
    verifier: atStartup?.verifier ?? Object.freeze({ verify: async () => { throw refused(); } }),
    startupRefusal: (operationId, token) => (!startupResult.ok && ops.getByHandoff(operationId, token) ? refused() : null),
    /**
     * Returns the frozen evidence ports `{ delivery, starts, purchases, readPurchase, recorder, chain, journal }`, the
     * process's own members by reference. `readPurchase(operationId, token)` is the purchase its handoff token
     * authenticates, or null. `recorder` is built once, over `journal` and the startup admission (a passive-only one
     * when the startup binding failed or timed out), when the recorder subpath and a journal are both given; else
     * null. A repeat call returns the same ports; throws TypeError for another journal.
     */
    createSwitchOnEvidencePorts({ journal = null } = {}) {
      if (ports && ports.journal !== journal) throw new TypeError('the evidence ports are already bound to another journal');
      ports ??= Object.freeze({ delivery, starts, purchases, chain, journal, readPurchase: (operationId, token) => ops.getByHandoff(operationId, token),
        recorder: recorderFactory && journal ? recorderFactory({ admission: atStartup?.admission ?? passiveOnlyAdmission(), journal }) : null });
      return ports;
    },
    close: () => owner?.close(),
  });
}

/**
 * Throws OperationError sdk_part_missing naming the client parts the native
 * wallet relay needs before it can be mounted with no server-held buyer key:
 * P19's keyless stop seam and P19f's fee ceiling. The installed client has
 * neither, so it always throws, before any wallet session or transport exists.
 */
export function requireNativeRelayParts() {
  throw new OperationError('sdk_part_missing', 'sdk_part_missing: P19 stopped; P19f feeCeilingOs');
}
