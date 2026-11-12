// What the plugin tells a buyer about a purchase's status. The text comes from
// the client's public guidance; this module adds only the answer for a status
// the client does not know.
import { PURCHASE_STATUS_HELP, networkIdentityLabel, purchaseNext } from '@kynesyslabs/dacs-client';

/** The guidance for a status the client has no text for. It claims nothing about the purchase. */
export const STATUS_UNKNOWN_GUIDANCE = 'This purchase is in a state this plugin does not recognize. Nothing is confirmed. Check its status again before taking any step.';

const isKnownStatus = (status) => typeof status === 'string' && Object.hasOwn(PURCHASE_STATUS_HELP, status);

/** Returns the client's guidance text for `status`, or STATUS_UNKNOWN_GUIDANCE when the client does not know it. Never throws. */
export const statusGuidance = (status) => (isKnownStatus(status) ? PURCHASE_STATUS_HELP[status] : STATUS_UNKNOWN_GUIDANCE);

/** Returns the client's next-step text for `operation`, or STATUS_UNKNOWN_GUIDANCE when its status is unknown. Throws what the client's purchaseNext throws for a malformed operation. */
export const nextStepGuidance = (operation, chainMode) => (isKnownStatus(operation?.status) ? purchaseNext(operation, chainMode) : STATUS_UNKNOWN_GUIDANCE);

export { networkIdentityLabel };
