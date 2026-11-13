/**
 * Read-only RBAC catalogue for the network admin (`@aggregator-dpg/api`, #871).
 *
 *   GET /v1/rbac/roles         every role the API enforces, built-in and custom
 *   GET /v1/rbac/permissions   every permission in the catalogue, retired included
 *
 * The roles come from the same snapshot the access checks use, so the tables
 * can never disagree with real access, and a change shows within
 * `RBAC_CATALOGUE_REFRESH_MS`. The permissions are read from the `permission`
 * table, which keeps the ones the code retired. Only the network admin may
 * call these: anyone else gets 404, also in `RBAC_MODE=log`, where the
 * declared permission is logged but not enforced. Nothing here writes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { compareCodeUnits, type RoleDefinition } from '@aggregator-dpg/rbac';
import {
  CataloguePermissionsResponseSchema,
  CatalogueRolesResponseSchema,
  type CataloguePermission,
  type CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { isNetworkAdmin, requireActor } from '../services/auth/actor/index.js';
import { getRbacRuntime, type RbacRuntime } from '../services/authz/runtime.js';
import { getRbacCatalogue, type StoredPermission } from '../services/rbac-catalogue/index.js';

/**
 * One row of the roles table.
 *
 * @param r - A role from the snapshot.
 * @returns The row.
 */
export function toCatalogueRole(r: RoleDefinition): CatalogueRole {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    is_builtin: r.isBuiltin,
    held_by: r.accountType === 'admin' ? 'org_owners' : 'coordinators',
    held_in: [...r.assignableOrgTypes].sort(compareCodeUnits),
    granted: r.baseFor
      ? { via: 'membership', membership: r.baseFor }
      : // The snapshot passed `assertRoleCatalogue`: an additional role always has `assignedBy`.
        { via: 'assignment', assigned_by: r.assignedBy ?? '' },
    max_days: r.maxDays,
    permissions: [...r.permissions].sort(compareCodeUnits),
  };
}

/**
 * The permissions table: every stored permission, with the roles that grant it.
 *
 * @param stored - The `permission` rows.
 * @param roles - The roles of the snapshot.
 * @returns One row per permission, in the order given.
 */
export function toCataloguePermissions(
  stored: readonly StoredPermission[],
  roles: Iterable<RoleDefinition>,
): CataloguePermission[] {
  const grantedBy = new Map<string, string[]>();
  for (const r of roles) {
    for (const p of r.permissions) grantedBy.set(p, [...(grantedBy.get(p) ?? []), r.key]);
  }
  return stored.map((p) => ({
    key: p.key,
    description: p.description,
    resource: p.resource,
    action: p.action,
    personal_data: p.sensitive,
    retired: p.deprecated,
    granted_by_roles: (grantedBy.get(p.key) ?? []).sort(compareCodeUnits),
  }));
}

/**
 * Admits the network admin only, and returns the loaded RBAC state.
 *
 * @param req - The request.
 * @returns The runtime.
 * @throws 404 `NOT_FOUND` for anyone but the network admin; 503
 *   `RBAC_NOT_ENABLED` when access control is off.
 */
async function networkAdminRuntime(req: FastifyRequest): Promise<RbacRuntime> {
  const { actor } = await requireActor(req);
  if (!isNetworkAdmin(actor)) throw httpError('NOT_FOUND');
  const rt = getRbacRuntime();
  if (!rt) throw httpError('RBAC_NOT_ENABLED');
  return rt;
}

/**
 * Registers the read-only catalogue routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1RbacCatalogueRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/rbac/roles',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Every role the API enforces (network admin, read-only)',
        response: { 200: CatalogueRolesResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rt = await networkAdminRuntime(req);
      const roles = [...rt.roles.byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
      return reply.status(200).send({ roles: roles.map(toCatalogueRole) });
    },
  );

  app.get(
    '/v1/rbac/permissions',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Every permission in the catalogue (network admin, read-only)',
        response: {
          200: CataloguePermissionsResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rt = await networkAdminRuntime(req);
      const stored = await getRbacCatalogue().listPermissions();
      if (!stored.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(stored.error.message),
          fields: { sub_operation: 'rbac.catalogue.permissions' },
        });
      }
      return reply
        .status(200)
        .send({ permissions: toCataloguePermissions(stored.value, rt.roles.byKey.values()) });
    },
  );
}
