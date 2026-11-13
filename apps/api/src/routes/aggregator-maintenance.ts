/**
 * Maintenance endpoints for the aggregator registration lifecycle.
 *
 * `@aggregator-dpg/api`. Deletes pending registrations (database row and
 * Keycloak user) whose approval link expired unused, so the email and phone
 * can register again. Called by a scheduler with a service-account token.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getUserStore } from '../services/user-store/index.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpAdminAdapter } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { callerFromAny, recordRouteCaller, isServiceAccount } from '../services/authz/index.js';

/** Minimal Result shape the prune helper needs from an idp delete. */
type DeleteResult = { ok: true } | { ok: false; error: { code: string } };
/** Minimal Result shape for resolving the KC user (id or null) to delete. */
type UserLookupResult =
  { ok: true; value: { id: string } | null } | { ok: false; error: { code: string } };
/** Minimal Result shape of a store's `deleteIfPending`. */
type DeleteIfPendingResult =
  | { ok: true; value: 'deleted' | 'not_pending' | 'aborted' }
  | { ok: false; error: { code: string } };

/** Describes how to prune one kind of stale row. */
interface PruneSpec<T> {
  /** Stale rows to prune, already filtered by the cutoff. */
  rows: T[];
  /**
   * Finds the Keycloak user to delete from the row's stored link, never by email.
   */
  resolveUser: (row: T) => Promise<UserLookupResult>;
  /** Row id (for logs). */
  idOf: (row: T) => string;
  /** Optional Keycloak cleanup after the user delete, such as the org's group. */
  afterUserDelete?: (row: T) => Promise<DeleteResult> | null;
  /**
   * Deletes the row only while it is still pending and stale, running
   * `beforeCommit` (the Keycloak cleanup) with the row locked.
   */
  deleteIfPending: (row: T, beforeCommit: () => Promise<boolean>) => Promise<DeleteIfPendingResult>;
  /** Log id field name (`aggregator_id` | `org_id`). */
  logIdField: 'aggregator_id' | 'org_id';
  /** Log message kind (`stale-pending` | `stale-org`). */
  kind: string;
}

/**
 * Deletes each stale row and its Keycloak user, skipping with a warning any row whose call fails.
 *
 * Skipped rows are retried on the next pass. The row is deleted in a
 * transaction that only matches pending, stale rows; the Keycloak delete runs
 * inside it, and a Keycloak failure rolls the row back. A row already decided
 * is left alone (`not_pending`).
 *
 * @returns The ids that were fully pruned.
 */
async function pruneStale<T>(
  spec: PruneSpec<T>,
  idp: IdpAdminAdapter,
  log: FastifyBaseLogger,
): Promise<string[]> {
  const prunedIds: string[] = [];
  for (const row of spec.rows) {
    const id = spec.idOf(row);
    const warn = (code: string, step: string): void =>
      log.warn(
        { status: 'skipped', [spec.logIdField]: id, code },
        `skipped ${spec.kind} prune — ${step}`,
      );

    const kc = await spec.resolveUser(row);
    if (!kc.ok) {
      warn(kc.error.code, 'KC user lookup failed');
      continue;
    }

    const deleted = await spec.deleteIfPending(row, async () => {
      // NOSONAR typescript:S9382 — sequential by design
      if (kc.value) {
        const del = await idp.deleteUser(kc.value.id);
        if (!del.ok) {
          warn(del.error.code, 'KC user delete failed');
          return false;
        }
      }
      const extra = spec.afterUserDelete?.(row);
      if (extra) {
        const extraRes = await extra;
        if (!extraRes.ok) {
          warn(extraRes.error.code, 'KC group delete failed');
          return false;
        }
      }
      return true;
    });
    if (!deleted.ok) {
      warn(deleted.error.code, 'DB delete failed');
      continue;
    }
    if (deleted.value === 'not_pending') {
      log.info(
        { status: 'skipped', [spec.logIdField]: id },
        `skipped ${spec.kind} prune — decided or touched meanwhile`,
      );
      continue;
    }
    if (deleted.value === 'deleted') prunedIds.push(id);
  }
  return prunedIds;
}

const CleanupResponseSchema = z
  .object({
    scanned: z.number(),
    pruned: z.number(),
    prunedIds: z.array(z.string()),
    orgsScanned: z.number(),
    orgsPruned: z.number(),
    orgsPrunedIds: z.array(z.string()),
  })
  .passthrough();

/**
 * Registers the route that deletes stale pending registrations and orgs.
 *
 * The cutoff is `now - (APPROVAL_TOKEN_TTL_SECONDS*1000 + REGISTRATION_PENDING_GRACE_MS)`.
 *
 * @param app - Fastify instance to attach the route to.
 */
export async function registerAggregatorMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/v1/aggregator-registrations/cleanup-stale',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Prune registrations stuck pending past token expiry + grace',
        response: { 200: CleanupResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.cleanup-stale' });
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', { detail: auth.error.message });
      }
      // Service-account tokens only. `preferred_username` identifies them; `sub` does not.
      if (!isServiceAccount(auth.context.preferredUsername)) {
        throw httpError('FORBIDDEN', {
          detail: 'cleanup-stale requires a service-account token',
          fields: { subject: auth.context.subject },
        });
      }
      await recordRouteCaller(req, callerFromAny(auth.context));

      const store = getUserStore();
      const idp = getIdpAdmin();
      const cutoffMs =
        Date.now() -
        (config.APPROVAL_TOKEN_TTL_SECONDS * 1000 + config.REGISTRATION_PENDING_GRACE_MS);
      const cutoff = new Date(cutoffMs);

      // Filter by age in SQL so the row cap counts only stale rows.
      const page = await store.list({
        status: 'pending',
        updatedBefore: cutoff,
        limit: 1000,
        offset: 0,
      });
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'userStore.list' },
        });
      }

      if (page.value.rows.length === 1000) {
        log.warn(
          { scanned: 1000 },
          'stale-pending cleanup hit the 1000-row cap — more stale rows remain for the next pass',
        );
      }

      const prunedIds = await pruneStale(
        {
          rows: page.value.rows,
          resolveUser: (r) => idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, r.id),
          idOf: (r) => r.id,
          deleteIfPending: (r, beforeCommit) => store.deleteIfPending(r.id, cutoff, beforeCommit),
          logIdField: 'aggregator_id',
          kind: 'stale-pending',
        },
        idp,
        log,
      );

      // Prune stale pending orgs with the same cutoff, plus their Keycloak group.
      // The root and Default orgs are never pending.
      const orgStore = getOrganisationStore();
      let orgsScanned = 0;
      let orgsPrunedIds: string[] = [];
      {
        const orgPage = await orgStore.listPending(cutoff);
        if (!orgPage.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(orgPage.error.message),
            fields: { sub_operation: 'orgStore.listPending' },
          });
        }
        orgsScanned = orgPage.value.length;
        orgsPrunedIds = await pruneStale(
          {
            rows: orgPage.value,
            // Find the owner by recorded login, not email. An owner of another
            // org keeps their Keycloak user; only this org's group and row go.
            resolveUser: async (o) => {
              if (!o.ownerKcSub) return { ok: true as const, value: null };
              const shared = await orgStore.ownerIsShared(o.id);
              if (!shared.ok) {
                return {
                  ok: false as const,
                  error: { code: 'IDP_UNAVAILABLE' as const, message: shared.error.message },
                };
              }
              if (shared.value) return { ok: true as const, value: null };
              return idp.findById(o.ownerKcSub);
            },
            idOf: (o) => o.id,
            afterUserDelete: (o) => (o.kcGroupId ? idp.deleteGroup(o.kcGroupId) : null),
            deleteIfPending: (o, beforeCommit) =>
              orgStore.deleteIfPending(o.id, cutoff, beforeCommit),
            logIdField: 'org_id',
            kind: 'stale-org',
          },
          idp,
          log,
        );
      }

      log.info(
        {
          status: 'success',
          scanned: page.value.rows.length,
          pruned: prunedIds.length,
          orgsScanned,
          orgsPruned: orgsPrunedIds.length,
        },
        'stale-pending cleanup complete',
      );
      return reply.status(200).send({
        scanned: page.value.rows.length,
        pruned: prunedIds.length,
        prunedIds,
        orgsScanned,
        orgsPruned: orgsPrunedIds.length,
        orgsPrunedIds,
      });
    },
  );
}
