/**
 * OIDC identity-provider contract.
 *
 * The portal BFF uses only this class. Another IdP can be supported by adding
 * a subclass.
 */

export interface AuthorizationUrlInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  scope?: string;
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
  expectedState: string;
  expectedNonce: string;
  /** All callback query params, needed for RFC 9207 `iss` verification. */
  callbackParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
  scope?: string;
}

export interface IdClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  name?: string;
  preferredUsername?: string;
}

export interface LogoutUrlInput {
  /**
   * Ends the IdP session without Keycloak's logout prompt.
   *
   * Omit when no token is held; the logout then uses `client_id` and the IdP
   * asks the user to confirm. One realm serves both DPGs, so this also ends
   * the Signals session.
   */
  idToken?: string | undefined;
  postLogoutRedirectUri: string;
}

export type OidcResult<T> = { ok: true; value: T } | { ok: false; error: OidcError };

export type OidcError =
  | { code: 'DISCOVERY_FAILED'; message: string }
  | { code: 'STATE_MISMATCH'; message: string }
  | { code: 'TOKEN_EXCHANGE_FAILED'; message: string }
  | { code: 'TOKEN_VERIFY_FAILED'; message: string }
  | { code: 'REFRESH_FAILED'; message: string };

/**
 * Abstract identity-provider port.
 */
export abstract class IdentityProviderAdapter {
  abstract buildAuthorizationUrl(input: AuthorizationUrlInput): Promise<string>;
  abstract exchangeCode(
    input: ExchangeCodeInput,
  ): Promise<OidcResult<{ tokens: TokenSet; claims: IdClaims }>>;
  abstract refresh(refreshToken: string): Promise<OidcResult<TokenSet>>;
  abstract buildLogoutUrl(input: LogoutUrlInput): Promise<string>;
}
