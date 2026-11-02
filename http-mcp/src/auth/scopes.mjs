// OAuth scopes for the MCP resource. Search and listing reads are anonymous;
// everything account-bound requires a token carrying the listed scope.
export const SCOPES = Object.freeze({
  ACCOUNT_READ: 'dacs.account.read',
  AGENTS_WRITE: 'dacs.agents.write',
  PURCHASES_WRITE: 'dacs.purchases.write',
  // Proposed (offline candidate, not reviewed): preparing Demos identity
  // add/remove actions that the user's own wallet must approve. Distinct from
  // the agent and purchase scopes on purpose.
  IDENTITIES_WRITE: 'dacs.identities.write',
});

export const RESOURCE_SCOPES = Object.freeze(Object.values(SCOPES));

export const SCOPE_DESCRIPTIONS = Object.freeze({
  [SCOPES.ACCOUNT_READ]: 'See your DACS plugin profile, linked wallets, agents and operation status',
  [SCOPES.AGENTS_WRITE]: 'Legacy v1 agent scope; Listing publication is unavailable in v2',
  [SCOPES.PURCHASES_WRITE]: 'Prepare fixed-price DEM testnet purchases that your wallet must separately approve',
  [SCOPES.IDENTITIES_WRITE]: 'Prepare adding or removing public Demos identity links (GitHub, Twitter) that your wallet must separately approve',
});
