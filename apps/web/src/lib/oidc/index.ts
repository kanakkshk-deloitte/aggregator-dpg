/**
 * OIDC adapter factory.
 *
 * Reads env on first call and returns a process-wide singleton, so issuer
 * discovery happens once.
 */

import { KeycloakAdapter } from './keycloak';
import { type IdentityProviderAdapter } from './interface';

let instance: IdentityProviderAdapter | null = null;

/**
 * Returns the configured identity-provider adapter.
 *
 * Requires `OIDC_ISSUER` and `OIDC_CLIENT_ID`. Optional: `OIDC_CLIENT_SECRET`
 * (omit for a public client) and `OIDC_SCOPE` (default "openid profile email").
 *
 * @returns The shared adapter.
 * @throws {Error} If `OIDC_ISSUER` or `OIDC_CLIENT_ID` is unset.
 */
export function getOidcAdapter(): IdentityProviderAdapter {
  if (instance) return instance;
  const issuerUrl = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuerUrl || !clientId) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID must be set');
  }
  instance = new KeycloakAdapter({
    issuerUrl,
    clientId,
    ...(process.env.OIDC_CLIENT_SECRET ? { clientSecret: process.env.OIDC_CLIENT_SECRET } : {}),
    ...(process.env.OIDC_SCOPE ? { defaultScope: process.env.OIDC_SCOPE } : {}),
  });
  return instance;
}

/**
 * Test-only helper to swap the adapter (e.g. inject a fake).
 */
export function _setOidcAdapter(a: IdentityProviderAdapter | null): void {
  instance = a;
}

export { IdentityProviderAdapter } from './interface';
export type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  IdClaims,
  LogoutUrlInput,
  OidcError,
  OidcResult,
  TokenSet,
} from './interface';
export { oidcGenerators } from './keycloak';
