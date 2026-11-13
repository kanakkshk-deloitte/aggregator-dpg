/**
 * Writes to `users` admin accounts and `user_identities` (`@aggregator-dpg/api`).
 *
 * An org owner is an `admin` row of `users`: identity only, every
 * coordinator-only column NULL (`users_role_shape_chk`). These helpers run
 * inside the caller's transaction, so an org and its owner's account are written together.
 *
 * Login identities are provider-neutral (`provider`, `subject`) and belong to
 * the account, never to `contact`.
 */

import { and, eq, sql } from 'drizzle-orm';
import { userIdentities } from './schema.js';
import type { DbExecutor } from './contact-writes.js';

/**
 * Returns the admin account for `contactId`, creating it when absent.
 *
 * Holds the row (`FOR KEY SHARE`) until the transaction ends, so a concurrent
 * org delete cannot release it first. Retries once if it vanished.
 *
 * @param db - The caller's transaction.
 * @param contactId - The owner's contact id.
 * @returns The admin account's `users.id`.
 * @throws Error when the account cannot be created or held twice in a row.
 */
export async function linkAdminAccount(db: DbExecutor, contactId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Explicit NULLs: the role CHECK requires them on admin rows, and the column defaults are for coordinators.
    await db.execute(sql`
      INSERT INTO users (user_type, contact_id, status, profile, created_by, updated_by)
      VALUES ('admin', ${contactId}, NULL, NULL, 'self', 'self')
      ON CONFLICT (contact_id, user_type) DO NOTHING`);
    const held = await db.execute<{ id: string }>(sql`
      SELECT id FROM users
       WHERE contact_id = ${contactId} AND user_type = 'admin'
       FOR KEY SHARE`);
    const id = held.rows[0]?.id;
    if (id) return id;
  }
  throw new Error('admin account could not be created or held');
}

/** Outcome of {@link linkIdentity} when it does not throw. */
export type LinkIdentityOutcome = 'linked' | 'already';

/** The external login is already linked to a DIFFERENT account. */
export class IdentityTakenError extends Error {
  constructor() {
    super('login identity already belongs to another account');
    this.name = 'IdentityTakenError';
  }
}

/**
 * The account already has a different login for this provider. It is never
 * overwritten; the caller logs it for an operator.
 */
export class IdentityMismatchError extends Error {
  constructor() {
    super('account already has a different login for this provider');
    this.name = 'IdentityMismatchError';
  }
}

/** The account does not exist, or is not of the required type. */
export class IdentityNotLinkableError extends Error {
  constructor() {
    super('account does not exist or is not of the required type');
    this.name = 'IdentityNotLinkableError';
  }
}

/**
 * Links a provider login to an account, once.
 *
 * Inserts only when the account exists and, if `userType` is given, has that type.
 *
 * @param db - Executor (the pool or the caller's transaction).
 * @param userId - The account (`users.id`).
 * @param provider - Provider key, e.g. `'keycloak'`.
 * @param subject - The provider's user id.
 * @param userType - When set, the account must be of this type.
 * @returns `'linked'` when recorded now, `'already'` when this exact link exists.
 * @throws {IdentityTakenError} When the subject belongs to another account.
 * @throws {IdentityMismatchError} When the account has another subject for the provider.
 * @throws {IdentityNotLinkableError} When the account is missing or of another type.
 */
export async function linkIdentity(
  db: DbExecutor,
  userId: string,
  provider: string,
  subject: string,
  userType?: 'admin' | 'coordinator',
): Promise<LinkIdentityOutcome> {
  const typeFilter = userType ? sql` AND u.user_type = ${userType}` : sql``;
  const inserted = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_identities (user_id, provider, subject)
    SELECT u.id, ${provider}, ${subject} FROM users u
     WHERE u.id = ${userId}${typeFilter}
    ON CONFLICT DO NOTHING
    RETURNING user_id`);
  if (inserted.rows.length > 0) return 'linked';

  const [mine] = await db
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  if (mine) {
    if (mine.subject === subject) return 'already';
    throw new IdentityMismatchError();
  }
  const eligible = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId}${typeFilter}) AS ok`);
  if (!eligible.rows[0]?.ok) throw new IdentityNotLinkableError();
  throw new IdentityTakenError();
}

/**
 * Returns the account's subject for `provider`, or null.
 *
 * @param db - Executor.
 * @param userId - The account.
 * @param provider - Provider key.
 * @returns The subject, or null when none is linked.
 */
export async function subjectOf(
  db: DbExecutor,
  userId: string,
  provider: string,
): Promise<string | null> {
  const [row] = await db
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  return row?.subject ?? null;
}
