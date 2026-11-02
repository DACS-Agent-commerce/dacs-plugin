// Resource-server token verification (MCP OAuthTokenVerifier contract).
// The same code verifies tokens from the built-in issuer and from an external
// issuer: signature against the issuer's JWKS, exact `iss`, `aud` equal to this
// MCP resource, exp/nbf, and scope parsing. Nothing about the token is trusted
// before these checks pass.
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { fetchBoundedJson } from '../util/http.mjs';

const ALGORITHMS = ['ES256', 'RS256', 'PS256', 'EdDSA'];

function parseScopes(payload, scopeClaim) {
  const value = payload[scopeClaim];
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  if (Array.isArray(value)) return value.filter((s) => typeof s === 'string');
  return [];
}

export function createTokenVerifier({ issuer, audience, keySet, scopeClaim = 'scope', requireAtJwtType = false, clockToleranceSeconds = 5 }) {
  return {
    issuer,
    async verifyAccessToken(token) {
      let result;
      try {
        result = await jwtVerify(token, keySet, {
          issuer,
          audience,
          algorithms: ALGORITHMS,
          requiredClaims: ['exp', 'sub', 'iat'],
          clockTolerance: clockToleranceSeconds,
          ...(requireAtJwtType ? { typ: 'at+jwt' } : {}),
        });
      } catch (error) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, error?.code === 'ERR_JWT_EXPIRED' ? 'access token expired' : 'access token is invalid for this resource');
      }
      const { payload } = result;
      return {
        token,
        clientId: String(payload.client_id ?? payload.azp ?? 'unknown-client'),
        scopes: parseScopes(payload, scopeClaim),
        expiresAt: payload.exp,
        resource: new URL(audience),
        extra: { issuer: payload.iss, subject: String(payload.sub) },
      };
    },
  };
}

export function builtinTokenVerifier({ issuer, audience, publicJwks }) {
  return createTokenVerifier({ issuer, audience, keySet: createLocalJWKSet(publicJwks), requireAtJwtType: true });
}

// Discover an external issuer (RFC 8414 / OIDC discovery), check it supports
// what ChatGPT requires (S256 PKCE, exact issuer), and build a JWKS verifier.
export async function discoverExternalIssuer({ issuer, jwksUri, audience, scopeClaim, requireAtJwtType = false, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const url = new URL(issuer);
  const pathPart = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${pathPart}`,
    `${url.origin}${pathPart}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/openid-configuration${pathPart}`,
  ];
  let metadata = null;
  for (const candidate of candidates) {
    try {
      metadata = await fetchBoundedJson(candidate, { fetchImpl, timeoutMs, maxBytes: 256 * 1024, expectedOrigin: url.origin });
      break;
    } catch {
      metadata = null;
    }
  }
  if (!metadata) throw new Error(`external issuer metadata unavailable for ${issuer}`);
  if (metadata.issuer !== issuer) throw new Error('external issuer metadata `issuer` does not exactly match DACS_OAUTH_ISSUER');
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) {
    throw new Error('external issuer does not advertise S256 PKCE, which ChatGPT requires');
  }
  const jwks = jwksUri ?? metadata.jwks_uri;
  if (!jwks) throw new Error('external issuer has no jwks_uri');
  if (new URL(jwks).origin !== url.origin && new URL(jwks).protocol !== 'https:') throw new Error('external jwks_uri must use https');
  const keySet = createRemoteJWKSet(new URL(jwks), { timeoutDuration: timeoutMs });
  return {
    metadata,
    verifier: createTokenVerifier({ issuer, audience, keySet, scopeClaim, requireAtJwtType }),
  };
}
