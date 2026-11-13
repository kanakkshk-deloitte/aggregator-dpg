/**
 * In-memory role-assignment store for unit tests (`@aggregator-dpg/api`).
 *
 * Follows the same rules as the Postgres store.
 */

import { randomUUID } from 'node:crypto';
import {
  RoleStoreBase,
  type AssignRoleInput,
  type AuditEntry,
  type RoleStoreError,
  type RoleStoreResult,
  type UserRoleRecord,
} from './interface.js';

/** Array-backed {@link RoleStoreBase}; `assignments` and `audit` are readable by tests. */
export class InMemoryRoleStore extends RoleStoreBase {
  readonly assignments: UserRoleRecord[] = [];
  readonly audit: AuditEntry[] = [];
  private failure: RoleStoreError | null = null;

  /** Makes every later call fail with `error` (`null` restores). */
  failWith(error: RoleStoreError | null): void {
    this.failure = error;
  }

  /**
   * Seeds assignments directly, bypassing the audit (test setup only).
   *
   * @param rows - Partial rows; defaults fill the rest.
   */
  seed(
    rows: Array<Partial<UserRoleRecord> & Pick<UserRoleRecord, 'userId' | 'roleKey' | 'orgId'>>,
  ): void {
    for (const r of rows) {
      this.assignments.push({
        id: randomUUID(),
        grantedBy: null,
        grantedAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        revokedBy: null,
        ...r,
      });
    }
  }

  private fail(): RoleStoreResult<never> | null {
    return this.failure ? { ok: false, error: this.failure } : null;
  }

  private live(a: UserRoleRecord, now: Date): boolean {
    return a.revokedAt === null && (a.expiresAt === null || a.expiresAt > now);
  }

  /** {@inheritDoc RoleStoreBase.listLive} */
  async listLive(userId: string, now: Date): Promise<RoleStoreResult<UserRoleRecord[]>> {
    return (
      this.fail() ?? {
        ok: true,
        value: this.assignments.filter((a) => a.userId === userId && this.live(a, now)),
      }
    );
  }

  /** {@inheritDoc RoleStoreBase.listLiveForUsers} */
  listLiveForUsers(
    userIds: readonly string[],
    now: Date,
  ): Promise<RoleStoreResult<UserRoleRecord[]>> {
    const wanted = new Set(userIds);
    return Promise.resolve(
      this.fail() ?? {
        ok: true,
        value: this.assignments.filter((a) => wanted.has(a.userId) && this.live(a, now)),
      },
    );
  }

  /** {@inheritDoc RoleStoreBase.listForUser} */
  async listForUser(userId: string): Promise<RoleStoreResult<UserRoleRecord[]>> {
    return (
      this.fail() ?? {
        ok: true,
        value: this.assignments
          .filter((a) => a.userId === userId)
          .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime()),
      }
    );
  }

  /** {@inheritDoc RoleStoreBase.assign} */
  async assign(
    input: AssignRoleInput,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord>> {
    const failed = this.fail();
    if (failed) return failed;
    const now = new Date();
    for (const a of this.assignments) {
      if (
        a.userId === input.userId &&
        a.roleKey === input.roleKey &&
        a.orgId === input.orgId &&
        a.revokedAt === null
      ) {
        a.revokedAt = now;
        a.revokedBy = input.grantedBy;
      }
    }
    const created: UserRoleRecord = {
      id: randomUUID(),
      ...input,
      grantedAt: now,
      revokedAt: null,
      revokedBy: null,
    };
    this.assignments.push(created);
    this.audit.push(audit);
    return { ok: true, value: created };
  }

  /** {@inheritDoc RoleStoreBase.revoke} */
  async revoke(
    userId: string,
    roleKey: string,
    orgId: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord | null>> {
    const failed = this.fail();
    if (failed) return failed;
    const live = this.assignments.find(
      (a) =>
        a.userId === userId && a.roleKey === roleKey && a.orgId === orgId && a.revokedAt === null,
    );
    if (!live) return { ok: true, value: null };
    live.revokedAt = new Date();
    live.revokedBy = revokedBy;
    this.audit.push(audit);
    return { ok: true, value: live };
  }

  /** {@inheritDoc RoleStoreBase.revokeAllInOrg} */
  async revokeAllInOrg(
    userId: string,
    orgId: string,
    revokedBy: string | null,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<number>> {
    const failed = this.fail();
    if (failed) return failed;
    const now = new Date();
    let n = 0;
    for (const a of this.assignments) {
      if (a.userId === userId && a.orgId === orgId && a.revokedAt === null) {
        a.revokedAt = now;
        a.revokedBy = revokedBy;
        n += 1;
      }
    }
    if (n > 0) this.audit.push(audit);
    return { ok: true, value: n };
  }

  /** {@inheritDoc RoleStoreBase.listUsersExpiredBetween} */
  listUsersExpiredBetween(from: Date, to: Date): Promise<RoleStoreResult<string[]>> {
    const failed = this.fail();
    if (failed) return Promise.resolve(failed);
    const ids = this.assignments
      .filter(
        (a) =>
          a.revokedAt === null && a.expiresAt !== null && a.expiresAt > from && a.expiresAt <= to,
      )
      .map((a) => a.userId);
    return Promise.resolve({ ok: true, value: [...new Set(ids)] });
  }
}
