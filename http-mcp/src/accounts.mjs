// Accounts are keyed by the authenticated (issuer, subject) pair, never by a
// model-supplied value. Each wallet links to exactly one account, and only
// through a consumed, verified wallet challenge.
import { transaction, isUniqueViolation } from './store/database.mjs';
import { newId } from './util/ids.mjs';

export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createAccountService({ db, builtinIssuer, now = () => Date.now() }) {
  const byId = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const bySubject = db.prepare('SELECT * FROM accounts WHERE auth_issuer = ? AND auth_subject = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, auth_issuer, auth_subject, display_name, created_at) VALUES (?, ?, ?, ?, ?)');
  const walletByAddress = db.prepare('SELECT * FROM wallets WHERE address = ?');
  const walletsByAccount = db.prepare('SELECT address, scheme, linked_at FROM wallets WHERE account_id = ? ORDER BY linked_at');
  const insertWallet = db.prepare('INSERT INTO wallets (address, account_id, scheme, linked_at, link_challenge_id) VALUES (?, ?, ?, ?, ?)');

  const iso = () => new Date(now()).toISOString();

  function getAccount(id) {
    return byId.get(id) ?? null;
  }

  // Built-in issuer: a verified wallet login resolves (or creates) the account
  // that owns the wallet. The account id doubles as the token subject.
  function loginWithWallet({ address, challengeId }) {
    return transaction(db, () => {
      const wallet = walletByAddress.get(address);
      if (wallet) return getAccount(wallet.account_id);
      const id = newId('acct');
      insertAccount.run(id, builtinIssuer, id, null, iso());
      insertWallet.run(address, id, 'ed25519', iso(), challengeId);
      return getAccount(id);
    });
  }

  function linkWallet({ accountId, address, challengeId }) {
    return transaction(db, () => {
      const existing = walletByAddress.get(address);
      if (existing) {
        if (existing.account_id === accountId) return { linked: true, alreadyLinked: true };
        throw new AccountError('wallet_linked_elsewhere', 'this wallet is already linked to a different account');
      }
      try {
        insertWallet.run(address, accountId, 'ed25519', iso(), challengeId);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AccountError('wallet_linked_elsewhere', 'this wallet is already linked');
        throw error;
      }
      return { linked: true, alreadyLinked: false };
    });
  }

  // Resolve the account for a verified access token. For the built-in issuer
  // the subject must be an existing account; an external issuer's subject is
  // provisioned on first use and mapped to a stable opaque account id.
  function resolveFromToken({ issuer, subject }) {
    if (issuer === builtinIssuer) {
      const account = getAccount(subject);
      if (!account || account.auth_issuer !== builtinIssuer) throw new AccountError('unknown_account', 'token subject is not a known account');
      return account;
    }
    const found = bySubject.get(issuer, subject);
    if (found) return found;
    return transaction(db, () => {
      const again = bySubject.get(issuer, subject);
      if (again) return again;
      const id = newId('acct');
      insertAccount.run(id, issuer, subject, null, iso());
      return getAccount(id);
    });
  }

  function listWallets(accountId) {
    return walletsByAccount.all(accountId).map((w) => ({ address: w.address, scheme: w.scheme, linkedAt: w.linked_at }));
  }

  function walletOwner(address) {
    return walletByAddress.get(address)?.account_id ?? null;
  }

  return { getAccount, loginWithWallet, linkWallet, resolveFromToken, listWallets, walletOwner };
}
