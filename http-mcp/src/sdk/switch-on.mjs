// The SDK purchases on composition.
//
// At startup it binds the SDK's approved TP-1 identity record over the node
// connection DACS_CHAIN_RPC_URL names, once, within 10 s. A refused or timed-out
// binding keeps the server up: passive readers answer as with SDK purchases off,
// and every purchase action refuses with the binding's own tp1_* code until the
// server restarts.
//
// After a successful startup binding, each buyer session (an account and one of
// its linked wallets) gets its own authority reader, binding, listing verifier,
// protocol object and purchase service. They are built on the session's first
// purchase action and never shared. A session's claim is its wallet's, which the
// wallet-link challenge proved; a wallet named in a request only selects among
// the account's own linked wallets. The server holds no buyer key and opens no
// wallet journal. The client's stop seam, fee ceiling, HTTPS seller client and
// wallet handoff have no public names yet, so they are not composed here.
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { OperationError, createAuthorityReader, createListingVerifier, createProtocolPurchases, createPurchaseService, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
import { createNodeAuthorityCapability, createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { claimForAddress } from '../wallet/demos-signature.mjs';
import { PURPOSES } from '../wallet/challenges.mjs';
import { PURCHASE_SERVICE_ACTIVE, PURCHASE_SERVICE_PASSIVE, createPurchasesUnbound } from './activation-seams.mjs';
import { loadParticipantEnrollment } from './participant-enrollment.mjs';

// K0's deadline for one TP-1 binding, at startup and for each buyer session.
const BINDING_DEADLINE_MS = 10_000;
const TP1_CODE = /^tp1_[a-z0-9_]{1,59}$/;

/** Binds the SDK record over `owner`'s connection with `reader`, rejecting OperationError tp1_authority_timeout after the deadline. */
async function bindWithinDeadline(owner, reader) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationError('tp1_authority_timeout', 'the TP-1 binding did not finish in time')), BINDING_DEADLINE_MS);
  });
  try {
    return await Promise.race([bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: reader }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// A failure's own tp1_* code; a node that could not be read leaves the connection unverified.
const tp1Code = (error) => (TP1_CODE.test(error?.code) ? error.code : 'tp1_connection_unverified');

// The account must still own the wallet, and in builtin mode it must still have a live sign-in session.
function sessionLiveness({ db, accounts, authMode, now }) {
  const signIn = db.prepare("SELECT 1 FROM oidc_models WHERE model = 'Session' AND json_extract(payload, '$.accountId') = ? AND (expires_at IS NULL OR expires_at > ?)");
  return ({ accountId, wallet }) => accounts.walletOwner(wallet) === accountId
    && (authMode !== 'builtin' || signIn.get(accountId, Math.floor(now() / 1000)) !== undefined);
}

// The buyer sessions, keyed by account and wallet. A session is checked on every call and dropped once it ends;
// building a new one first sweeps the ended ones. A call that already holds a session's objects keeps them.
function createBuyerSessions({ live, build }) {
  const sessions = new Map();
  return async function open(accountId, wallet) {
    const key = JSON.stringify([accountId, wallet]);
    if (!live({ accountId, wallet })) {
      sessions.delete(key);
      throw new OperationError('session_ended', 'this wallet is no longer linked to a signed-in account, so its purchase session has ended');
    }
    if (!sessions.has(key)) {
      for (const [other, session] of sessions) if (!live(session)) sessions.delete(other);
      const objects = build(wallet);
      sessions.set(key, { accountId, wallet, objects });
      objects.catch(() => { if (sessions.get(key)?.objects === objects) sessions.delete(key); });
    }
    return sessions.get(key).objects;
  };
}

// The linked wallet a purchase call acts for. A call naming an operation acts for that operation's buyer wallet;
// prepare acts for the requested or only wallet of the account. Either way the account must own the wallet.
function buyerResolver({ ops, accounts }) {
  const owned = (accountId, wallet) => {
    if (accounts.walletOwner(wallet) !== accountId) throw new OperationError('wallet_not_linked', 'that wallet is not linked to your account');
    return { accountId, wallet };
  };
  return (args = {}) => {
    if (args.operationId !== undefined) {
      const operation = args.token !== undefined ? ops.getByHandoff(args.operationId, args.token) : ops.get(args.accountId, args.operationId);
      if (!operation) throw new OperationError('not_found', 'operation not found');
      return owned(operation.accountId, operation.terms.buyer.wallet);
    }
    const wallets = accounts.listWallets(args.accountId).map((w) => w.address);
    if (wallets.length === 0) throw new OperationError('wallet_required', 'link a wallet to your account before purchasing (start_wallet_link)');
    if (!args.walletAddress && wallets.length > 1) throw new OperationError('wallet_ambiguous', 'several wallets are linked; specify walletAddress');
    return owned(args.accountId, args.walletAddress || wallets[0]);
  };
}

/**
 * Builds the SDK purchases on composition after binding at startup.
 *
 * Returns `{ purchases, verifier, binding, gates, close }`: the purchase service
 * routes and tools call (frozen, with the client service's member names), the
 * listing verifier for get_listing, the startup binding state for /health
 * (`{ state: 'bound', recordId }` or `{ state: 'refused', code }`), the gates
 * the CREATE delivery reads, and `close`, which closes the node connection.
 * Never rejects for a failed binding; rejects only with a database error.
 */
export async function composeSdkPurchasesOn({ config, db, accounts, ops, coordinates, challenges, directory, chain, fetchImpl, now, logger, stopped }) {
  const shared = { db, config, ops, coordinates, accounts, chain, challenges, now, logger, store: createSqlitePurchaseStore(), purposes: PURPOSES };
  const registered = new Set();
  const listings = { isRegistered: (seller) => registered.has(seller) };
  const purchases = { findByJobId: (jobId) => ops.findByJobId(jobId) };
  let owner = null;
  let startup;
  try {
    if (!config.chain) throw new OperationError('chain_rpc_unset', 'DACS_CHAIN_RPC_URL is not set');
    owner = createNodeTransportOwner({ endpoint: new URL(config.chain.rpcUrl).href, transportAuthority: config.tp1TransportAuthority, fetchImpl });
  } catch (error) {
    startup = { code: 'tp1_local_binding_invalid', cause: error.code };
  }
  let participantImplementations;
  try {
    participantImplementations = startup ? null : await loadParticipantEnrollment({ dataDir: config.dataDir });
  } catch (error) {
    startup = { code: tp1Code(error), cause: error.detail ?? error.code ?? 'unknown' };
  }
  const readerFor = (claim) => createAuthorityReader({ authority: createNodeAuthorityCapability({ owner, claim }), identityRecord: TP1_APPROVED_IDENTITY_RECORD,
    claim, listings, purchases, participantImplementations });
  // A verified Listing registers its seller; nothing else does.
  const registering = (verifier) => Object.freeze({
    async verify(args) {
      const result = await verifier.verify(args);
      if (result?.transactable === true && result.seller === args?.seller) registered.add(result.seller);
      return result;
    },
  });
  const objectsFor = (binding) => {
    const admission = { binding, currentLocal: owner.currentLocal };
    const verifier = registering(createListingVerifier({ admission, directory, chain }));
    const protocol = createProtocolPurchases({ admission, db, ops, coordinates, store: shared.store, fetchImpl, now });
    return { verifier, service: createPurchaseService({ ...shared, admission, verifier, protocol }) };
  };

  // The startup binding's objects serve the passive readers and get_listing; no purchase action reaches them.
  let passive = null;
  if (!startup) {
    try {
      passive = objectsFor(await bindWithinDeadline(owner, readerFor(() => null)));
    } catch (error) {
      startup = { code: tp1Code(error), cause: error?.code ?? 'unknown' };
    }
  }
  const close = () => owner?.close();
  const gates = { purchasesOn: () => true, stopped, bindingCause: () => startup?.code ?? null };
  if (startup) {
    logger.warn('tp1_startup_binding_refused', startup);
    const refuse = async () => { throw new OperationError(startup.code, 'the TP-1 binding at startup failed, so listing verification is refused until the server restarts', { cause: startup.cause }); };
    return { purchases: createPurchasesUnbound(startup.code, startup.cause), verifier: Object.freeze({ verify: refuse }), binding: { state: 'refused', code: startup.code }, gates, close };
  }

  const open = createBuyerSessions({
    live: sessionLiveness({ db, accounts, authMode: config.authMode, now }),
    async build(wallet) {
      const claim = claimForAddress(wallet);
      try {
        return objectsFor(await bindWithinDeadline(owner, readerFor(() => claim)));
      } catch (error) {
        throw new OperationError('profile_not_admitted', 'the TP-1 binding for this purchase session failed', undefined, { cause: error });
      }
    },
  });
  const buyerFor = buyerResolver({ ops, accounts });
  const facade = {};
  for (const name of PURCHASE_SERVICE_PASSIVE) facade[name] = (...args) => passive.service[name](...args);
  for (const name of PURCHASE_SERVICE_ACTIVE) {
    facade[name] = async (args) => {
      const { accountId, wallet } = buyerFor(args);
      const { service } = await open(accountId, wallet);
      return service[name](args);
    };
  }
  return { purchases: Object.freeze(facade), verifier: passive.verifier, binding: { state: 'bound', recordId: TP1_APPROVED_IDENTITY_RECORD.recordId }, gates, close };
}
