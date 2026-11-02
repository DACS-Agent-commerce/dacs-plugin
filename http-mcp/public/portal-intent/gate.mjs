// Wallet-side gate for one approved purchase intent (DACS_INTENT_APPROVAL=on).
//
// It wraps the embedded wallet UI's approve(request) for exactly one SDK
// session (sdk-provider.mjs createSdkWalletSession). Outside a Start every
// request goes to the normal dialog unchanged. During a Start:
//  - the buyer sees one dialog with the intent in plain words (intent.mjs);
//  - each later signature is allowed only for a message this gate derived
//    itself from a structured draft it checked against the intent, once, for
//    this wallet address, before the intent expires;
//  - the one covered wallet write (the Agreement CREATE) is allowed only when
//    the wallet's own approval request matches the intent and the Agreement
//    this gate checked, within the fee ceiling and at the planned nonce, and
//    the session issues it only if no drop happened since (fenceJournal);
//  - anything else is refused without a dialog, and the reason is kept.
// The intent lives only in this gate's memory: a lock, a new session, a
// reload, the end of the Start, a newer Start (in this tab or, through
// announce/peerStarted, another tab with the same wallet) drops it, and the
// next Start asks again. Every drop advances a generation: a dialog, a check,
// a signature or an approved write still pending from an older Start can
// neither revive its intent, nor sign under the newer one, nor be issued.
// The one exception to "derived and checked" is the operator RPC auth
// signatures the SDK session makes inside the Agreement CREATE request
// (intent.mjs OPERATOR_AUTH_SIGNATURES): the wallet builds those bytes itself
// from its address and clock, and the dialog lists them. Until the session
// issues the CREATE, fenceSdk holds every step of that request to this Start:
// each SDK signature, node request and source phase (except the lease
// release) is checked before it starts and again before its answer is used.
// A dropped or expired Start gets nothing more signed and no new request,
// except lease release; an in-flight request and its SDK retries cannot be
// recalled. Its answer is discarded. The Start gets no write
// dialog, and no issuance. Once issued, the CREATE is broadcast once and read
// back as before; a later drop changes nothing about it.
import {
  IntentMismatch, describeIntent, identityMessage, delegationMessage, agreementMessage,
  anchorAuthorizationMessage, brokerChallengeMessage, checkAgreementCreate,
  OPERATOR_AUTH_SIGNATURES, OPERATOR_AUTH_TOTAL,
} from './intent.mjs';

export const INTENT_APPROVAL_METHOD = 'approvePurchaseIntent';
// What one tab tells the others when it opens a Start (start.mjs channel).
export const START_ANNOUNCEMENT = 'dacs-chatgpt-plugin/start-intent/opened/v1';
// Requests that only sign a message; every other approval is for a wallet write.
const MESSAGE_METHODS = ['sign', 'getWeb2IdentityProofPayload'];
export { OPERATOR_AUTH_SIGNATURES, OPERATOR_AUTH_TOTAL };

// announce(message): optional, tells other tabs a Start is opening.
export function createIntentGate({ approve, checkDelegation = null, now = () => Date.now(), announce = null, claimSignature = null } = {}) {
  if (typeof approve !== 'function') throw new TypeError('createIntentGate needs the wallet approve function');
  let session = null;
  let intent = null;
  let generation = 0; // advances on every open and every drop
  let opening = null; // the wallet of an open() still waiting for its dialog
  let used = new Set();
  let permit = null; // { step, message, address } for the one signature in flight
  let create = null; // { agreementHash } once the Agreement is checked
  let bundleHash = null;
  let presentedAt = null;
  let agreementHash = null;
  let spentOs = 0n;
  let refusal = null;
  let sdkError = null; // the session's EmbeddedWalletError class, once fenceSdk ran
  // Generation of the covered write this gate approved, until the session
  // issues it. Not reset by a drop: a drop is what it is checked against.
  let issuing = null;
  // The scope of the Agreement CREATE request in flight (coverCreate), until
  // the wallet answers it. Not reset by a drop either, for the same reason.
  let createRequest = null;

  const live = () => Boolean(session && !session.isLocked() && session.getPublicAccount()?.address === intent?.wallet);
  function end() {
    generation += 1;
    intent = null;
    opening = null;
    used = new Set();
    permit = null;
    create = null;
    bundleHash = null;
    presentedAt = null;
    agreementHash = null;
    spentOs = 0n;
  }
  // Throws when a newer Start or a drop happened since `mine` was taken.
  function alive(mine) {
    if (mine !== generation) throw new IntentMismatch('superseded', 'a newer purchase start, a lock or another tab replaced this one; start again');
  }
  function current(step) {
    if (!intent) throw new IntentMismatch('intent', 'no purchase start is approved in this wallet session');
    if (now() >= intent.expiresAt) { end(); throw new IntentMismatch('expiry', 'the approved purchase start expired; start again'); }
    if (!live()) { end(); throw new IntentMismatch('wallet', 'the wallet was locked or replaced; start again'); }
    if (step && !intent.steps.includes(step)) throw new IntentMismatch('step', `this purchase start does not cover ${step}`);
    if (step && used.has(step)) throw new IntentMismatch('step', `${step} was already signed under this approval`);
    return intent;
  }

  // The session's approval seam. Pass-through unless a Start is active.
  async function gatedApprove(request) {
    // The session runs one write at a time and issues each right after its
    // own approval, so a write approval replaces any earlier one.
    if (!MESSAGE_METHODS.includes(request?.method)) issuing = null;
    // A write inside this Start's CREATE request after the Start was dropped
    // gets no dialog: it is refused as the session's own error.
    if (createRequest && sdkError && !MESSAGE_METHODS.includes(request?.method)) holdCreate(createRequest, sdkError);
    if (!intent) return approve(request);
    try {
      current();
      const mine = generation;
      if (request?.method === 'sign') {
        if (!permit || request.message !== permit.message || request.address !== permit.address) throw new IntentMismatch('bytes', 'the wallet was asked to sign bytes it did not derive for this purchase');
        current(permit.step);
        used.add(permit.step);
        permit = null;
        return true;
      }
      if (request?.method === 'sendTransaction' && request.content?.kind !== undefined) {
        if (!create || used.has('agreementCreate')) throw new IntentMismatch('write', 'no wallet write is expected now');
        current('agreementCreate');
        if (request.address !== intent.wallet) throw new IntentMismatch('parties', 'the wallet write is for a different wallet');
        const { totalOs } = await checkAgreementCreate(intent, request.content, { agreementHash: create.agreementHash, spentOs });
        alive(mine);
        current('agreementCreate');
        spentOs += totalOs;
        used.add('agreementCreate');
        create = null;
        issuing = mine;
        return true;
      }
      throw new IntentMismatch('step', `the wallet was asked for ${typeof request?.method === 'string' ? request.method : 'an unknown action'}, which this purchase start does not cover`);
    } catch (error) {
      refusal = error instanceof IntentMismatch ? error : new IntentMismatch('internal', 'the request could not be checked');
      permit = null;
      return false;
    }
  }

  async function signDerived(step, message, mine) {
    alive(mine);
    current(step);
    const checked = intent;
    if (claimSignature) await claimSignature(checked, step);
    alive(mine);
    current(step);
    const mineToSign = { step, message, address: intent.wallet };
    permit = mineToSign;
    refusal = null;
    let answer;
    try {
      answer = await session.request({ method: 'sign', params: [message] });
    } finally {
      if (permit === mineToSign) permit = null;
    }
    alive(mine);
    if (answer?.success === true && typeof answer.data?.signature === 'string') return answer.data.signature;
    if (refusal) throw refusal;
    throw new IntentMismatch('wallet', `the wallet did not sign (${answer?.error?.code ?? 'no answer'})`);
  }

  // A refusal of the covered write: kept as the reason the buyer is told, and
  // returned as the session's own error. The broker has already handed this
  // write to the wallet, so the refusal closes the purchase as rejected: the
  // session must report it as its own error, not as an internal failure.
  function decline(error, WalletError, reason = null) {
    refusal = error instanceof IntentMismatch ? error : new IntentMismatch('internal', 'the request could not be checked');
    const why = reason ?? (refusal.field === 'superseded' ? 'a newer purchase start, a lock or another tab replaced this one while the wallet was preparing the Agreement record' : refusal.message.slice('Nothing was signed: '.length));
    refusal.message = `Nothing was sent: ${why}. The wallet declined the write, so this purchase is closed and nothing was paid; prepare a new purchase if you still want it`;
    return new WalletError(refusal.field, refusal.message);
  }

  // Called by the session's journal immediately before it records the write
  // as issued and broadcasts it once: the last check. The Start that approved
  // the write must still be the current one, live and unexpired. Inside the
  // CREATE request this is also where its scope becomes issued: from here on
  // the fence lets the one broadcast and its readback run as before.
  function beforeIssue(WalletError) {
    const approvedIn = issuing;
    issuing = null;
    const scope = createRequest && !createRequest.issued ? createRequest : null;
    if (approvedIn !== null && approvedIn !== generation) {
      const stopped = decline(new IntentMismatch('superseded', ''), WalletError, 'a newer purchase start, a lock or another tab replaced this one after the wallet write was approved');
      if (scope) scope.stopped ??= refusal;
      throw stopped;
    }
    if (approvedIn !== null && !scope) {
      try { current(); } catch (error) { throw decline(error, WalletError); }
    }
    if (scope) {
      holdCreate(scope, WalletError);
      scope.issued = true;
    }
  }

  // Inside the CREATE request until it is issued: before each step the
  // request makes without a dialog (an SDK signature, node request or source
  // phase; auth names the operator RPC auth signature it makes, if any), again
  // before that step's answer is used, before the write's own approval and at
  // issuance. A Start dropped, locked or expired meanwhile gets nothing more
  // signed or sent, has an answer that arrives after the drop discarded, and
  // gets no write dialog; once one step is refused, so is every later one.
  // After issuance only the auth-signature bound applies.
  function holdCreate(scope, WalletError, auth = null) {
    if (scope.stopped) throw new WalletError(scope.stopped.field, scope.stopped.message);
    try {
      if (!scope.issued) {
        alive(scope.mine);
        current();
      }
      if (auth !== null) {
        const used = (scope.auth.get(auth) ?? 0) + 1;
        const bound = Object.hasOwn(OPERATOR_AUTH_SIGNATURES, auth) ? OPERATOR_AUTH_SIGNATURES[auth] : 0;
        if (used > bound) throw new IntentMismatch('step', `the wallet was asked for more than the ${OPERATOR_AUTH_TOTAL} operator RPC auth signatures the Agreement record uses (another ${auth} one)`);
        // broadcastTx only once the record is issued; the others only before.
        if ((auth === 'broadcastTx') !== scope.issued) throw new IntentMismatch('step', `the wallet was asked for the ${auth} operator RPC auth signature ${scope.issued ? 'after' : 'before'} the Agreement record was issued`);
        scope.auth.set(auth, used);
      }
    } catch (error) {
      // After issuance only the refused request fails: the issued record is
      // read back as before, and the purchase is not declined.
      if (scope.issued) throw new WalletError(error.field ?? 'internal', error.message);
      const stopped = decline(error, WalletError);
      scope.stopped = refusal;
      throw stopped;
    }
  }

  return Object.freeze({
    approve: gatedApprove,
    // The session's SDK class with every step of the Agreement CREATE request
    // fenced by this gate (start.mjs passes it through the hooked
    // embedded-wallet bridge). Outside that request it works as DemosCtor does.
    // WalletError: that session's EmbeddedWalletError class.
    fenceSdk(DemosCtor, WalletError) {
      if (typeof DemosCtor !== 'function' || typeof WalletError !== 'function') throw new TypeError('fenceSdk needs the SDK class and the wallet session error class');
      sdkError = WalletError;
      // Checked before the step starts and again before its answer is used.
      const fenced = async (step, auth = null) => {
        const scope = createRequest;
        if (!scope) return step();
        holdCreate(scope, WalletError, auth);
        const answer = await step();
        holdCreate(scope, WalletError);
        return answer;
      };
      return class FencedDemos extends DemosCtor {
        // The source bind and signature auth (sdk-provider.mjs sourceAuthHeaders).
        async signMessage(message, options) { return fenced(() => super.signMessage(message, options), 'source'); }
        // Every node request the SDK makes: reads (nodeCall), and confirmTx and
        // broadcastTx, which Demos.call signs with an operator RPC auth
        // signature of its own.
        async call(method, message, data, extra, ...rest) { return fenced(() => super.call(method, message, data, extra, ...rest), method === 'nodeCall' ? null : String(extra)); }
        async connect(url) { return fenced(() => super.connect(url)); }
        // The CREATE transaction's own signature.
        async sign(transaction, options) { return fenced(() => super.sign(transaction, options)); }
        // Each source phase, through sdk-provider.mjs's switch-on hook
        // (src/portal/intent-hooks.mjs), before anything is sent. bind,
        // signature and broadcast are held to the Start. release is not: it
        // only frees the source lease, signs nothing and sends nothing for the
        // record, and must still run after a refusal.
        holdSourcePhase(phase) {
          const scope = createRequest;
          if (!scope || phase === 'release') return;
          holdCreate(scope, WalletError);
        }
      };
    },
    get fencesSdk() { return sdkError !== null; },
    // The provider the broker hands this Start's one Agreement CREATE to:
    // the same request(), with every step inside it fenced by this Start
    // (fenceSdk) until it is issued. One-shot: its scope, and with it the
    // auth-signature bound, is taken here, so a second invocation is refused
    // instead of starting a fresh allowance.
    coverCreate(provider) {
      current('agreementCreate');
      const scope = { mine: generation, auth: new Map(), issued: false, stopped: null };
      let invoked = false;
      return Object.freeze({
        request: async (args) => {
          if (invoked) throw new IntentMismatch('step', 'this start\'s Agreement CREATE was already handed to the wallet once; it is never requested again');
          invoked = true;
          if (createRequest) throw new IntentMismatch('step', 'another Agreement CREATE request is still running in this wallet');
          createRequest = scope;
          try {
            const answer = await provider.request(args);
            // The session can wrap a refused node read, confirm or signature
            // in its own failure (nodeRead and confirmed catch them); report
            // the fence's reason, as the buyer is told.
            if (scope.stopped && !scope.issued && answer?.success === false && answer.data == null) return { success: false, data: null, error: { code: scope.stopped.field, message: scope.stopped.message } };
            return answer;
          } finally {
            if (createRequest === scope) createRequest = null;
          }
        },
      });
    },
    attach(value) { session = value; },
    // The session's anchor journal (sdk-provider.mjs get/put/withWalletLock),
    // with the issuance of a write approved under a dropped Start stopped.
    // WalletError: that session's EmbeddedWalletError class.
    fenceJournal(journal, WalletError) {
      if (!journal) return journal;
      if (typeof WalletError !== 'function') throw new TypeError('fenceJournal needs the wallet session error class');
      return {
        get: (key) => journal.get(key),
        put: async (key, value) => { beforeIssue(WalletError); return journal.put(key, value); },
        withWalletLock: (key, work) => journal.withWalletLock(key, work),
      };
    },
    get active() { return Boolean(intent); },
    get lastRefusal() { return refusal; },
    // The one Start dialog. Resolves only when the person approves it and no
    // newer Start or drop happened while the dialog was open.
    async open(next) {
      end();
      const mine = generation;
      if (!session || session.isLocked() || session.getPublicAccount()?.address !== next?.wallet) throw new IntentMismatch('wallet', 'connect and unlock the wallet bound to this purchase');
      if (now() >= next.expiresAt) throw new IntentMismatch('expiry', 'the purchase start expired before approval');
      opening = next.wallet;
      announce?.({ type: START_ANNOUNCEMENT, wallet: next.wallet });
      const ok = await approve({ method: INTENT_APPROVAL_METHOD, address: next.wallet, purpose: `Approve one bounded purchase start. Each later purchase signature is checked automatically against exactly these values${next.steps?.includes('agreementCreate') ? '; the operator RPC auth signatures listed with the Agreement record are built by the wallet itself' : ''}.`, message: describeIntent(next) });
      alive(mine);
      opening = null;
      if (ok !== true) throw new IntentMismatch('rejected', 'you did not approve the purchase start');
      if (!session || session.isLocked() || session.getPublicAccount()?.address !== next.wallet || now() >= next.expiresAt) throw new IntentMismatch('wallet', 'the wallet was locked or replaced, or the start expired, during approval');
      intent = next;
      return intent;
    },
    // Another tab opened a Start: one Start per wallet across tabs.
    peerStarted(message) {
      if (message?.type === START_ANNOUNCEMENT && typeof message.wallet === 'string' && (message.wallet === intent?.wallet || message.wallet === opening)) end();
    },
    // Each takes the server's structured draft, never bytes.
    async signIdentity(bundle) {
      const checked = current('identity');
      const mine = generation;
      const derived = await identityMessage(checked, bundle, { now: now() });
      const signature = await signDerived('identity', derived.message, mine);
      bundleHash = derived.bundleHash;
      presentedAt = derived.presentedAt;
      return signature;
    },
    // Already presented (resume): checked and bound, nothing signed.
    async noteIdentity(bundle) {
      const checked = current();
      const mine = generation;
      const derived = await identityMessage(checked, bundle, { now: now() });
      alive(mine);
      bundleHash = derived.bundleHash;
      presentedAt = derived.presentedAt;
      used.add('identity');
    },
    async signDelegation(payload) {
      const mine = generation;
      const { message } = delegationMessage(current('delegation'), payload, { now: now(), check: checkDelegation });
      return signDerived('delegation', message, mine);
    },
    noteDelegation() {
      current();
      used.add('delegation');
    },
    async signAgreement(draft) {
      const checked = current('agreement');
      const mine = generation;
      if (!bundleHash) throw new IntentMismatch('parties', 'the identity presentation was not checked first');
      const derived = await agreementMessage(checked, draft, { bundleHash, presentedAt, now: now() });
      const signature = await signDerived('agreement', derived.message, mine);
      agreementHash = derived.agreementHash;
      return signature;
    },
    async noteAgreement(draft) {
      const checked = current();
      const mine = generation;
      if (!bundleHash) throw new IntentMismatch('parties', 'the identity presentation was not checked first');
      const derived = await agreementMessage(checked, draft, { bundleHash, presentedAt, now: now() });
      alive(mine);
      agreementHash = derived.agreementHash;
      used.add('agreement');
    },
    async signAnchorAuthorization() {
      const mine = generation;
      return signDerived('anchorAuthorization', anchorAuthorizationMessage(current('anchorAuthorization'), agreementHash).message, mine);
    },
    async signBrokerChallenge(message, { origin }) {
      const mine = generation;
      const derived = brokerChallengeMessage(current('brokerSession'), message, { origin, agreementHash, now: now() });
      return signDerived('brokerSession', derived.message, mine);
    },
    // Arms the one covered write for the Agreement this gate checked.
    expectAgreementCreate() {
      current('agreementCreate');
      if (!agreementHash) throw new IntentMismatch('agreement', 'the Agreement was not checked first');
      create = { agreementHash };
      refusal = null;
    },
    finish: end,
  });
}
