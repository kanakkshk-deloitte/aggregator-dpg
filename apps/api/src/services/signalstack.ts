/**
 * Lazy SignalStack writer factory for the API process (`@aggregator-dpg/api`).
 *
 * Returns a singleton HttpSignalStackWriter when SIGNALSTACK_BASE_URL and the
 * credential for SIGNALSTACK_AUTH_MODE are set, else `null`. On `null`,
 * callers skip the push without logging.
 *
 * Tests inject a fake via `_setSignalStackWriter`.
 */

import type { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { HttpSignalStackWriter } from '@aggregator-dpg/signalstack-writer/http';
import { KeycloakClientCredentialsTokenProvider } from '@aggregator-dpg/signalstack-writer/keycloak-token-provider';
import { config } from '../config.js';
import { logger } from '../logger.js';

let writer: SignalStackWriterBase | null | undefined;

export function getSignalStackWriter(): SignalStackWriterBase | null {
  if (writer !== undefined) return writer;
  const baseUrl = config.SIGNALSTACK_BASE_URL;
  if (!baseUrl) {
    writer = null;
    return null;
  }
  const actingOrgId = config.SIGNALSTACK_ACTING_ORG_ID;
  if (!actingOrgId) {
    // Onboard and list work without an acting org; aggregator upsert fails
    // with SIGNALSTACK_CONFIG_MISSING. Warn the operator early.
    logger.warn({
      status: 'warn',
      sub: 'signalstack.init',
      message:
        'SIGNALSTACK_ACTING_ORG_ID not set — aggregator upsert will fail on approval and login fallback',
    });
  }

  if (config.SIGNALSTACK_AUTH_MODE === 'bearer') {
    const clientId = config.SIGNALSTACK_CLIENT_ID;
    const clientSecret = config.SIGNALSTACK_CLIENT_SECRET;
    const keycloakUrl = process.env.KEYCLOAK_URL;
    // Signals may trust a different realm from this app's users; defaults to KEYCLOAK_REALM.
    const keycloakRealm = process.env.SIGNALSTACK_KEYCLOAK_REALM || process.env.KEYCLOAK_REALM;
    if (!clientId || !clientSecret || !keycloakUrl || !keycloakRealm) {
      logger.warn({
        status: 'warn',
        sub: 'signalstack.init',
        message:
          'SIGNALSTACK_AUTH_MODE=bearer requires SIGNALSTACK_CLIENT_ID, SIGNALSTACK_CLIENT_SECRET, ' +
          'KEYCLOAK_URL, and SIGNALSTACK_KEYCLOAK_REALM (or KEYCLOAK_REALM) — push disabled',
      });
      writer = null;
      return null;
    }
    writer = new HttpSignalStackWriter({
      baseUrl,
      tokenProvider: new KeycloakClientCredentialsTokenProvider({
        baseUrl: keycloakUrl,
        realm: keycloakRealm,
        clientId,
        clientSecret,
      }),
      ...(actingOrgId ? { actingOrgId } : {}),
      timeoutMs: config.SIGNALSTACK_TIMEOUT_MS,
    });
    return writer;
  }

  const apiKey = config.SIGNALSTACK_ADMIN_KEY;
  if (!apiKey) {
    logger.warn({
      status: 'warn',
      sub: 'signalstack.init',
      message: 'SIGNALSTACK_BASE_URL set but SIGNALSTACK_ADMIN_KEY missing — push disabled',
    });
    writer = null;
    return null;
  }
  writer = new HttpSignalStackWriter({
    baseUrl,
    apiKey,
    ...(actingOrgId ? { actingOrgId } : {}),
    timeoutMs: config.SIGNALSTACK_TIMEOUT_MS,
  });
  return writer;
}

/** Test helper; injects a fake, or null to disable. */
export function _setSignalStackWriter(w: SignalStackWriterBase | null): void {
  writer = w;
}
