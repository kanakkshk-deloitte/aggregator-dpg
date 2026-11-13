/**
 * Unit tests for the IdP admin adapter factory.
 *
 * Covers the singleton caching behaviour, the required-env validation
 * error, and the test-only override hook. `keycloak.js` is not mocked here
 * since construction alone (no network call) is cheap and exercised by
 * `keycloak.test.ts` in depth.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getIdpAdmin, _setIdpAdmin } from './index.js';
import { KeycloakIdpAdmin } from './keycloak.js';
import { IdpAdminFake } from './testing.js';

const ENV_KEYS = [
  'KEYCLOAK_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_ADMIN_CLIENT_ID',
  'KEYCLOAK_ADMIN_CLIENT_SECRET',
] as const;

describe('getIdpAdmin', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _setIdpAdmin(null);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    _setIdpAdmin(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('builds a KeycloakIdpAdmin from env vars on first call', () => {
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'aggregator-api';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    const admin = getIdpAdmin();
    expect(admin).toBeInstanceOf(KeycloakIdpAdmin);
  });

  it('caches the singleton across calls', () => {
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'aggregator-api';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    const a = getIdpAdmin();
    const b = getIdpAdmin();
    expect(a).toBe(b);
  });

  it.each(ENV_KEYS)('throws a descriptive error when %s is missing', (missing) => {
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'aggregator-api';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'secret';
    delete process.env[missing];
    expect(() => getIdpAdmin()).toThrow(/KEYCLOAK_URL, KEYCLOAK_REALM/);
  });

  it('_setIdpAdmin overrides the singleton for tests', () => {
    const fake = new IdpAdminFake();
    _setIdpAdmin(fake);
    expect(getIdpAdmin()).toBe(fake);
  });
});
