// What the portal tells the buyer when the client answers approve or handoff with a refusal code and no
// transaction. The text is this plugin's own; nothing from the seller, the listing or the client's message is
// repeated. `approvalValid` is true only where the client states that the approval stays; the portal treats any
// other value as not valid and offers no retry that reuses the approval.
const REFUSALS = Object.freeze({
  listing_recheck_unavailable: { approvalValid: true, retryRead: true,
    message: 'The listing could not be checked again just now. Nothing was signed or sent, and your approval stays valid. Try again shortly.' },
  payment_terms_cancelled: { approvalValid: false, retryRead: false,
    message: 'This payment would repeat a cancelled purchase\'s payment terms, so it was not offered for signing and nothing was sent. Cancel this purchase and prepare it again.' },
  node_build_unreviewed: { approvalValid: null, retryRead: false,
    message: 'The node\'s software has not been reviewed for payments, so no transaction was offered and nothing was sent.' },
});
const UNRECOGNIZED = { approvalValid: null, retryRead: false, message: 'The payment was not offered for signing and nothing was sent.' };

/** Returns the frozen `{ code, approvalValid, retryRead, message }` for a refusal `code`; an unrecognized code gets the generic answer. */
export function handoffRefusal(code) {
  return Object.freeze({ code, ...(Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : UNRECOGNIZED) });
}
