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
 * Builds a frozen object with one async method per listed name. A `passive`
 * name rejects OperationError `not_configured` with the message
 * `sdk_part_missing: <part> <name>` of `missing`, the absent part the read
 * needs. An `active` name rejects OperationError `sdk_purchases_off`. The
 * methods keep no state and call nothing.
 *
 * Throws TypeError when a name is listed as both passive and active.
 */
export function createRefusalObject({ passive, active, missing }) {
  const both = passive.filter((name) => active.includes(name));
  if (both.length > 0) throw new TypeError(`listed as both passive and active: ${both.join(', ')}`);
  const refusal = {};
  for (const name of passive) {
    refusal[name] = async () => {
      throw new OperationError('not_configured', `sdk_part_missing: ${missing.part} ${missing.name}`, { part: missing.part, name: missing.name });
    };
  }
  for (const name of active) {
    refusal[name] = async () => {
      throw new OperationError('sdk_purchases_off', 'SDK purchases are off on this server, so this purchase action is refused');
    };
  }
  return Object.freeze(refusal);
}
