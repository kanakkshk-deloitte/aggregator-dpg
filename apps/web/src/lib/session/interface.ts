/**
 * Session storage contract for the aggregator portal BFF.
 *
 * Redis and in-memory implementations extend this base. Portal code depends
 * only on this abstract class.
 */

import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

/**
 * The signed-in actor (`GET /v1/user/read/me`), cached briefly in the session.
 *
 * The database stays the authority; the cache saves one call per page.
 */
export interface CachedActor {
  me: MeResponse;
  /** Epoch ms when it was read. */
  at: number;
}

export interface SessionData {
  sub: string;
  email?: string;
  phone?: string;
  name?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
  createdAt: number;
  lastSeenAt: number;
  /** Console actor cache; absent until the console reads it. */
  consoleActor?: CachedActor;
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; error: SessionError };

export type SessionError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'STORE_UNAVAILABLE'; message: string }
  | { code: 'CORRUPT'; message: string };

/**
 * Abstract base for any session store. BFF code uses only this class.
 */
export abstract class SessionStoreBase {
  abstract create(data: SessionData): Promise<string>;
  abstract get(sid: string): Promise<SessionResult<SessionData>>;
  abstract update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>>;
  abstract destroy(sid: string): Promise<void>;
  abstract close(): Promise<void>;
}
