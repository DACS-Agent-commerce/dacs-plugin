// Owner recovery for historical v1 listing publications. Publishing is retired;
// this keeps the account's historical agents readable (get_account_status) and
// the nonce-checked cancel of an unsent publication (cancel_wallet_handoff),
// which releases its wallet for purchases. Saved write coordinates are kept.
import { OperationError } from './operations.mjs';

// Returns `list` (each agent with its latest publication and saved coordinates)
// and `cancel`, which throws `not_found` or `invalid_state` instead of cancelling.
export function createLegacyPublicationService({ db, ops, coordinates, chain }) {
  const agentsForAccount = db.prepare('SELECT * FROM agents WHERE account_id = ? ORDER BY created_at');
  const hydrateAgent = (row) => row && { id: row.id, accountId: row.account_id, wallet: row.wallet_address, listingId: row.listing_id, profile: JSON.parse(row.profile), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };

  function list(accountId) {
    return agentsForAccount.all(accountId).map(hydrateAgent).map((agent) => {
      const operation = ops.listForSubject(accountId, 'listing_publication', agent.id)[0] ?? null;
      return { agent, operation, coordinates: operation ? coordinates.get(operation.id) : null };
    });
  }

  // Cancel a publication that has not been written: allowed before handoff,
  // or during handoff while the wallet nonce is unchanged.
  async function cancel({ accountId, operationId }) {
    const operation = ops.get(accountId, operationId);
    if (!operation || operation.kind !== 'listing_publication') throw new OperationError('not_found', 'publication not found for this account');
    if (!['awaiting_identity_signature', 'awaiting_listing_signature', 'listing_signed', 'publication_handoff'].includes(operation.status)) {
      throw new OperationError('invalid_state', `publication is ${operation.status} and cannot be cancelled`);
    }
    const coords = coordinates.get(operation.id);
    if (coords) {
      const nonce = await chain.getAddressNonce(operation.terms.wallet);
      if (nonce !== coords.nonceFence) throw new OperationError('invalid_state', 'cancel refused: wallet nonce advanced since handoff; use verify_agent_publication');
    }
    return { operation: ops.transition(operation.id, operation.status, 'cancelled', { data: { reason: 'cancelled by account owner' } }), cancelled: true };
  }

  return { list, cancel };
}
