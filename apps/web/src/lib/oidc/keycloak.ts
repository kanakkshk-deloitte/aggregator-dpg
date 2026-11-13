/**
 * Keycloak adapter for the OIDC port.
 *
 * Uses openid-client for the OIDC Authorization Code + PKCE flow. Sends a
 * client secret only when one is configured. Discovery is cached after first use.
 */

import { Issuer, generators, custom, type Client, type IssuerMetadata } from 'openid-client';

// Timeout for every IdP HTTP call (discovery, token exchange, refresh, userinfo).
const HTTP_TIMEOUT_MS = 10_000;
Issuer[custom.http_options] = (_url, options) => ({ ...options, timeout: HTTP_TIMEOUT_MS });
import {
  IdentityProviderAdapter,
  type AuthorizationUrlInput,
  type ExchangeCodeInput,
  type IdClaims,
  type LogoutUrlInput,
  type OidcResult,
  type TokenSet,
} from './interface';
import { logger } from '../logger';

export interface KeycloakAdapterOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  defaultScope?: string;
}

export class KeycloakAdapter extends IdentityProviderAdapter {
  private clientPromise: Promise<Client> | null = null;
  private readonly defaultScope: string;

  constructor(private readonly opts: KeycloakAdapterOptions) {
    super();
    this.defaultScope = opts.defaultScope ?? 'openid profile email';
  }

  private async getClient(): Promise<Client> {
    if (this.clientPromise) return this.clientPromise;
    const promise = (async () => {
      const issuer = await Issuer.discover(this.opts.issuerUrl);
      const client = new issuer.Client({
        client_id: this.opts.clientId,
        ...(this.opts.clientSecret
          ? { client_secret: this.opts.clientSecret }
          : { token_endpoint_auth_method: 'none' }),
        response_types: ['code'],
      });
      client[custom.http_options] = (_url, options) => ({
        ...options,
        timeout: HTTP_TIMEOUT_MS,
      });
      return client;
    })();
    // Share the in-flight promise; clear it on failure so a later call retries.
    promise.catch(() => {
      if (this.clientPromise === promise) this.clientPromise = null;
    });
    this.clientPromise = promise;
    return promise;
  }

  async buildAuthorizationUrl(input: AuthorizationUrlInput): Promise<string> {
    const client = await this.getClient();
    return client.authorizationUrl({
      scope: input.scope ?? this.defaultScope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: input.redirectUri,
    });
  }

  async exchangeCode(
    input: ExchangeCodeInput,
  ): Promise<OidcResult<{ tokens: TokenSet; claims: IdClaims }>> {
    if (input.state !== input.expectedState) {
      return {
        ok: false,
        error: { code: 'STATE_MISMATCH', message: 'state parameter does not match' },
      };
    }
    let tokenSet;
    try {
      const client = await this.getClient();
      // Pass all callback params so `iss` (RFC 9207) and `session_state` are included.
      const callbackParams: Record<string, string> = {
        ...(input.callbackParams ?? {}),
        code: input.code,
        state: input.state,
      };
      tokenSet = await client.callback(input.redirectUri, callbackParams, {
        code_verifier: input.codeVerifier,
        state: input.expectedState,
        nonce: input.expectedNonce,
      });
    } catch (err) {
      // OPError carries the IdP's `error` and `error_description`; log both.
      const e = err as {
        message?: string;
        name?: string;
        error?: string;
        error_description?: string;
        response?: { statusCode?: number; body?: unknown };
      };
      const detail =
        e.error_description || e.error
          ? `${e.error ?? ''}: ${e.error_description ?? ''}`.trim()
          : (e.message ?? 'unknown error');
      logger.error(
        {
          operation: 'oidc.exchangeCode',
          status: 'failure',
          code: 'TOKEN_EXCHANGE_FAILED',
          err_name: e.name,
          idp_error: e.error,
          idp_error_description: e.error_description,
          idp_status: e.response?.statusCode,
          cause: e.message,
          hint: 'openid-client.callback() rejected. Inspect idp_error for the precise OAuth2 reason.',
        },
        'oidc token exchange failed',
      );
      return {
        ok: false,
        error: {
          code: 'TOKEN_EXCHANGE_FAILED',
          message: detail,
        },
      };
    }
    if (!tokenSet.access_token || !tokenSet.refresh_token || !tokenSet.id_token) {
      return {
        ok: false,
        error: {
          code: 'TOKEN_EXCHANGE_FAILED',
          message: 'incomplete token set from issuer',
        },
      };
    }
    const claims = tokenSet.claims();
    return {
      ok: true,
      value: {
        tokens: {
          accessToken: tokenSet.access_token,
          refreshToken: tokenSet.refresh_token,
          idToken: tokenSet.id_token,
          accessTokenExp: tokenSet.expires_at
            ? tokenSet.expires_at * 1000
            : Date.now() + 5 * 60_000,
          refreshTokenExp: extractRefreshExp(tokenSet.refresh_token),
          ...(tokenSet.scope ? { scope: tokenSet.scope } : {}),
        },
        claims: mapClaims(claims),
      },
    };
  }

  async refresh(refreshToken: string): Promise<OidcResult<TokenSet>> {
    try {
      const client = await this.getClient();
      const tokenSet = await client.refresh(refreshToken);
      if (!tokenSet.access_token || !tokenSet.refresh_token || !tokenSet.id_token) {
        return {
          ok: false,
          error: { code: 'REFRESH_FAILED', message: 'incomplete token set on refresh' },
        };
      }
      return {
        ok: true,
        value: {
          accessToken: tokenSet.access_token,
          refreshToken: tokenSet.refresh_token,
          idToken: tokenSet.id_token,
          accessTokenExp: tokenSet.expires_at
            ? tokenSet.expires_at * 1000
            : Date.now() + 5 * 60_000,
          refreshTokenExp: extractRefreshExp(tokenSet.refresh_token),
          ...(tokenSet.scope ? { scope: tokenSet.scope } : {}),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'REFRESH_FAILED',
          message: err instanceof Error ? err.message : 'unknown error',
        },
      };
    }
  }

  async buildLogoutUrl(input: LogoutUrlInput): Promise<string> {
    const client = await this.getClient();
    return client.endSessionUrl({
      // Without a token, send `client_id` so Keycloak validates the redirect URI.
      ...(input.idToken ? { id_token_hint: input.idToken } : { client_id: this.opts.clientId }),
      post_logout_redirect_uri: input.postLogoutRedirectUri,
    });
  }

  /** Test helper — exposes the underlying issuer metadata once discovered. */
  async _issuerMetadata(): Promise<IssuerMetadata> {
    const client = await this.getClient();
    return client.issuer.metadata;
  }
}

/**
 * PKCE + state + nonce helpers wrapping `openid-client` generators.
 */
export const oidcGenerators = {
  state: () => generators.state(),
  nonce: () => generators.nonce(),
  codeVerifier: () => generators.codeVerifier(),
  codeChallenge: (verifier: string) => generators.codeChallenge(verifier),
};

function extractRefreshExp(refreshToken: string): number {
  // Reads `exp` without verifying the signature; the token came straight
  // from the Keycloak token endpoint.
  const parts = refreshToken.split('.');
  if (parts.length !== 3) return Date.now() + 30 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    /* fall through */
  }
  return Date.now() + 30 * 60_000;
}

function mapClaims(claims: Record<string, unknown>): IdClaims {
  const out: IdClaims = { sub: String(claims.sub ?? '') };
  if (typeof claims.email === 'string') out.email = claims.email;
  if (typeof claims.email_verified === 'boolean') out.emailVerified = claims.email_verified;
  if (typeof claims.phone_number === 'string') out.phoneNumber = claims.phone_number;
  if (typeof claims.phone_number_verified === 'boolean')
    out.phoneNumberVerified = claims.phone_number_verified;
  if (typeof claims.name === 'string') out.name = claims.name;
  if (typeof claims.preferred_username === 'string')
    out.preferredUsername = claims.preferred_username;
  return out;
}
