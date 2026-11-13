/**
 * Custom roles (`@aggregator-dpg/api`).
 *
 * The network admin builds roles from existing permissions. Every change is
 * checked against the whole catalogue with `roleCatalogueIssues`. Built-in
 * roles cannot be changed. After a write this replica reloads its role
 * snapshot; other replicas follow within the refresh interval.
 */

import {
  CapabilitySchema,
  OrgTypeSchema,
  UserTypeSchema,
  compareCodeUnits,
  roleCatalogueIssues,
  type Capability,
  type OrgType,
  type RoleDefinition,
  type UserType,
} from '@aggregator-dpg/rbac';
import { config } from '../../config.js';
import type { Actor } from '../auth/actor/index.js';
import { getRbacCatalogue } from '../rbac-catalogue/index.js';
import { getRbacRuntime, refreshRbacCatalogue } from './runtime.js';

/** Most custom roles one instance may hold. */
export const MAX_CUSTOM_ROLES = 50;

/** Why a custom-role change did not happen. */
export type CustomRoleFailure =
  | { kind: 'rbac_off' }
  | { kind: 'custom_roles_disabled' }
  | { kind: 'not_found' }
  | { kind: 'exists' }
  | { kind: 'builtin' }
  | { kind: 'in_use' }
  | { kind: 'limit' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'unavailable'; message: string };

/** Result of a custom-role change. */
export type CustomRoleOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: CustomRoleFailure };

/** The fields of a custom role a request sets. */
export interface CustomRoleInput {
  key: string;
  name: string;
  description: string;
  accountType: string;
  assignableOrgTypes: string[];
  assignedBy: string;
  maxDays: number | null;
  permissions: string[];
}

const fail = <T>(failure: CustomRoleFailure): CustomRoleOutcome<T> => ({ ok: false, failure });

/** Turns request fields into a role, or lists the unknown names. */
function toDefinition(input: CustomRoleInput): CustomRoleOutcome<RoleDefinition> {
  const issues: string[] = [];
  const perms = input.permissions.filter((p) => !CapabilitySchema.safeParse(p).success);
  if (perms.length > 0) issues.push(`unknown permission: ${perms.join(', ')}`);
  if (!CapabilitySchema.safeParse(input.assignedBy).success) {
    issues.push(`unknown assigned_by permission: ${input.assignedBy}`);
  }
  if (!UserTypeSchema.safeParse(input.accountType).success) issues.push('unknown account_type');
  const types = input.assignableOrgTypes.filter((t) => !OrgTypeSchema.safeParse(t).success);
  if (types.length > 0) issues.push(`unknown organisation type: ${types.join(', ')}`);
  if (issues.length > 0) return fail({ kind: 'invalid', issues });
  return {
    ok: true,
    value: {
      key: input.key,
      name: input.name,
      description: input.description,
      isBuiltin: false,
      accountType: input.accountType as UserType,
      baseFor: null,
      assignableOrgTypes: [...new Set(input.assignableOrgTypes)] as OrgType[],
      assignedBy: input.assignedBy as Capability,
      maxDays: input.maxDays,
      permissions: [...new Set(input.permissions)].sort(compareCodeUnits) as Capability[],
    },
  };
}

/** The role rules the catalogue would break with `roles`. */
function check(roles: RoleDefinition[]): CustomRoleOutcome<void> {
  const issues = roleCatalogueIssues(roles);
  return issues.length > 0 ? fail({ kind: 'invalid', issues }) : { ok: true, value: undefined };
}

/**
 * Creates a custom role.
 *
 * @param actor - The network admin.
 * @param input - The role's fields.
 * @returns The created role.
 */
export async function createCustomRole(
  actor: Actor,
  input: CustomRoleInput,
): Promise<CustomRoleOutcome<RoleDefinition>> {
  if (!config.RBAC_CUSTOM_ROLES_ENABLED) return fail({ kind: 'custom_roles_disabled' });
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const def = toDefinition(input);
  if (!def.ok) return def;
  const current = [...rt.roles.byKey.values()];
  if (rt.roles.byKey.has(def.value.key)) return fail({ kind: 'exists' });
  if (current.filter((r) => !r.isBuiltin).length >= MAX_CUSTOM_ROLES)
    return fail({ kind: 'limit' });
  const valid = check([...current, def.value]);
  if (!valid.ok) return valid;
  const res = await getRbacCatalogue().createRole(def.value, actor.userId);
  if (!res.ok) return fail({ kind: 'unavailable', message: res.error.message });
  if (!res.value.created) return fail({ kind: 'exists' });
  await refreshRbacCatalogue();
  return { ok: true, value: def.value };
}

/**
 * Changes a custom role. The key and account type stay fixed.
 *
 * @param actor - The network admin.
 * @param key - The role.
 * @param patch - The fields to change.
 * @returns The changed role.
 */
export async function updateCustomRole(
  actor: Actor,
  key: string,
  patch: Partial<Omit<CustomRoleInput, 'key' | 'accountType'>>,
): Promise<CustomRoleOutcome<RoleDefinition>> {
  if (!config.RBAC_CUSTOM_ROLES_ENABLED) return fail({ kind: 'custom_roles_disabled' });
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const existing = rt.roles.byKey.get(key);
  if (!existing) return fail({ kind: 'not_found' });
  if (existing.isBuiltin) return fail({ kind: 'builtin' });
  const def = toDefinition({
    key,
    accountType: existing.accountType,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    assignableOrgTypes: patch.assignableOrgTypes ?? existing.assignableOrgTypes,
    assignedBy: patch.assignedBy ?? existing.assignedBy ?? '',
    maxDays: patch.maxDays !== undefined ? patch.maxDays : existing.maxDays,
    permissions: patch.permissions ?? existing.permissions,
  });
  if (!def.ok) return def;
  const valid = check([...rt.roles.byKey.values()].map((r) => (r.key === key ? def.value : r)));
  if (!valid.ok) return valid;
  const res = await getRbacCatalogue().updateRole(def.value, actor.userId);
  if (!res.ok) return fail({ kind: 'unavailable', message: res.error.message });
  if (!res.value.updated) return fail({ kind: 'not_found' });
  await refreshRbacCatalogue();
  return { ok: true, value: def.value };
}

/**
 * Deletes a custom role no live assignment uses.
 *
 * @param actor - The network admin.
 * @param key - The role.
 * @returns Nothing.
 */
export async function deleteCustomRole(
  actor: Actor,
  key: string,
): Promise<CustomRoleOutcome<void>> {
  if (!config.RBAC_CUSTOM_ROLES_ENABLED) return fail({ kind: 'custom_roles_disabled' });
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const existing = rt.roles.byKey.get(key);
  if (existing?.isBuiltin) return fail({ kind: 'builtin' });
  const res = await getRbacCatalogue().deleteRole(key, actor.userId);
  if (!res.ok) return fail({ kind: 'unavailable', message: res.error.message });
  if (res.value === 'not_found') return fail({ kind: 'not_found' });
  if (res.value === 'in_use') return fail({ kind: 'in_use' });
  await refreshRbacCatalogue();
  return { ok: true, value: undefined };
}
