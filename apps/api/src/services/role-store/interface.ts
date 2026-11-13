/**
 * Role-assignment store contract (`@aggregator-dpg/api`).
 *
 * Covers `user_role` (additional roles a user holds in an org, with optional
 * expiry; base roles follow membership and are not stored) and the
 * append-only `iam_audit` trail. Every write commits with its audit row.
 * See `docs/rbac/rbac-design-aggregator.md`.
 *
 * Every method returns a `Result`-style union and never throws across the
 * service boundary.
 */

/** One assignment, live or historical. */
export interface UserRoleRecord {
  id: string;
  userId: string;
  roleKey: string;
  orgId: string;
  grantedBy: string | null;
  grantedAt: Date;
  /** Null means no expiry. */
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** An `iam_audit` entry. Ids and names only, never contact data. */
export interface AuditEntry {
  event: string;
  actorUserId: string | null;
  targetUserId?: string | null;
  targetOrgId?: string | null;
  details?: Record<string, unknown>;
}

/** Input of {@link RoleStoreBase.assign}. */
export interface AssignRoleInput {
  userId: string;
  roleKey: string;
  orgId: string;
  grantedBy: string;
  expiresAt: Date | null;
}

/** Errors a role-store call can report. */
export type RoleStoreError = { code: 'DB_UNAVAILABLE'; message: string };

/** Result of a role-store call. */
export type RoleStoreResult<T> = { ok: true; value: T } | { ok: false; error: RoleStoreError };

/** Abstract contract for role assignments and the IAM audit. */
export abstract class RoleStoreBase {
  /**
   * Returns the user's live assignments: not revoked and not expired at `now`.
   *
   * @param userId - The user.
   * @param now - The current time.
   * @returns The live assignments.
   */
  abstract listLive(userId: string, now: Date): Promise<RoleStoreResult<UserRoleRecord[]>>;

  /**
   * Returns the live assignments of several users in one read, for a list
   * page; an empty list of users reads nothing.
   *
   * @param userIds - The users.
   * @param now - The current time.
   * @returns The live assignments of any of the users, in no particular order.
   */
  abstract listLiveForUsers(
    userIds: readonly string[],
    now: Date,
  ): Promise<RoleStoreResult<UserRoleRecord[]>>;

  /**
   * Returns every assignment of the user, newest first.
   *
   * @param userId - The user.
   * @returns All assignments, live and past.
   */
  abstract listForUser(userId: string): Promise<RoleStoreResult<UserRoleRecord[]>>;

  /**
   * Assigns a role in an organisation, replacing a live assignment of the same
   * role there, and writes the audit row in the same transaction.
   *
   * @param input - The assignment.
   * @param audit - The audit row.
   * @returns The new assignment.
   */
  abstract assign(
    input: AssignRoleInput,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord>>;

  /**
   * Revokes the live assignment of a role in an organisation and audits it.
   *
   * @param userId - The user.
   * @param roleKey - The role.
   * @param orgId - The organisation.
   * @param revokedBy - Who revokes it.
   * @param audit - The audit row.
   * @returns The revoked assignment, or null when none was live.
   */
  abstract revoke(
    userId: string,
    roleKey: string,
    orgId: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord | null>>;

  /**
   * Revokes every live assignment the user holds in an organisation (they left
   * it, or stopped owning it), with one audit row when any was live.
   *
   * @param userId - The user.
   * @param orgId - The organisation.
   * @param revokedBy - Who caused it; null for a system change.
   * @param audit - The audit row.
   * @returns How many assignments were revoked.
   */
  abstract revokeAllInOrg(
    userId: string,
    orgId: string,
    revokedBy: string | null,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<number>>;

  /**
   * Returns the users with an unrevoked assignment that expired in the window
   * (`from`, `to`]: an expiry is no event, so the token-roles sweep asks for
   * the users whose roles ran out since it last looked.
   *
   * @param from - Window start (exclusive).
   * @param to - Window end (inclusive).
   * @returns The user ids, without duplicates, in no particular order.
   */
  abstract listUsersExpiredBetween(from: Date, to: Date): Promise<RoleStoreResult<string[]>>;
}
