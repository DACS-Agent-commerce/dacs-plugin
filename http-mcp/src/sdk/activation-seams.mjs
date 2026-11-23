// The SDK purchase parts the plugin reads from the client namespace, and the
// refusal object handed on in place of a purchase reader or service when a
// part is absent or SDK purchases are off.
//
// A part is read by name from the namespace, never by a named import, so an
// absent part is reported as missing instead of failing the module load. Only
// parts with a fixed public name are listed here.
import * as installedClient from '@kynesyslabs/dacs-client';
import { OperationError } from '@kynesyslabs/dacs-client';

const EVIDENCE_RECORDER = Object.freeze({ part: 'P19r', name: 'createPurchaseEvidenceRecorder' });
const NAMED_PARTS = Object.freeze([EVIDENCE_RECORDER]);
// The client's passive purchase reader has no fixed public name, so a refusal names its part alone.
const PASSIVE_READER = Object.freeze({ part: 'P19' });
// The client purchase service's passive readers, as its createPurchaseService documentation lists them, and its
// other members, each a purchase action.
export const PURCHASE_SERVICE_PASSIVE = Object.freeze(['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning']);
export const PURCHASE_SERVICE_ACTIVE = Object.freeze(['prepare', 'issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane',
  'reportWalletResult', 'cancel', 'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck']);
const purchasesOff = () => new OperationError('sdk_purchases_off', 'SDK purchases are off on this server, so this purchase action is refused');

/**
 * Reads the named SDK purchase parts from `namespace` (the installed client
 * by default). Returns a frozen `{ evidenceRecorderFactory, missing }`: the
 * evidence recorder factory or null, and the `{ part, name }` of each named
 * part that is not a function in the namespace.
 */
export function readActivationSeams(namespace = installedClient) {
  const present = (name) => typeof namespace[name] === 'function';
  return Object.freeze({
    evidenceRecorderFactory: present(EVIDENCE_RECORDER.name) ? namespace[EVIDENCE_RECORDER.name] : null,
    missing: Object.freeze(NAMED_PARTS.filter(({ name }) => !present(name))),
  });
}

/**
 * Builds a frozen object with one method per listed name. A `passive` name
 * throws OperationError `not_configured` at the call, as the passive readers
 * it stands in for answer synchronously; the message is
 * `sdk_part_missing: <part> <name>` of `missing`, the absent part the read
 * needs (`<part>` alone when it has no public name). An `active` name is async
 * and rejects the error `refuse()` returns, by default OperationError
 * `sdk_purchases_off`. The methods keep no state and call nothing else.
 *
 * Throws TypeError when a name is listed as both passive and active.
 */
export function createRefusalObject({ passive, active, missing, refuse = purchasesOff }) {
  const both = passive.filter((name) => active.includes(name));
  if (both.length > 0) throw new TypeError(`listed as both passive and active: ${both.join(', ')}`);
  const missingText = missing.name ? `${missing.part} ${missing.name}` : missing.part;
  const refusal = {};
  for (const name of passive) {
    refusal[name] = () => {
      throw new OperationError('not_configured', `sdk_part_missing: ${missingText}`, { part: missing.part, name: missing.name });
    };
  }
  for (const name of active) {
    refusal[name] = async () => {
      throw refuse();
    };
  }
  return Object.freeze(refusal);
}

/**
 * Returns the purchase service handed to routes and tools while SDK purchases
 * are off: a refusal object with the client purchase service's member names.
 * Its passive readers throw `not_configured` naming the passive reader's part;
 * every purchase action rejects `sdk_purchases_off`.
 */
export function createPurchasesOff() {
  return createRefusalObject({ passive: PURCHASE_SERVICE_PASSIVE, active: PURCHASE_SERVICE_ACTIVE, missing: PASSIVE_READER });
}

/**
 * Returns the purchase service handed to routes and tools when SDK purchases
 * are on but the startup TP-1 binding failed: passive readers answer as with
 * SDK purchases off, and every purchase action rejects OperationError `code`
 * (the binding's own `tp1_*` code) with details `{ cause }`, the failure's own code.
 */
export function createPurchasesUnbound(code, cause) {
  return createRefusalObject({ passive: PURCHASE_SERVICE_PASSIVE, active: PURCHASE_SERVICE_ACTIVE, missing: PASSIVE_READER,
    refuse: () => new OperationError(code, 'the TP-1 binding at startup failed, so purchase actions are refused until the server restarts', { cause }) });
}

/**
 * The listing verifier handed to get_listing while SDK purchases are off: no
 * verifier is built, and `verify` rejects OperationError `not_configured` with
 * details `{ reason: 'sdk_purchases_off' }`.
 */
export const LISTING_VERIFICATION_OFF = Object.freeze({
  async verify() {
    throw new OperationError('not_configured', 'listing verification is off while SDK purchases are off', { reason: 'sdk_purchases_off' });
  },
});
