/**
 * Keycloak service-account token client.
 *
 * Used only by anonymous, pre-session BFF routes (e.g. registration). Gets a
 * `client_credentials` token for the `aggregator-bff` client. Never use it for
 * routes that act for a signed-in user; use `callApi` there.
 *
 * Tokens are cached in-process until 30s before expiry.
 */

import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const REFRESH_LEAD_MS = 30_000;

let cached: CachedToken | null = null;

interface ServiceTokenConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

function readConfig(): ServiceTokenConfig {
  const issuer = stripTrailingSlashes(mustEnv('OIDC_ISSUER'));
  return {
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    clientId: mustEnv('BFF_SERVICE_CLIENT_ID'),
    clientSecret: mustEnv('BFF_SERVICE_CLIENT_SECRET'),
  };
}

/**
 * Returns a service-account access token, fetching a new one when the cached
 * token is missing or near expiry.
 *
 * @returns The access token.
 * @throws {Error} If config is missing or Keycloak returns an error.
 */
export async function getServiceAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - REFRESH_LEAD_MS) {
    return cached.accessToken;
  }
  const cfg = readConfig();
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', cfg.clientId);
  params.set('client_secret', cfg.clientSecret);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`service-token HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cached.accessToken;
}

/** Test helper — clear the cache. */
export function _resetServiceToken(): void {
  cached = null;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
