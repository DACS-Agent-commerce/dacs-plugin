// Built-in OAuth 2.1 authorization server for ChatGPT account linking, using
// oidc-provider (an established, certified OpenID provider library) rather
// than a hand-written protocol. Configuration:
//  - authorization code + PKCE S256 required for every client;
//  - RFC 8707 resource indicators: access tokens are RFC 9068 JWTs whose
//    audience is exactly this MCP resource;
//  - RFC 9207 `iss` in every authorization response (oidc-provider default);
//  - DCR (RFC 7591) and Client ID Metadata Documents restricted to allowlisted
//    hosts and redirect origins;
//  - user authentication is a wallet signature over a one-use challenge bound
//    to this interaction, client, scopes and resource (see portal/authorize).
import Provider, { errors } from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { createSqliteAdapter } from './oidc-adapter.mjs';
import { RESOURCE_SCOPES } from './scopes.mjs';

const OIDC_SCOPES = ['openid', 'offline_access'];

// Server signing keys (not user keys), generated once and persisted so tokens
// survive restart. ES256 signs access tokens; RS256 is kept for ID tokens of
// clients that register the OIDC default algorithm.
async function loadOrCreateSigningKey(db, name, alg) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  if (row) return JSON.parse(row.value);
  const { privateKey } = await generateKeyPair(alg, { extractable: true, ...(alg === 'RS256' ? { modulusLength: 2048 } : {}) });
  const jwk = { ...(await exportJWK(privateKey)), alg, use: 'sig', kid: `dacs-${alg.toLowerCase()}-${Date.now().toString(36)}` };
  db.prepare('INSERT OR IGNORE INTO secrets (name, value, created_at) VALUES (?, ?, ?)').run(name, JSON.stringify(jwk), new Date().toISOString());
  return JSON.parse(db.prepare('SELECT value FROM secrets WHERE name = ?').get(name).value);
}

function publicJwk(jwk) {
  const { d, ...pub } = jwk;
  return pub;
}

function redirectAllowed(uri, allowedOrigins) {
  if (typeof uri !== 'string' || /[\u0000-\u0020\u007f#*\\]/.test(uri)) return false;
  const authority = /^https?:\/\/([^/?#]*)/.exec(uri);
  if (!authority || !authority[1] || /[%\\]/.test(authority[1])) return false;
  // Inspect the raw path before URL parsing removes dot segments. Encoded
  // dots count too, including mixed forms such as .%2e and %2e.
  const path = uri.slice(authority[0].length).split('?')[0];
  if (path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return false;
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return false;
    if (url.href !== uri) return false;
    // oidc-provider sets response parameters through URLSearchParams. Require
    // stable query bytes and keep its response keys out of client metadata.
    const query = uri.indexOf('?');
    if (query !== -1 && (uri.slice(query + 1) !== url.searchParams.toString() || query === uri.length - 1)) return false;
    if (['code', 'state', 'error', 'error_description', 'error_uri', 'iss'].some((key) => url.searchParams.has(key))) return false;
    return allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

// With DACS_ALLOW_LOOPBACK_REDIRECTS=1 (default off): a native client's HTTP
// sign-in callback on exactly 127.0.0.1, [::1] or localhost, any port (RFC
// 8252). Check the supplied authority: URL normalizes numeric and shortened
// IP aliases. Every redirectAllowed rule but the origin allowlist still applies.
function loopbackRedirectAllowed(uri) {
  if (typeof uri !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?(?:[/?]|$)/.test(uri)) return false;
  return redirectAllowed(uri, [URL.parse(uri)?.origin]);
}

export async function createAuthorizationServer({ config, db, accounts, now = () => Date.now(), logger = null }) {
  const signingJwk = await loadOrCreateSigningKey(db, 'oauth-signing-jwk', 'ES256');
  const rsaJwk = await loadOrCreateSigningKey(db, 'oauth-signing-jwk-rs256', 'RS256');
  const Adapter = createSqliteAdapter(db, now);
  const resource = config.mcpUrl;
  const issuer = config.builtinIssuer;

  const provider = new Provider(issuer, {
    adapter: Adapter,
    jwks: { keys: [signingJwk, rsaJwk] },
    clients: [],
    // DACS scopes are listed here too so DCR clients may register them in
    // `scope` and discovery advertises them; the portal grants them both as
    // OIDC-level consent and as resource scopes bound to the MCP audience.
    scopes: [...OIDC_SCOPES, ...RESOURCE_SCOPES],
    claims: { openid: ['sub'] },
    cookies: {
      keys: config.cookieKeys,
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.publicOrigin.startsWith('https:') },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.publicOrigin.startsWith('https:') },
    },
    pkce: { required: () => true },
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    responseTypes: ['code'],
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      // Access tokens are bound to the MCP resource, so OIDC userinfo always
      // answered 401; ChatGPT treated that as a failed connection. Nothing in the
      // app consumes userinfo, so it is not enabled or advertised.
      userinfo: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: async (_ctx, clientId) => {
          try {
            const url = new URL(clientId);
            return url.protocol === 'https:' && config.cimdAllowedHosts.includes(url.hostname);
          } catch {
            return false;
          }
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => resource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (resourceIndicator !== resource) throw new errors.InvalidTarget('unknown resource');
          return {
            scope: RESOURCE_SCOPES.join(' '),
            audience: resource,
            accessTokenTTL: config.accessTokenTtlSeconds,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } },
          };
        },
      },
    },
    extraClientMetadata: {
      properties: ['redirect_uris', 'post_logout_redirect_uris'],
      validator(_ctx, key, value, metadata) {
        if (key === 'post_logout_redirect_uris' && value === undefined) return;
        // Sign-in callbacks only: logout redirects stay on the allowlist.
        const loopback = config.allowLoopbackRedirects && key === 'redirect_uris';
        const native = loopback && metadata.application_type === 'native';
        if (!Array.isArray(value) || (key === 'redirect_uris' && value.length === 0) || !value.every((uri) => redirectAllowed(uri, config.allowedRedirectOrigins) || (native && loopbackRedirectAllowed(uri)))) {
          throw new errors.InvalidRedirectUri(loopback ? 'redirect_uris must use an allowlisted origin or an enabled native HTTP loopback redirect' : `${key} must use an allowlisted origin`);
        }
      },
    },
    findAccount: async (_ctx, sub) => {
      const account = accounts.getAccount(sub);
      // On purpose: an account with no linked wallet is refused, so a refresh for it fails with invalid_grant.
      if (!account || accounts.listWallets(account.id).length === 0) return undefined;
      return { accountId: account.id, claims: async () => ({ sub: account.id }) };
    },
    interactions: { url: async (_ctx, interaction) => `/portal/authorize/${interaction.uid}` },
    ttl: {
      AccessToken: () => config.accessTokenTtlSeconds,
      AuthorizationCode: () => 60,
      Interaction: () => 10 * 60,
      // The sign-in session. Refresh tokens issued without offline_access are bound to it.
      Session: () => 24 * 60 * 60,
      Grant: () => 30 * 24 * 60 * 60,
      IdToken: () => 60 * 60,
      // Stored expiry only. Without offline_access (ChatGPT never requests it), oidc-provider's default
      // expiresWithSession binds the refresh token to the ~24 h sign-in Session above, so it stops working
      // when that session ends. Only an offline_access token can last the full 30 days.
      RefreshToken: () => 30 * 24 * 60 * 60,
    },
    // Issue a refresh token whenever the client allows the refresh_token grant, with or without
    // offline_access. Without offline_access it is session-bound (see ttl.RefreshToken).
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    clientBasedCORS: (_ctx, origin) => config.allowedRedirectOrigins.includes(origin),
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      const safe = String(out.error ?? 'error').replace(/[^a-z_]/gi, '');
      ctx.body = `<!doctype html><meta charset="utf-8"><title>Authorization error</title><p>Authorization failed: ${safe}</p>`;
    },
  });
  // Each provider owns its Client class. Override the two runtime matchers at
  // the point where oidc-provider checks the resolved client and actual URI
  // (including logout via id_token_hint). Native loopback port stripping must
  // not authorize an unregistered URI or a port outside our origin allowlist
  // (the one exception, with DACS_ALLOW_LOOPBACK_REDIRECTS=1, is below).
  const portStripping = provider.Client.prototype.redirectUriAllowed;
  provider.Client.prototype.redirectUriAllowed = function (uri) {
    return this.redirectUris.includes(uri) && redirectAllowed(uri, config.allowedRedirectOrigins);
  };
  provider.Client.prototype.postLogoutRedirectUriAllowed = function (uri) {
    return this.postLogoutRedirectUris.includes(uri) && redirectAllowed(uri, config.allowedRedirectOrigins);
  };
  // A native client's loopback sign-in callback may change only its port (RFC
  // 8252 section 7.3): oidc-provider's own matcher then requires the registered
  // host, path and query. Logout redirects stay exact.
  if (config.allowLoopbackRedirects) {
    const exact = provider.Client.prototype.redirectUriAllowed;
    provider.Client.prototype.redirectUriAllowed = function (uri) {
      return exact.call(this, uri) || (this.applicationType === 'native' && loopbackRedirectAllowed(uri) && portStripping.call(this, uri));
    };
  }
  // Resume and logout confirmation trust persisted validation from the process
  // that began the flow. Recheck when they resolve the client, before issuing a
  // code or using the stored destination (including authorization error paths).
  const findClient = provider.Client.find;
  provider.Client.find = async function (...args) {
    const client = await findClient.apply(this, args);
    const ctx = Provider.ctx;
    if (ctx?.oidc?.provider !== provider) return client;
    if (ctx.oidc.route === 'resume' && !client?.redirectUriAllowed(ctx.oidc.params.redirect_uri)) {
      throw new errors.InvalidRedirectUri();
    }
    if (ctx.oidc.route === 'end_session_confirm') {
      const uri = ctx.oidc.session.state.postLogoutRedirectUri;
      if (uri && !client?.postLogoutRedirectUriAllowed(uri)) {
        // Account switching uses a provider-generated resume URL, rather than
        // an RP callback. Accept only the exact destination of a live
        // interaction belonging to this same client.
        const uid = new URL(uri).pathname.split('/').pop();
        const interaction = await provider.Interaction.find(uid);
        const internalResume = interaction?.returnTo === uri
          && interaction.params.client_id === client?.clientId
          && uri === ctx.oidc.urlFor('resume', { uid });
        if (!internalResume) throw new errors.InvalidRequest('post_logout_redirect_uri not registered');
      }
    }
    return client;
  };
  if (config.trustProxy) provider.proxy = true;
  // Error codes only (never codes, tokens, assertions or request bodies), so a
  // failed client authentication or grant exchange is visible to the operator.
  if (logger) for (const event of ['grant.error', 'authorization.error', 'server_error']) {
    provider.on(event, (ctx, error) => {
      let client = null;
      try { client = ctx?.oidc?.client?.clientId ?? null; client = client && /^https:/.test(client) ? new URL(client).origin : client ? 'registered' : null; } catch { client = null; }
      logger.info('oauth_error', { event, error: error?.error ?? error?.name ?? 'error', description: String(error?.error_description ?? error?.message ?? '').slice(0, 200), client });
    });
  }

  return {
    provider,
    issuer,
    // Only the access-token key is accepted by the resource server.
    publicJwks: { keys: [publicJwk(signingJwk)] },
    callback: provider.callback(),
    purgeExpired: () => Adapter.purgeExpired(),
  };
}
