/**
 * Postgres adapter for the identity store (`user_identities`, migration 0027).
 *
 * Thin wrapper over `db/account-writes.ts`. Logs SQLSTATE only, never the
 * driver message (it includes query parameters).
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { userIdentities } from '../../db/schema.js';
import { pgErrorCode } from '../../db/pg-error.js';
import {
  IdentityMismatchError,
  IdentityNotLinkableError,
  IdentityTakenError,
  linkIdentity,
  subjectOf,
} from '../../db/account-writes.js';
import { logger } from '../../logger.js';
import { IdentityStoreBase, type IdentityStoreResult, type LinkOutcome } from './interface.js';

/** Postgres-backed {@link IdentityStoreBase}. */
export class PostgresIdentityStore extends IdentityStoreBase {
  /** {@inheritDoc IdentityStoreBase.link} */
  async link(
    userId: string,
    provider: string,
    subject: string,
    userType?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<LinkOutcome>> {
    try {
      return { ok: true, value: await linkIdentity(getDb(), userId, provider, subject, userType) };
    } catch (e) {
      if (e instanceof IdentityNotLinkableError) {
        return { ok: false, error: { code: 'NOT_LINKABLE', message: e.message } };
      }
      if (e instanceof IdentityTakenError) {
        return { ok: false, error: { code: 'DUPLICATE', message: e.message } };
      }
      if (e instanceof IdentityMismatchError) {
        return { ok: false, error: { code: 'MISMATCH', message: e.message } };
      }
      return dbFailure('identityStore.link', e);
    }
  }

  /** {@inheritDoc IdentityStoreBase.subjectOf} */
  async subjectOf(userId: string, provider: string): Promise<IdentityStoreResult<string | null>> {
    try {
      return { ok: true, value: await subjectOf(getDb(), userId, provider) };
    } catch (e) {
      return dbFailure('identityStore.subjectOf', e);
    }
  }

  /** {@inheritDoc IdentityStoreBase.userOf} */
  async userOf(provider: string, subject: string): Promise<IdentityStoreResult<string | null>> {
    try {
      const [row] = await getDb()
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)));
      return { ok: true, value: row?.userId ?? null };
    } catch (e) {
      return dbFailure('identityStore.userOf', e);
    }
  }
}

/**
 * Logs a driver failure (SQLSTATE only) and maps it to `DB_UNAVAILABLE`.
 *
 * @param op - Operation name for the log entry.
 * @param e - The thrown error.
 * @returns The failure result.
 */
function dbFailure(op: string, e: unknown): IdentityStoreResult<never> {
  const code = pgErrorCode(e);
  logger.warn({ operation: op, status: 'failure', sqlstate: code });
  return {
    ok: false,
    error: { code: 'DB_UNAVAILABLE', message: code ? `database error ${code}` : 'database error' },
  };
}
