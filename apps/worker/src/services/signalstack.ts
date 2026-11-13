/**
 * Signals writer factory for the worker app.
 *
 * Returns a singleton writer when SIGNALSTACK_BASE_URL and the credentials for
 * SIGNALSTACK_AUTH_MODE are set, or `null` when the push is disabled.
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

  if (config.SIGNALSTACK_AUTH_MODE === 'bearer') {
    const { SIGNALSTACK_CLIENT_ID: clientId, SIGNALSTACK_CLIENT_SECRET: clientSecret } = config;
    const { KEYCLOAK_URL: keycloakUrl } = config;
    // Signals may trust a different realm from this app's users.
    // Falls back to KEYCLOAK_REALM.
    const keycloakRealm = config.SIGNALSTACK_KEYCLOAK_REALM || config.KEYCLOAK_REALM;
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
    timeoutMs: config.SIGNALSTACK_TIMEOUT_MS,
  });
  return writer;
}

/** Test helper — inject a fake or null to disable. */
export function _setSignalStackWriter(w: SignalStackWriterBase | null): void {
  writer = w;
}
