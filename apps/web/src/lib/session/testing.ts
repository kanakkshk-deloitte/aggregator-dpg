/**
 * Public testing surface for the session store.
 *
 * Tests outside this module use this fake, not the in-memory store directly.
 */

import { MemorySessionStore } from './memory';
import type { SessionData } from './interface';

export class SessionStoreFake extends MemorySessionStore {
  /**
   * Pre-populates the store with sessions, bypassing `create()`.
   *
   * @param entries - Pairs of session ID and data to insert verbatim.
   */
  seed(entries: Array<{ sid: string; data: SessionData }>): void {
    for (const { sid, data } of entries) {
      // Test-only access to the protected store map.
      const store = (
        this as unknown as {
          store: Map<string, { data: SessionData; expiresAt: number }>;
        }
      ).store;
      store.set(sid, { data, expiresAt: Date.now() + 60 * 60 * 1000 });
    }
  }
}

/**
 * Builds a default `SessionData` payload for tests.
 *
 * @param overrides - Fields to override on the default.
 * @returns A valid session payload.
 */
export function buildSessionData(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    sub: 'test-user-1',
    email: 'test@example.com',
    phone: '+919876543210',
    name: 'Test User',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    idToken: 'test-id-token',
    accessTokenExp: now + 5 * 60 * 1000,
    refreshTokenExp: now + 60 * 60 * 1000,
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}
