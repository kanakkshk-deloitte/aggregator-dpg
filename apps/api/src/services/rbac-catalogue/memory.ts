/**
 * In-memory RBAC catalogue (`@aggregator-dpg/api`) for unit tests.
 *
 * Behaves like the Postgres store. `setRoles` and `setPermissions` stand in for
 * the migration seed, the revision changes on every write, and `failWith` makes
 * later calls fail.
 */

import type { RoleDefinition } from '@aggregator-dpg/rbac/interface';
import {
  RbacCatalogueBase,
  type CatalogueSnapshot,
  type CatalogueStoreError,
  type CatalogueStoreResult,
  type StoredPermission,
} from './interface.js';

/** Array-backed {@link RbacCatalogueBase}. */
export class InMemoryRbacCatalogue extends RbacCatalogueBase {
  permissions: StoredPermission[] = [];
  private roles: RoleDefinition[] = [];
  private rev = 0;
  private failure: CatalogueStoreError | null = null;

  /** Makes every later call fail with `error` (`null` restores). */
  failWith(error: CatalogueStoreError | null): void {
    this.failure = error;
  }

  /**
   * Replaces the stored roles, as the migration seed would. Test setup only.
   *
   * @param roles - The new roles.
   */
  setRoles(roles: readonly RoleDefinition[]): void {
    this.roles = structuredClone(roles) as RoleDefinition[];
    this.rev += 1;
  }

  /**
   * Replaces the stored permissions, as the migration seed would (test setup only).
   *
   * @param permissions - The new permission rows.
   */
  setPermissions(permissions: readonly StoredPermission[]): void {
    this.permissions = structuredClone(permissions) as StoredPermission[];
  }

  /** Returns a copy of the stored roles. */
  storedRoles(): RoleDefinition[] {
    return structuredClone(this.roles);
  }

  private fail(): CatalogueStoreResult<never> | null {
    return this.failure ? { ok: false, error: this.failure } : null;
  }

  /** {@inheritDoc RbacCatalogueBase.load} */
  async load(): Promise<CatalogueStoreResult<CatalogueSnapshot>> {
    return (
      this.fail() ?? {
        ok: true,
        value: { roles: structuredClone(this.roles), revision: `r${this.rev}` },
      }
    );
  }

  /** {@inheritDoc RbacCatalogueBase.revision} */
  async revision(): Promise<CatalogueStoreResult<string>> {
    return this.fail() ?? { ok: true, value: `r${this.rev}` };
  }

  /** {@inheritDoc RbacCatalogueBase.listPermissions} */
  listPermissions(): Promise<CatalogueStoreResult<StoredPermission[]>> {
    return Promise.resolve(
      this.fail() ?? {
        ok: true,
        value: structuredClone(this.permissions).sort((a, b) => a.key.localeCompare(b.key)),
      },
    );
  }

  /** Role keys with a live assignment, consulted by `deleteRole` (tests set it). */
  liveAssignments = new Set<string>();

  /** {@inheritDoc RbacCatalogueBase.createRole} */
  async createRole(
    role: RoleDefinition,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<{ created: boolean }>> {
    const failed = this.fail();
    if (failed) return failed;
    if (this.roles.some((r) => r.key === role.key)) return { ok: true, value: { created: false } };
    this.roles.push(structuredClone(role));
    this.rev += 1;
    return { ok: true, value: { created: true } };
  }

  /** {@inheritDoc RbacCatalogueBase.updateRole} */
  async updateRole(
    role: RoleDefinition,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<{ updated: boolean }>> {
    const failed = this.fail();
    if (failed) return failed;
    const i = this.roles.findIndex((r) => r.key === role.key && !r.isBuiltin);
    if (i < 0) return { ok: true, value: { updated: false } };
    this.roles[i] = structuredClone(role);
    this.rev += 1;
    return { ok: true, value: { updated: true } };
  }

  /** {@inheritDoc RbacCatalogueBase.deleteRole} */
  async deleteRole(
    key: string,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<'deleted' | 'in_use' | 'not_found'>> {
    const failed = this.fail();
    if (failed) return failed;
    const i = this.roles.findIndex((r) => r.key === key && !r.isBuiltin);
    if (i < 0) return { ok: true, value: 'not_found' };
    if (this.liveAssignments.has(key)) return { ok: true, value: 'in_use' };
    this.roles.splice(i, 1);
    this.rev += 1;
    return { ok: true, value: 'deleted' };
  }
}
