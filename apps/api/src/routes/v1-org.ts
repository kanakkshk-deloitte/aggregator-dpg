/**
 * Console organisation routes `/v1/org/*` of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET   /v1/org/read/:id              one org within reach, owner and counts
 *   POST  /v1/org/search                orgs within reach (or below one), by name, keyset paged
 *   PATCH /v1/org/metadata/update/:id   org details (owner only)
 *   PATCH /v1/org/known-as/update/:id   an org's "known as" value (the parent's owner), or the
 *                                       values it defines for its children (the org's owner)
 *   PATCH /v1/org/parent/update/:id     move an org and the orgs below it (network admin)
 *   GET   /v1/org/parent/options/:id    candidate parents for a move (network admin)
 *   POST  /v1/org/decision/:id          approve / reject a pending org (its parent's owner)
 *   POST  /v1/org/access/repair/:id     re-apply the owner's sign-in access (its parent's owner)
 *   GET   /v1/org/hierarchy             the network, its "known as" values and the tree limits (network admin)
 *
 * Every handler calls `requireActor` first (admins only). A target out of
 * reach answers 404; a route the actor's kind cannot use answers 403. The
 * Default org's details are never editable. Only the network admin can read
 * the root, and search never returns it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OrgDecisionRequestSchema,
  OrgDecisionResponseSchema,
  OrgHierarchyQuerySchema,
  OrgHierarchyResponseSchema,
  OrgKnownAsUpdateRequestSchema,
  OrgKnownAsUpdateResponseSchema,
  OrgMetadataUpdateRequestSchema,
  OrgParentOptionsResponseSchema,
  OrgParentUpdateRequestSchema,
  OrgReadQuerySchema,
  OrgReadResponseSchema,
  OrgSchema,
  OrgSearchRequestSchema,
  OrgSearchResponseSchema,
  OwnerAccessResponseSchema,
  type KnownAsValues,
  type KnownAsValuesRequest,
  type OrgReadParent,
  type OrgKnownAsUpdateRequest,
  type OrgHierarchyQuery,
  type OrgHierarchyResponse,
  type OrgReadQuery,
  type OrgReadResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import { treeRules } from '../services/known-as.js';
import {
  getOrganisationStore,
  type Organisation,
  type OrgStoreError,
  type UpdateOrgPatch,
} from '../services/organisation-store/index.js';
import {
  isNetworkAdmin,
  ownedOrgIds,
  requireActor,
  type Actor,
} from '../services/auth/actor/index.js';
import { permissionsByOrg } from '../services/authz/guard.js';
import { getRbacRuntime } from '../services/authz/runtime.js';
import { reachesOrg } from '../services/authz/scope.js';
import { isOnlyViewed, viewableOrgIds } from '../services/authz/view-scope.js';
import { decideOrg, grantOwnerAccess } from '../services/decisions/org.js';
import { validateOrgUpdate } from '../services/org-schema-validator.js';
import {
  decodeOrgCursor,
  encodeOrgCursor,
  guardWriteRate,
  notifyOwnerOfAdminAction,
  notifyOwnerOfParentAction,
  ownerContact,
  throwTreeRefusal,
  toWireOrg,
} from './console-shared.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
type IdParams = z.infer<typeof IdParamsSchema>;

/** Throws `DB_UNAVAILABLE` naming the failed store call. */
function dbDown(subOperation: string, message: string): never {
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(message),
    fields: { sub_operation: subOperation },
  });
}

/** An org found for the actor, with its type. */
interface FoundOrg {
  org: Organisation;
  orgType: 'network_facilitator' | 'aggregator';
}

/** The org ids an actor may read: the orgs it owns and their direct children. */
async function viewable(actor: Actor): Promise<string[]> {
  const ids = await viewableOrgIds(actor);
  if (!ids.ok) dbDown('orgStore.childIds', ids.error.message);
  return ids.value;
}

/**
 * Loads an org within the actor's reach (the root for the network admin
 * only), else 404. With `view`, an owner also reaches the direct children of
 * its own orgs.
 *
 * @throws {HttpError} NOT_FOUND / DB_UNAVAILABLE.
 */
async function orgInReach(
  actor: Actor,
  id: string,
  purpose: 'manage' | 'view' = 'manage',
): Promise<FoundOrg> {
  const store = getOrganisationStore();
  const found = await store.findById(id);
  if (!found.ok) dbDown('orgStore.findById', found.error.message);
  if (found.value) {
    let inReach = reachesOrg(actor, found.value.id);
    if (!inReach && purpose === 'view') inReach = (await viewable(actor)).includes(found.value.id);
    if (!inReach) throw httpError('NOT_FOUND');
    return { org: found.value, orgType: 'aggregator' };
  }
  if (isNetworkAdmin(actor)) {
    const root = await store.findRoot();
    if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
    if (root.value?.id === id) return { org: root.value, orgType: 'network_facilitator' };
  }
  throw httpError('NOT_FOUND');
}

/**
 * The counts shown for an org: its users, pending users and child orgs. A
 * child org the caller only views reports zero for all three, since its users
 * and its own children are not visible from above.
 */
function countsFor(
  actor: Actor,
  orgId: string,
  users: { total: number; pending: number } | undefined,
  childCount: number | undefined,
): { coordinator_count: number; child_count: number; pending_count: number } {
  if (isOnlyViewed(actor, orgId)) return { coordinator_count: 0, child_count: 0, pending_count: 0 };
  return {
    coordinator_count: users?.total ?? 0,
    child_count: childCount ?? 0,
    pending_count: users?.pending ?? 0,
  };
}

/** Refuses a non-network-admin with 403 (a route its kind cannot use). */
function requireNetworkAdmin(actor: Actor): void {
  if (!isNetworkAdmin(actor)) throw httpError('FORBIDDEN');
}

/**
 * Refuses an edit by anyone but the org's owner, with 403. The network admin
 * views other owners' details but does not change them.
 *
 * @throws {HttpError} FORBIDDEN.
 */
function requireOwner(actor: Actor, org: Organisation): void {
  if (org.ownerUserId !== actor.userId) throw httpError('FORBIDDEN');
}

/** The instance's organisation settings, from the network config. */
async function organisationConfig(): Promise<OrganisationConfig> {
  return (await getNetworkConfig()).aggregator.organisation;
}

/**
 * Whether the actor may set the org's `known_as`: the parent is an active org
 * the actor owns, or the parent is the root and the actor is the network admin.
 * Never for the root or the Default org.
 *
 * @throws {HttpError} DB_UNAVAILABLE when the root cannot be read.
 */
async function ownsParentOf(actor: Actor, org: Organisation): Promise<boolean> {
  if (org.parentId === null || org.isDefault) return false;
  if (ownedOrgIds(actor).includes(org.parentId)) return true;
  if (!isNetworkAdmin(actor)) return false;
  const root = await getOrganisationStore().findRoot();
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  return root.value?.id === org.parentId;
}

/**
 * Whether the actor decides for an org: it owns the org's parent and, with
 * access control enforced, holds `orgs.onboard` in that parent. The route
 * guard only checks the permission somewhere among the actor's orgs.
 *
 * @throws {HttpError} DB_UNAVAILABLE when the root cannot be read.
 */
async function decidesFor(req: FastifyRequest, actor: Actor, org: Organisation): Promise<boolean> {
  if (!(await ownsParentOf(actor, org))) return false;
  const rt = getRbacRuntime();
  if (rt?.mode !== 'enforce' || org.parentId === null) return true;
  const root = await getOrganisationStore().findRoot();
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  const perms = await permissionsByOrg(req, actor, root.value?.id ?? null);
  if (perms === null) return true;
  return (perms[org.parentId] ?? []).includes('orgs.onboard');
}

/**
 * Reads the "known as" values an org or the root defines for its children.
 *
 * @param id - The org id.
 * @returns The list; empty when the org has none.
 * @throws {HttpError} DB_UNAVAILABLE.
 */
async function knownAsValuesOf(id: string): Promise<KnownAsValues> {
  const values = await getOrganisationStore().knownAsValues(id);
  if (!values.ok) dbDown('orgStore.knownAsValues', values.error.message);
  return values.value;
}

/**
 * The parent block of the org read: the parent and its stored list, or null
 * when the actor cannot set the org's `known_as` (see {@link ownsParentOf}; a
 * rejected org is not changed).
 *
 * @throws {HttpError} DB_UNAVAILABLE.
 */
async function parentBlockFor(actor: Actor, org: Organisation): Promise<OrgReadParent | null> {
  if (org.status === 'inactive' || !(await ownsParentOf(actor, org))) return null;
  const parentId = org.parentId!;
  // The store sets parentName for every org but the root.
  return { id: parentId, name: org.parentName!, known_as_values: await knownAsValuesOf(parentId) };
}

/**
 * Maps a refused move from the store to its HTTP error.
 *
 * @param e - The store error.
 * @param subOperation - The store call, for a `DB_UNAVAILABLE` log.
 * @throws {HttpError} Always.
 */
function throwTreeError(e: OrgStoreError, subOperation: string): never {
  if (e.code === 'NOT_FOUND') throw httpError('NOT_FOUND');
  throwTreeRefusal(e);
  dbDown(subOperation, e.message);
}

/**
 * Maps a refused "known as" write from the store to its HTTP error.
 *
 * @param e - The store error.
 * @param subOperation - The store call, for a `DB_UNAVAILABLE` log.
 * @throws {HttpError} Always.
 */
function throwKnownAsError(e: OrgStoreError, subOperation: string): never {
  switch (e.code) {
    case 'NOT_FOUND':
      throw httpError('NOT_FOUND');
    case 'KNOWN_AS_INVALID':
      throw httpError('SCHEMA_VALIDATION', {
        detail: "known_as is not one of the parent organisation's values.",
        fields: { known_as: 'invalid' },
      });
    case 'ORG_MOVED':
      throw httpError('CONFLICT', {
        detail: 'The organisation was moved. Reload and try again.',
        fields: { reason: 'moved' },
      });
    case 'KNOWN_AS_UNKNOWN_KEY':
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'A value sent a key that is not saved. Send no key for a new value.',
        fields: { known_as_values: 'unknown_key', index: e.index },
      });
    case 'NOT_EDITABLE':
      throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
    default:
      dbDown(subOperation, e.message);
  }
}

/**
 * Reads the hierarchy response: the network, the tree limits and the org
 * total, and the network's "known as" list when requested.
 *
 * @param fields - The extra data requested.
 * @throws {HttpError} DB_UNAVAILABLE when a store read fails.
 */
async function readHierarchy(fields: OrgHierarchyQuery['fields']): Promise<OrgHierarchyResponse> {
  const store = getOrganisationStore();
  const [root, total] = await Promise.all([store.findRoot(), store.countTotal()]);
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  if (!root.value) dbDown('orgStore.findRoot', 'network root missing');
  if (!total.ok) dbDown('orgStore.countTotal', total.error.message);
  const { hierarchy } = await organisationConfig();
  return {
    network: {
      id: root.value.id,
      name: root.value.displayName,
      ...(fields.includes('known_as_values')
        ? { known_as_values: await knownAsValuesOf(root.value.id) }
        : {}),
    },
    limits: {
      max_depth: hierarchy.max_depth,
      max_children: hierarchy.max_children ?? null,
      max_total_orgs: hierarchy.max_total_orgs,
    },
    total_orgs: total.value,
  };
}

/** Pending and active direct children per org; throws `DB_UNAVAILABLE` on a store failure. */
async function childCountsOf(ids: string[]): Promise<Record<string, number>> {
  const counts = await getOrganisationStore().childCounts(ids);
  if (!counts.ok) dbDown('orgStore.childCounts', counts.error.message);
  return counts.value;
}

/**
 * Replaces the "known as" values an org defines for its direct children.
 * Only the org's owner may, or the network admin for the root.
 *
 * @param found - The org, already in the actor's view reach.
 * @param values - The new list from the request.
 * @throws {HttpError} CONFLICT for the Default org, FORBIDDEN for a non-owner, and the store refusals.
 */
async function setKnownAsValues(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  { org, orgType }: FoundOrg,
  values: KnownAsValuesRequest,
): Promise<FastifyReply> {
  if (orgType === 'aggregator') {
    if (org.isDefault) {
      throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
    }
    if (!ownedOrgIds(actor).includes(org.id)) throw httpError('FORBIDDEN');
  }
  await guardWriteRate(actor, reply);

  const updated = await getOrganisationStore().setKnownAsValues(org.id, values, actor.userId);
  if (!updated.ok) throwKnownAsError(updated.error, 'orgStore.setKnownAsValues');
  req.log.info({
    operation: 'console.org.known_as_values',
    status: 'success',
    actor_id: actor.userId,
    target_id: org.id,
    value_count: updated.value.values.length,
    reset_count: updated.value.resetCount,
  });
  return reply.status(200).send({
    ...toWireOrg(updated.value.org, orgType),
    known_as_values: updated.value.values,
    reset_count: updated.value.resetCount,
  });
}

/**
 * Registers the `/v1/org/*` console routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1OrgRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/org/read/:id',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: 'One organisation within reach, with its owner and coordinator counts',
        description:
          "An owner also reads, read-only, the direct children of its own organisations, and nothing deeper; the owner contact of such an organisation is masked, except to the parent's owner while the organisation is pending. The network admin reads the top-level organisations the same way. For such an organisation coordinator_count, pending_count and child_count are 0. The fields query adds data that is left out by default. fields=known_as_values adds org.known_as_values: the values the organisation defines for its direct children, or null when it cannot have child organisations (the Default organisation, or an organisation at max_depth). fields=parent.known_as_values adds org.parent: the parent's id, name and stored known_as_values list ([] when it has none), which holds the choices for this org's known_as (the list, or only \"aggregator\" when it is empty). org.parent is null unless the caller owns the parent (the network admin for a top-level organisation), and for the root, the Default organisation and a rejected organisation. An unknown name in fields answers 400 SCHEMA_VALIDATION.",
        params: IdParamsSchema,
        querystring: OrgReadQuerySchema,
        response: { 200: OrgReadResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const { fields } = req.query as OrgReadQuery;
      const { org, orgType } = await orgInReach(actor, id, 'view');
      const below = orgType === 'aggregator' && isOnlyViewed(actor, org.id);
      const counts = await getUserStore().countByOrg([org.id]);
      if (!counts.ok) dbDown('userStore.countByOrg', counts.error.message);
      const c = counts.value[org.id];
      const children = await childCountsOf([org.id]);
      const { hierarchy } = await organisationConfig();
      const isRoot = orgType === 'network_facilitator';
      req.log.info({
        operation: 'console.org.read',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        relation: below ? 'below' : 'own',
      });
      const body: OrgReadResponse = {
        org: toWireOrg(org, orgType),
        // An org only viewed from above shows its owner's contact masked, except
        // to the parent's owner while the org waits for that owner's decision.
        owner: {
          id: org.ownerUserId,
          contact: ownerContact(org, {
            masked: below && !(org.status === 'pending' && (await ownsParentOf(actor, org))),
          }),
        },
        // A child org's users and its own children are not visible from above.
        coordinator_count: below ? 0 : (c?.total ?? 0),
        child_count: below ? 0 : (children[org.id] ?? 0),
        pending_count: below ? 0 : (c?.pending ?? 0),
      };
      if (fields.includes('known_as_values')) {
        const childrenAllowed = isRoot || (!org.isDefault && org.depth < hierarchy.max_depth);
        body.org.known_as_values = childrenAllowed ? await knownAsValuesOf(org.id) : null;
      }
      if (fields.includes('parent.known_as_values')) {
        body.org.parent = isRoot ? null : await parentBlockFor(actor, org);
      }
      return reply.status(200).send(body);
    },
  );

  app.post(
    '/v1/org/search',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: 'Organisations within reach, by name',
        description:
          "An owner sees the organisations it owns and, read-only, their direct children; nothing deeper. The network admin owns the network, so it sees the top-level organisations. With `parent_id` set to an org within reach, lists that org's direct children. For an org the caller does not own, coordinator_count, pending_count and child_count are 0. `descendants_of` lists the orgs below an org within reach, limited to the same reach. The two cannot be sent together. Filters by status and a case-insensitive name prefix; keyset paged by an opaque cursor.",
        body: OrgSearchRequestSchema,
        response: { 200: OrgSearchResponseSchema, ...errorResponses(400, 401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const body = req.body as z.infer<typeof OrgSearchRequestSchema>;
      const { descendants_of: below, parent_id: parentId } = body.filter;
      // The result is always limited to the caller's view reach; a filter only
      // narrows it. A filter on an org out of reach gives an empty page.
      const view = await viewable(actor);
      const anchor = below ?? parentId;
      const orgIds = anchor === undefined || view.includes(anchor) ? view : [];
      const page = await getOrganisationStore().search({
        orgIds,
        ...(below ? { descendantsOf: below } : {}),
        ...(parentId ? { parentId } : {}),
        ...(body.filter.status ? { status: body.filter.status } : {}),
        ...(body.filter.name_prefix ? { namePrefix: body.filter.name_prefix } : {}),
        ...(body.cursor ? { cursor: decodeOrgCursor(body.cursor) } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });
      if (!page.ok) dbDown('orgStore.search', page.error.message);
      const ids = page.value.rows.map((o) => o.id);
      const counts = await getUserStore().countByOrg(ids);
      if (!counts.ok) dbDown('userStore.countByOrg', counts.error.message);
      const children = await childCountsOf(ids);
      return reply.status(200).send({
        orgs: page.value.rows.map((o) => ({
          ...toWireOrg(o),
          ...countsFor(actor, o.id, counts.value[o.id], children[o.id]),
        })),
        next_cursor: page.value.nextCursor ? encodeOrgCursor(page.value.nextCursor) : null,
      });
    },
  );

  app.patch(
    '/v1/org/metadata/update/:id',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: "Update an organisation's details",
        description:
          "Every field, the name included, is the org's owner's only (the slug never changes); the network admin views other owners' orgs but does not edit them (403). known_as changes through PATCH /v1/org/known-as/update/:id and the parent through PATCH /v1/org/parent/update/:id. The Default org's details are not editable. `profile` changes fields of the deployment's org-registration schema (e.g. website, GST number, domains): only fields marked x-updatable, checked against that schema; null removes a field. A bad field answers 400 with fields.field_errors and saves nothing. Locations, legal name, website and GST number are rendered for every coordinator of the org; description is shown in the console only.",
        params: IdParamsSchema,
        body: OrgMetadataUpdateRequestSchema,
        response: { 200: OrgSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgMetadataUpdateRequestSchema>;
      // A direct child is visible, so editing it answers 403 rather than 404.
      const { org, orgType } = await orgInReach(actor, id, 'view');
      if (orgType !== 'aggregator' || org.isDefault) {
        throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
      }
      requireOwner(actor, org);
      // Schema fields: only those marked x-updatable, checked against the schema.
      let profileMerge: Record<string, unknown> | undefined;
      if (body.profile !== undefined) {
        const checked = await validateOrgUpdate(body.profile);
        if (!checked.ok) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: Object.entries(checked.errors)
              .map(([field, message]) => `${field}: ${message}`)
              .join('; '),
            fields: { field_errors: checked.errors },
          });
        }
        profileMerge = checked.values;
      }
      await guardWriteRate(actor, reply);

      const patch: UpdateOrgPatch = { updatedBy: actor.userId };
      if (body.name !== undefined) patch.displayName = body.name;
      if (body.locations !== undefined) patch.locations = body.locations;
      if (body.legal_name !== undefined) patch.legalName = body.legal_name;
      // An empty description is stored as "none".
      if (body.description !== undefined) patch.description = body.description || null;
      if (profileMerge) patch.profileMerge = profileMerge;

      const updated = await getOrganisationStore().update(org.id, patch);
      if (!updated.ok) {
        if (updated.error.code === 'DUPLICATE_NAME') throw httpError('ORG_NAME_TAKEN');
        throwTreeError(updated.error, 'orgStore.update');
      }
      const fields = Object.keys(body);
      req.log.info({
        operation: 'console.org.update',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        fields,
      });
      return reply.status(200).send(toWireOrg(updated.value));
    },
  );

  app.patch(
    '/v1/org/known-as/update/:id',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary:
          'Set what an organisation is known as, or the "known as" values it defines for the organisations under it',
        description:
          'The body has exactly one of known_as or known_as_values. An organisation the caller cannot see answers 404.\n\n' +
          "known_as sets the organisation's own value. Only the owner of the organisation's parent sets it: the network admin for a top-level organisation, else the owner of the parent organisation (an active organisation it owns); anyone else gets 403. known_as must be a key of the parent's list, or aggregator when that list is empty (400 SCHEMA_VALIDATION with fields.known_as otherwise). The network, the Default organisation and a rejected organisation answer 409, and so does an organisation moved while the request ran (fields.reason: moved). The organisation's owner is emailed when it is not the caller. Sending the current value answers 200 with the organisation unchanged and sends no email.\n\n" +
          "known_as_values replaces the whole list the organisation defines for its direct children, and the response adds the saved known_as_values with every key set. Only the organisation's owner sets it (an active organisation it owns; the network's list for the network admin): 403 when the caller sees but does not own it, 409 for the Default organisation. An entry that is already saved sends its key back and keeps it; a new entry sends only a name, and the API makes its key from the name. A key that is not already in the list answers 400 SCHEMA_VALIDATION (fields.known_as_values: unknown_key, fields.index). At most one entry is the default; new organisations under this one get it, else aggregator. Organisations under this one whose value leaves the list take the default, else aggregator; a renamed entry keeps its key, so they keep it too.",
        params: IdParamsSchema,
        body: OrgKnownAsUpdateRequestSchema,
        response: {
          200: OrgKnownAsUpdateResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as OrgKnownAsUpdateRequest;
      const { org, orgType } = await orgInReach(actor, id, 'view');
      if ('known_as_values' in body) {
        return setKnownAsValues(req, reply, actor, { org, orgType }, body.known_as_values);
      }
      if (orgType !== 'aggregator' || org.isDefault || org.status === 'inactive') {
        throw httpError('CONFLICT', {
          detail: 'What this organisation is known as cannot be changed.',
        });
      }
      if (!(await ownsParentOf(actor, org))) throw httpError('FORBIDDEN');
      // The org already has this value: nothing is written and no one is emailed.
      if (body.known_as === org.knownAs) return reply.status(200).send(toWireOrg(org));
      await guardWriteRate(actor, reply);

      const updated = await getOrganisationStore().setKnownAs(
        org.id,
        body.known_as,
        org.parentId!,
        actor.userId,
      );
      if (!updated.ok) throwKnownAsError(updated.error, 'orgStore.setKnownAs');
      req.log.info({
        operation: 'console.org.known_as',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        parent_id: org.parentId,
      });
      await notifyOwnerOfParentAction(actor, updated.value, req.log);
      return reply.status(200).send(toWireOrg(updated.value));
    },
  );

  app.patch(
    '/v1/org/parent/update/:id',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Move an organisation under a new parent (network admin)',
        description:
          "Moves the organisation and every organisation below it; their depths follow. The org must be pending or active, not the Default org. The parent must be the network or an active organisation, not the org or one below it, with room for another child, and the moved orgs must stay within max_depth. The moved org keeps its known_as when the new parent's list has it; otherwise it takes the new parent's default value, else aggregator. Organisations below it keep theirs. The owner is told when the org moved.",
        params: IdParamsSchema,
        body: OrgParentUpdateRequestSchema,
        response: { 200: OrgSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgParentUpdateRequestSchema>;
      // The org and its new parent must both be within the admin's view reach.
      const view = await viewable(actor);
      if (!view.includes(id) || !view.includes(body.parent_id)) throw httpError('NOT_FOUND');
      const orgCfg = await organisationConfig();
      await guardWriteRate(actor, reply);

      const moved = await getOrganisationStore().move(
        id,
        { parentId: body.parent_id },
        treeRules(orgCfg),
      );
      if (!moved.ok) throwTreeError(moved.error, 'orgStore.move');
      const { org, oldParentId, movedCount } = moved.value;
      req.log.info({
        operation: 'console.org.move',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        old_parent_id: oldParentId,
        new_parent_id: org.parentId,
        moved_count: movedCount,
      });
      if (movedCount > 0) {
        await notifyOwnerOfAdminAction(
          actor,
          org,
          `moved it under ${org.parentName ?? 'the network'}`,
          req.log,
        );
      }
      return reply.status(200).send(toWireOrg(org));
    },
  );

  app.get(
    '/v1/org/parent/options/:id',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Candidate parents for moving an organisation (network admin)',
        description:
          'Every org that could be the new parent, the network first, each with the result a move there would give: ok, or the refusal code in reason (INVALID_PARENT, PARENT_CYCLE, CHILD_LIMIT, DEPTH_LIMIT, or NOT_MOVABLE). subtree_size counts the orgs that move.',
        params: IdParamsSchema,
        response: { 200: OrgParentOptionsResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      // Only orgs within the admin's view reach are moved or offered as parents.
      const view = await viewable(actor);
      if (!view.includes(id)) throw httpError('NOT_FOUND');
      const orgCfg = await organisationConfig();
      const result = await getOrganisationStore().parentOptions(id, treeRules(orgCfg));
      if (!result.ok) throwTreeError(result.error, 'orgStore.parentOptions');
      return reply.status(200).send({
        subtree_size: result.value.subtreeSize,
        options: result.value.options
          .filter(({ org }) => view.includes(org.id))
          .map(({ org, ok, reason }) => ({
            id: org.id,
            name: org.displayName,
            depth: org.depth,
            known_as_name: org.depth === 0 ? null : org.knownAsName,
            ok,
            reason,
          })),
      });
    },
  );

  app.post(
    '/v1/org/decision/:id',
    {
      config: { rbac: { capability: 'orgs.onboard' } },
      schema: {
        tags: ['console'],
        summary: "Approve or reject a pending organisation (its parent's owner)",
        description:
          "Only the owner of the organisation's parent decides: the network admin for a top-level organisation, else the owner of the parent organisation. Anyone else gets 404. A rejection must give a reason (400 SCHEMA_VALIDATION otherwise). The same compare-and-set service as the emailed review link. Approval enables the owner's sign-in (owner_access reports how far it got; repair re-runs it).",
        params: IdParamsSchema,
        body: OrgDecisionRequestSchema,
        response: {
          200: OrgDecisionResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgDecisionRequestSchema>;
      const found = await getOrganisationStore().findById(id);
      if (!found.ok) dbDown('orgStore.findById', found.error.message);
      if (!found.value || !(await decidesFor(req, actor, found.value))) {
        throw httpError('NOT_FOUND');
      }
      await guardWriteRate(actor, reply);

      const outcome = await decideOrg({
        orgId: id,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
        decidedBy: actor.userId,
        log: req.log.child({ actor_id: actor.userId }),
      });
      switch (outcome.kind) {
        case 'decided':
          return reply.status(200).send({
            id,
            status: outcome.decision === 'approve' ? 'active' : 'inactive',
            notified: outcome.notified,
            owner_access: outcome.decision === 'approve' ? outcome.ownerAccess.status : 'none',
          });
        case 'already_decided':
          throw httpError('ALREADY_DECIDED', {
            fields: {
              status: outcome.status,
              decided_at: outcome.decidedAt.toISOString(),
              decided_by: outcome.decidedBy,
            },
          });
        case 'not_found':
          throw httpError('NOT_FOUND');
        case 'unavailable':
          throw httpError('DB_UNAVAILABLE');
      }
    },
  );

  app.post(
    '/v1/org/access/repair/:id',
    {
      config: { rbac: { capability: 'orgs.onboard' } },
      schema: {
        tags: ['console'],
        summary: "Re-apply an active organisation's owner sign-in access (its parent's owner)",
        description:
          "Only the owner of the organisation's parent repairs it: the network admin for a top-level organisation, else the owner of the parent organisation. Anyone else gets 404. Enables the owner's Keycloak user, grants the org_owner role and adds them to the org's group. Idempotent.",
        params: IdParamsSchema,
        response: {
          200: OwnerAccessResponseSchema,
          ...errorResponses(401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const { org, orgType } = await orgInReach(actor, id, 'view');
      if (orgType === 'aggregator' && !(await decidesFor(req, actor, org))) {
        throw httpError('NOT_FOUND');
      }
      if (orgType !== 'aggregator' || org.status !== 'active') {
        throw httpError('CONFLICT', { detail: 'Only an active organisation has owner access.' });
      }
      await guardWriteRate(actor, reply);
      const log = req.log.child({
        operation: 'console.org.repairAccess',
        actor_id: actor.userId,
        target_id: org.id,
      });
      const result = await grantOwnerAccess(org, log);
      log.info({ status: 'success', owner_access: result.status });
      return reply.status(200).send({ id: org.id, ...result });
    },
  );

  app.get(
    '/v1/org/hierarchy',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'The network, its "known as" values and the tree limits (network admin)',
        description:
          'Read-only. The network, the tree limits from the instance config, and how many pending and active organisations count toward max_total_orgs. Depth 1 sits directly under the network. fields=known_as_values adds network.known_as_values: the "known as" values the network defines for top-level organisations (edited through PATCH /v1/org/known-as/update/:id with known_as_values). An unknown name in fields answers 400 SCHEMA_VALIDATION.',
        querystring: OrgHierarchyQuerySchema,
        response: { 200: OrgHierarchyResponseSchema, ...errorResponses(401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { fields } = req.query as OrgHierarchyQuery;
      return reply.status(200).send(await readHierarchy(fields));
    },
  );
}
