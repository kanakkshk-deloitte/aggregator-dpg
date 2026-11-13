/**
 * Browser-side auth service for the web app.
 *
 * Calls only the BFF (`/api/auth/*`). Tokens stay server-side in Redis.
 */

import type { User } from '../types';

interface MeResponse {
  user: {
    sub: string;
    email?: string;
    phone?: string;
    name?: string;
  };
}

/**
 * Fetches the active user from the BFF.
 *
 * @returns User profile or `null` if unauthenticated.
 * @throws {Error} When the request fails with a status other than 401.
 */
export async function fetchCurrentUser(): Promise<User | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
  const data = (await res.json()) as MeResponse;
  return {
    id: data.user.sub,
    name: data.user.name ?? data.user.email ?? data.user.phone ?? data.user.sub,
    org: data.user.email ?? '',
  };
}

/** Logs out through the BFF, which ends the session and the Keycloak session. */
export function logout(): void {
  window.location.href = '/api/auth/logout';
}

/**
 * Triggers BFF login — redirects to Keycloak.
 *
 * @param returnTo - Path to land on after successful auth.
 */
export function login(returnTo: string = '/'): void {
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
