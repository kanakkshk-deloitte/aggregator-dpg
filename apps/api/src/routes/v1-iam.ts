/**
 * RBAC roles API of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET  /v1/roles                     every role and its permissions
 *   GET  /v1/user/roles/:id            a user's base and additional roles, and what the caller may assign
 *   POST /v1/user/role/assign/:id      assign an additional role in an organisation
 *   POST /v1/user/role/revoke/:id      revoke an additional role
 *   POST /v1/roles/create              create a custom role (network admin)
 *   PATCH /v1/roles/update/:key        change a custom role (network admin)
 *   POST /v1/roles/delete/:key         delete an unused custom role (network admin)
 *
 * `requireActor()` admits admins only. Assign and revoke declare `signed_in`;
 * `services/authz/roles.ts` checks the role's `assigned_by` permission in the
 * target organisation. Writes are always enforced, also in `log` mode. Every
 * change is written to `iam_audit`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITIES,
  compareCodeUnits,
  permissionDefinitions,
  type RoleDefinition,
} from '@aggregator-dpg/rbac';
import {
  AssignRoleRequestSchema,
  CreateRoleRequestSchema,
  RoleSchema,
  UpdateRoleRequestSchema,
  RevokeRoleRequestSchema,
  RevokeRoleResponseSchema,
  RoleAssignmentSchema,
  RolesResponseSchema,
  UserRolesResponseSchema,
  type Role as WireRole,
  type RoleAssignment as WireAssignment,
} from '@aggregator-dpg/shared-primitives/user-org';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { requireActor } from '../services/auth/actor/index.js';
import { getRbacRuntime } from '../services/authz/runtime.js';
import { enforcedCapabilities } from '../services/authz/route-access.js';
import {
  assignRole,
  listUserRoles,
  revokeRole,
  type RoleFailure,
} from '../services/authz/roles.js';
import type { UserRoleRecord } from '../services/role-store/index.js';
import {
  createCustomRole,
  deleteCustomRole,
  updateCustomRole,
  type CustomRoleFailure,
} from '../services/authz/custom-roles.js';
import { guardWriteRate } from './console-shared.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
type IdParams = z.infer<typeof IdParamsSchema>;
const KeyParamsSchema = z.object({ key: z.string().min(1).max(40) });
type KeyParams = z.infer<typeof KeyParamsSchema>;

/** Throws the HTTP error for a failed custom-role change. */
function throwCustomFailure(f: CustomRoleFailure): never {
  switch (f.kind) {
    case 'rbac_off':
      throw httpError('RBAC_NOT_ENABLED');
    // The routes are not registered when the flag is off; answer the same 404.
    case 'custom_roles_disabled':
      throw httpError('NOT_FOUND');
    case 'not_found':
      throw httpError('NOT_FOUND');
    case 'exists':
      throw httpError('ROLE_EXISTS');
    case 'builtin':
      throw httpError('ROLE_BUILTIN');
    case 'in_use':
      throw httpError('ROLE_IN_USE');
    case 'limit':
      throw httpError('ROLE_LIMIT_REACHED');
    case 'invalid':
      throw httpError('ROLE_INVALID', { fields: { issues: f.issues } });
    case 'unavailable':
      throw httpError('DB_UNAVAILABLE', {
        cause: new Error(f.message),
        fields: { sub_operation: 'rbac.customRoles' },
      });
  }
}

/** A role on the wire. */
export function toWireRole(r: RoleDefinition): WireRole {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    is_builtin: r.isBuiltin,
    account_type: r.accountType,
    base_for: r.baseFor,
    assignable_org_types: r.assignableOrgTypes,
    assigned_by: r.assignedBy,
    max_days: r.maxDays,
    permissions: [...r.permissions].sort(compareCodeUnits),
  };
}

/** An assignment on the wire. */
function toWireAssignment(a: UserRoleRecord, now: Date): WireAssignment {
  return {
    id: a.id,
    role_key: a.roleKey,
    org_id: a.orgId,
    granted_by: a.grantedBy,
    granted_at: a.grantedAt.toISOString(),
    expires_at: a.expiresAt ? a.expiresAt.toISOString() : null,
    revoked_at: a.revokedAt ? a.revokedAt.toISOString() : null,
    live: a.revokedAt === null && (a.expiresAt === null || a.expiresAt > now),
  };
}

/** Throws the HTTP error for a failed rule check. */
function throwFailure(f: RoleFailure): never {
  switch (f.kind) {
    case 'rbac_off':
      throw httpError('RBAC_NOT_ENABLED');
    case 'not_found':
      throw httpError('NOT_FOUND');
    case 'unknown_role':
      throw httpError('ROLE_UNKNOWN');
    case 'not_allowed':
      throw httpError('ROLE_ASSIGNMENT_NOT_ALLOWED', { fields: { reason: f.reason } });
    case 'forbidden':
      throw httpError('FORBIDDEN', { fields: { permission: f.permission } });
    case 'unavailable':
      throw httpError('DB_UNAVAILABLE', {
        cause: new Error(f.message),
        fields: { sub_operation: 'rbac.roles' },
      });
  }
}

/**
 * Registers the roles API.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1IamRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/roles',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Every role and its permissions',
        response: { 200: RolesResponseSchema, ...errorResponses(401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      await requireActor(req);
      const rt = getRbacRuntime();
      if (!rt) throw httpError('RBAC_NOT_ENABLED');
      const roles = [...rt.roles.byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
      // Derived from the registered routes, so a permission no route checks is
      // reported as unused.
      const enforced = enforcedCapabilities();
      return reply.status(200).send({
        roles: roles.map(toWireRole),
        permissions: permissionDefinitions(CAPABILITIES).map((p) => ({
          ...p,
          enforced: enforced.has(p.key),
        })),
      });
    },
  );

  app.get(
    '/v1/user/roles/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: "A user's roles and the additional roles the caller may assign",
        params: IdParamsSchema,
        response: { 200: UserRolesResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const now = new Date();
      const res = await listUserRoles(actor, id, now);
      if (!res.ok) throwFailure(res.failure);
      return reply.status(200).send({
        base: res.value.base.map((b) => ({ role_key: b.roleKey, org_id: b.orgId })),
        additional: res.value.additional.map((a) => toWireAssignment(a, now)),
        assignable: res.value.assignable.map((a) => ({ role_key: a.roleKey, org_id: a.orgId })),
      });
    },
  );

  app.post(
    '/v1/user/role/assign/:id',
    {
      config: { rbac: { access: 'signed_in' } },
      schema: {
        tags: ['console'],
        summary: 'Assign an additional role to a user in an organisation',
        description:
          "Needs the role's assigned_by permission in that organisation. Replaces a live assignment of the same role there. Refused for a base role, an organisation the user is not part of, yourself, the wrong account or organisation type, separation of duties, and beyond the role's longest validity.",
        params: IdParamsSchema,
        body: AssignRoleRequestSchema,
        response: {
          200: RoleAssignmentSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof AssignRoleRequestSchema>;
      const res = await assignRole(req, actor, id, {
        roleKey: body.role_key,
        orgId: body.org_id,
        days: body.days,
      });
      if (!res.ok) throwFailure(res.failure);
      req.log.info({
        operation: 'console.role.assign',
        status: 'success',
        actor_id: actor.userId,
        target_id: id,
        role: body.role_key,
        org_id: body.org_id,
      });
      return reply.status(200).send(toWireAssignment(res.value, new Date()));
    },
  );

  app.post(
    '/v1/user/role/revoke/:id',
    {
      config: { rbac: { access: 'signed_in' } },
      schema: {
        tags: ['console'],
        summary: "Revoke a user's additional role in an organisation",
        params: IdParamsSchema,
        body: RevokeRoleRequestSchema,
        response: {
          200: RevokeRoleResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof RevokeRoleRequestSchema>;
      const res = await revokeRole(req, actor, id, body.role_key, body.org_id);
      if (!res.ok) throwFailure(res.failure);
      req.log.info({
        operation: 'console.role.revoke',
        status: 'success',
        actor_id: actor.userId,
        target_id: id,
        role: body.role_key,
        org_id: body.org_id,
        revoked: res.value,
      });
      return reply.status(200).send({ revoked: res.value });
    },
  );

  // Custom-role authoring routes, registered only when
  // `RBAC_CUSTOM_ROLES_ENABLED` is on. Otherwise they 404 and are not in the
  // OpenAPI spec. `custom-roles.ts` also answers 404 when the flag is off.
  if (!config.RBAC_CUSTOM_ROLES_ENABLED) return;

  app.post(
    '/v1/roles/create',
    {
      config: { rbac: { capability: 'network.administer', strict: true } },
      schema: {
        tags: ['console'],
        summary: 'Create a custom role from existing permissions',
        body: CreateRoleRequestSchema,
        response: { 201: RoleSchema, ...errorResponses(400, 401, 403, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const body = req.body as z.infer<typeof CreateRoleRequestSchema>;
      const res = await createCustomRole(actor, {
        key: body.key,
        name: body.name,
        description: body.description,
        accountType: body.account_type,
        assignableOrgTypes: body.assignable_org_types,
        assignedBy: body.assigned_by,
        maxDays: body.max_days,
        permissions: body.permissions,
      });
      if (!res.ok) throwCustomFailure(res.failure);
      req.log.info({
        operation: 'console.role.create',
        status: 'success',
        actor_id: actor.userId,
        role: body.key,
      });
      return reply.status(201).send(toWireRole(res.value));
    },
  );

  app.patch(
    '/v1/roles/update/:key',
    {
      config: { rbac: { capability: 'network.administer', strict: true } },
      schema: {
        tags: ['console'],
        summary: 'Change a custom role',
        params: KeyParamsSchema,
        body: UpdateRoleRequestSchema,
        response: { 200: RoleSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { key } = req.params as KeyParams;
      const body = req.body as z.infer<typeof UpdateRoleRequestSchema>;
      const res = await updateCustomRole(actor, key, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.assignable_org_types !== undefined
          ? { assignableOrgTypes: body.assignable_org_types }
          : {}),
        ...(body.assigned_by !== undefined ? { assignedBy: body.assigned_by } : {}),
        ...(body.max_days !== undefined ? { maxDays: body.max_days } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      });
      if (!res.ok) throwCustomFailure(res.failure);
      req.log.info({
        operation: 'console.role.update',
        status: 'success',
        actor_id: actor.userId,
        role: key,
      });
      return reply.status(200).send(toWireRole(res.value));
    },
  );

  app.post(
    '/v1/roles/delete/:key',
    {
      config: { rbac: { capability: 'network.administer', strict: true } },
      schema: {
        tags: ['console'],
        summary: 'Delete a custom role no live assignment uses',
        params: KeyParamsSchema,
        response: {
          200: z.object({ deleted: z.boolean() }),
          ...errorResponses(401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { key } = req.params as KeyParams;
      const res = await deleteCustomRole(actor, key);
      if (!res.ok) throwCustomFailure(res.failure);
      req.log.info({
        operation: 'console.role.delete',
        status: 'success',
        actor_id: actor.userId,
        role: key,
      });
      return reply.status(200).send({ deleted: true });
    },
  );
}
