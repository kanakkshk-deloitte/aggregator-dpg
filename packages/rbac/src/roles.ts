/**
 * Role definitions and their rules (`@aggregator-dpg/rbac`).
 *
 * The built-in roles are the typed `BUILTIN_ROLES` const (seeded into the
 * database by migration `0031_rbac_seed.sql`); custom roles live only in the
 * database. Both pass the same checks here, so a broken catalogue is never
 * loaded. Rules: `docs/rbac/rbac-permissions-and-roles.md` §3–§4.
 *
 * @module @aggregator-dpg/rbac/roles
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { BaseForSchema, type BaseFor, type RoleDefinition } from './interface.js';
import { NOT_THROUGH_ROOT } from './catalogue.js';

/** The account type each base role's holders have. */
const BASE_ACCOUNT: Record<BaseFor, 'admin' | 'coordinator'> = {
  org_member: 'coordinator',
  org_owner: 'admin',
  root_owner: 'admin',
};

/**
 * Lists every rule a set of roles breaks.
 *
 * @param roles - Built-in roles alone, or the whole catalogue.
 * @returns One message per broken rule; empty when valid.
 */
export function roleCatalogueIssues(roles: readonly RoleDefinition[]): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const r of roles) {
    const at = `role "${r.key}"`;
    if (keys.has(r.key)) issues.push(`${at}: duplicate key`);
    keys.add(r.key);
    if (new Set(r.permissions).size !== r.permissions.length) {
      issues.push(`${at}: duplicate permission`);
    }
    if (r.baseFor) {
      if (!r.isBuiltin) issues.push(`${at}: only a built-in role can be a base role`);
      if (r.assignedBy !== null) issues.push(`${at}: a base role is not assigned by hand`);
      if (r.maxDays !== null) issues.push(`${at}: a base role has no expiry`);
      if (r.accountType !== BASE_ACCOUNT[r.baseFor]) {
        issues.push(`${at}: ${r.baseFor} is held by ${BASE_ACCOUNT[r.baseFor]} accounts`);
      }
      const rootOnly = r.baseFor === 'root_owner';
      const types = r.assignableOrgTypes;
      if (rootOnly && (types.length !== 1 || types[0] !== 'network_facilitator')) {
        issues.push(`${at}: root_owner is held in the root organisation only`);
      }
      if (!rootOnly && types.includes('network_facilitator')) {
        issues.push(`${at}: ${r.baseFor} is not held in the root organisation`);
      }
    } else if (r.assignedBy === null) {
      issues.push(`${at}: an additional role needs assigned_by`);
    }
    if (
      r.assignableOrgTypes.includes('network_facilitator') &&
      r.permissions.some((p) => NOT_THROUGH_ROOT.includes(p))
    ) {
      issues.push(`${at}: personal data is never held through the root organisation`);
    }
  }
  for (const base of BaseForSchema.options) {
    const n = roles.filter((r) => r.baseFor === base).length;
    if (n !== 1) issues.push(`base role ${base}: expected exactly one, found ${n}`);
  }
  return issues;
}

/**
 * Throws when a set of roles breaks a rule.
 *
 * @param roles - The roles.
 * @param source - Where they came from, for the error.
 * @throws {ConfigError} `RBAC_CONFIG_INVALID` with every broken rule.
 */
export function assertRoleCatalogue(roles: readonly RoleDefinition[], source: string): void {
  const issues = roleCatalogueIssues(roles);
  if (issues.length > 0) {
    throw new ConfigError(`Invalid RBAC roles at ${source}`, {
      code: 'RBAC_CONFIG_INVALID',
      details: { source, issues },
    });
  }
}
