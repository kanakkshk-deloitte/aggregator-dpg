/**
 * In-memory OIDC adapter fake for tests.
 *
 * Returns seeded token sets with no network calls, so tests run without Keycloak.
 */

import {
  IdentityProviderAdapter,
  type AuthorizationUrlInput,
  type ExchangeCodeInput,
  type IdClaims,
  type LogoutUrlInput,
  type OidcResult,
  type TokenSet,
} from './interface';

/**
 * Origin for the fake's authorization and logout URLs. Never called; `https`
 * avoids cleartext URL literals.
 */
const FAKE_ISSUER = 'https://kc.fake';

interface SeededExchange {
  code: string;
  tokens: TokenSet;
  claims: IdClaims;
}

export class IdentityProviderFake extends IdentityProviderAdapter {
  private exchanges = new Map<string, SeededExchange>();
  private refreshResponses = new Map<string, OidcResult<TokenSet>>();
  private failNextExchange: { code: string; message: string } | null = null;

  /** Seeds a code-to-token mapping that the next `exchangeCode()` will return. */
  seedExchange(entry: SeededExchange): void {
    this.exchanges.set(entry.code, entry);
  }

  /** Seeds a refresh-token-to-token mapping. */
  seedRefresh(refreshToken: string, response: OidcResult<TokenSet>): void {
    this.refreshResponses.set(refreshToken, response);
  }

  /** Forces the next exchangeCode call to fail. */
  failExchangeOnce(error: { code: string; message: string }): void {
    this.failNextExchange = error;
  }

  async buildAuthorizationUrl(input: AuthorizationUrlInput): Promise<string> {
    const url = new URL(`${FAKE_ISSUER}/authorize`);
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', input.scope ?? 'openid profile email');
    return url.toString();
  }

  async exchangeCode(
    input: ExchangeCodeInput,
  ): Promise<OidcResult<{ tokens: TokenSet; claims: IdClaims }>> {
    if (input.state !== input.expectedState) {
      return {
        ok: false,
        error: { code: 'STATE_MISMATCH', message: 'state mismatch' },
      };
    }
    if (this.failNextExchange) {
      const e = this.failNextExchange;
      this.failNextExchange = null;
      return { ok: false, error: { code: 'TOKEN_EXCHANGE_FAILED', message: e.message } };
    }
    const seeded = this.exchanges.get(input.code);
    if (!seeded) {
      return {
        ok: false,
        error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'no seeded exchange' },
      };
    }
    return { ok: true, value: { tokens: seeded.tokens, claims: seeded.claims } };
  }

  async refresh(refreshToken: string): Promise<OidcResult<TokenSet>> {
    const seeded = this.refreshResponses.get(refreshToken);
    if (!seeded) {
      return { ok: false, error: { code: 'REFRESH_FAILED', message: 'no seeded refresh' } };
    }
    return seeded;
  }

  async buildLogoutUrl(input: LogoutUrlInput): Promise<string> {
    const url = new URL(`${FAKE_ISSUER}/logout`);
    if (input.idToken) url.searchParams.set('id_token_hint', input.idToken);
    else url.searchParams.set('client_id', 'fake-client');
    url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
    return url.toString();
  }
}

/**
 * Builds a default `TokenSet` with sensible expiries.
 */
export function buildTokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  const now = Date.now();
  return {
    accessToken: 'access-token-fake',
    refreshToken: 'refresh-token-fake',
    idToken: 'id-token-fake',
    accessTokenExp: now + 5 * 60_000,
    refreshTokenExp: now + 60 * 60_000,
    ...overrides,
  };
}

/**
 * Builds a default `IdClaims` payload.
 */
export function buildIdClaims(overrides: Partial<IdClaims> = {}): IdClaims {
  return {
    sub: 'kc-user-1',
    email: 'user@example.com',
    name: 'Test User',
    ...overrides,
  };
}
