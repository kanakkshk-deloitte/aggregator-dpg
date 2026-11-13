/**
 * IdP admin adapter factory (`@aggregator-dpg/api`). Returns a process-wide singleton.
 *
 * Required env (when not overridden by `_setIdpAdmin` in tests):
 *   - KEYCLOAK_URL                  base URL, e.g. http://keycloak:8080
 *   - KEYCLOAK_REALM                e.g. aggregator
 *   - KEYCLOAK_ADMIN_CLIENT_ID      service-account client id
 *   - KEYCLOAK_ADMIN_CLIENT_SECRET  service-account client secret
 */

import { KeycloakIdpAdmin } from './keycloak.js';
import type { IdpAdminAdapter } from './interface.js';

export { IDP_PROVIDER } from './provider.js';

let instance: IdpAdminAdapter | null = null;

/**
 * Returns the shared IdP admin adapter.
 */
export function getIdpAdmin(): IdpAdminAdapter {
  if (instance) return instance;
  const baseUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  if (!baseUrl || !realm || !clientId || !clientSecret) {
    throw new Error(
      'KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_ADMIN_CLIENT_ID, KEYCLOAK_ADMIN_CLIENT_SECRET must be set',
    );
  }
  instance = new KeycloakIdpAdmin({ baseUrl, realm, clientId, clientSecret });
  return instance;
}

/** Test helper — replace the singleton. */
export function _setIdpAdmin(a: IdpAdminAdapter | null): void {
  instance = a;
}

export { IdpAdminAdapter } from './interface.js';
export type { CreateUserInput, IdpUser, IdpResult, IdpError } from './interface.js';
export { IdpAdminFake } from './testing.js';
export { KC_ATTR, OWNER_CREATED_BY, OWNER_REALM_ROLE } from './attributes.js';
export type { KcAttrName } from './attributes.js';
