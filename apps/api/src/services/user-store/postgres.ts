/**
 * Postgres adapter for the api coordinator store.
 *
 * Runs Drizzle queries against the `users` table and maps driver errors to
 * `StoreError` codes.
 *
 * Contact data is read from `contact` through `users.contact_id` and composed
 * into the Beckn `contact` shape. Contact writes run in the same transaction as
 * the row (`db/contact-writes.ts`). Every write re-reads the joined row, since
 * `RETURNING` cannot include the join.
 *
 * Org details come from the joined org with the `legacy_org_details` fallback.
 * Consent is read from the newest registration row in `consent_record`, and
 * written by the caller's `recordConsent` hook inside the create transaction.
 */

import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { AggregatorStatus, BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { logger } from '../../logger.js';
import {
  users,
  contact,
  organisations,
  consentRecord,
  registrationInvites,
} from '../../db/schema.js';
import { DEFAULT_ORG_SLUG } from '../organisation-store/interface.js';
import { renderOrgDetails } from './org-details.js';
import { servesOf } from './serves.js';
import {
  changeContact,
  ContactTakenError,
  linkContact,
  SharedContactError,
  splitBecknContact,
  type DbExecutor,
} from '../../db/contact-writes.js';
import { getDb } from '../../db/client.js';
import {
  PG_UNIQUE_VIOLATION,
  PG_CHECK_VIOLATION,
  pgErrorCode,
  pgConstraint,
} from '../../db/pg-error.js';
import {
  UserStoreBase,
  type Coordinator,
  type CreateCoordinatorInput,
  type ListCoordinatorsFilter,
  type ListCoordinatorsPage,
  type DeleteIfPendingOutcome,
  type OrgCoordinatorCounts,
  type SearchCoordinatorsFilter,
  type SearchCoordinatorsPage,
  type StoreError,
  type StoreResult,
  type UpdateCoordinatorPatch,
} from './interface.js';

/** Ledger sources that record a registration consent (the others are attestations). */
const REGISTRATION_CONSENT_SOURCES = sql`('registration', 'registration-backfill')`;

/** Wraps a failure of the caller's `recordConsent` hook so `create` can tell it apart. */
class ConsentHookError extends Error {
  constructor(cause: unknown) {
    super('recordConsent failed', { cause });
    this.name = 'ConsentHookError';
  }
}

export class PostgresUserStore extends UserStoreBase {
  async create(input: CreateCoordinatorInput): Promise<StoreResult<Coordinator>> {
    const start = Date.now();
    let created: Coordinator | null;
    try {
      // The contact and the row that references it are written atomically.
      created = await getDb().transaction(async (tx) => {
        const { identity, extra } = splitBecknContact(input.contact);
        const contactId = await linkContact(tx, identity);
        const rows = await tx
          .insert(users)
          .values({
            userType: 'coordinator',
            signalstackOrgSlug: input.orgSlug,
            signalstackOrgName: input.name,
            serves: servesOf(input.type),
            contactId,
            alternatePhone: extra.alternatePhone ?? null,
            createdBy: input.createdBy,
            updatedBy: input.updatedBy,
            orgId: input.orgId,
            legacyOrgDetails: input.legacyOrgDetails ?? null,
            inviteId: input.inviteId ?? null,
            profile: input.profile ?? {},
            profileRef: input.profileRef ?? null,
          })
          .returning({ id: users.id });
        const id = rows[0]?.id;
        if (!id) return null;
        // The consent row commits with the account, or neither does.
        if (input.recordConsent) {
          try {
            await input.recordConsent(tx, id);
          } catch (hookErr: unknown) {
            throw new ConsentHookError(hookErr);
          }
        }
        return this.readIn(tx, id);
      });
    } catch (err: unknown) {
      if (err instanceof ConsentHookError) {
        logger.error({
          operation: 'userStore.create',
          status: 'failure',
          error: 'CONSENT_WRITE_FAILED',
          error_type: (err.cause as Error | undefined)?.name ?? 'unknown',
          latency_ms: Date.now() - start,
        });
        return {
          ok: false,
          error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
        };
      }
      return this.mapWriteError('userStore.create', err, input.orgSlug, start);
    }
    if (!created) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
    }
    logger.info({
      operation: 'userStore.create',
      status: 'success',
      latency_ms: Date.now() - start,
      aggregator_id: created.id,
    });
    return { ok: true, value: created };
  }

  async findById(id: string): Promise<StoreResult<Coordinator | null>> {
    return this.findOne('userStore.findById', eq(users.id, id));
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Coordinator | null>> {
    return this.findOne('userStore.findBySlug', eq(users.signalstackOrgSlug, orgSlug));
  }

  async findByContactPhone(phone: string): Promise<StoreResult<Coordinator | null>> {
    // `contact_id = (subselect)` keeps both lookups on their unique indexes.
    return this.findOne(
      'userStore.findByContactPhone',
      eq(
        users.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.phone} = ${phone})`,
      ),
    );
  }

  async findByContactEmail(email: string): Promise<StoreResult<Coordinator | null>> {
    const e = email.trim().toLowerCase();
    return this.findOne(
      'userStore.findByContactEmail',
      eq(
        users.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.email} = ${e})`,
      ),
    );
  }

  async findByParentOrgId(orgId: string): Promise<StoreResult<Coordinator[]>> {
    try {
      const rows = await this.selectJoined().where(coordinator(eq(users.orgId, orgId)));
      return { ok: true, value: rows.map(toDomain) };
    } catch (err: unknown) {
      return this.mapReadError('userStore.findByParentOrgId', err);
    }
  }

  async list(filter: ListCoordinatorsFilter): Promise<StoreResult<ListCoordinatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    try {
      const conds = [];
      if (filter.status) conds.push(eq(users.status, filter.status));
      if (filter.updatedBefore) conds.push(lt(users.updatedAt, filter.updatedBefore));
      const where = coordinator(...conds);

      const rows = await this.selectJoined()
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await getDb()
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(where);
      const total = totals[0]?.total ?? 0;
      return { ok: true, value: { rows: rows.map(toDomain), total } };
    } catch (err: unknown) {
      return this.mapReadError('userStore.list', err);
    }
  }

  async update(id: string, patch: UpdateCoordinatorPatch): Promise<StoreResult<Coordinator>> {
    // Typed, so a renamed column can never be dropped silently by `.set()`.
    const updates: Partial<typeof users.$inferInsert> = {
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) updates.signalstackOrgName = patch.name;
    if (patch.type !== undefined) updates.serves = servesOf(patch.type);
    if (patch.serves !== undefined) updates.serves = [...new Set(patch.serves)];
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.rejectedAt !== undefined) updates.rejectedAt = patch.rejectedAt;

    let updated: Coordinator | null;
    try {
      updated = await getDb().transaction(async (tx) => {
        if (patch.contact !== undefined) {
          // Lock the row, then move its contact. A re-key cascades to the FK.
          const [current] = await tx
            .select({ contactId: users.contactId })
            .from(users)
            .where(coordinator(eq(users.id, id)))
            .for('update');
          if (!current) return null;
          const { identity, extra } = splitBecknContact(patch.contact);
          updates.contactId = await changeContact(tx, current.contactId, identity);
          updates.alternatePhone = extra.alternatePhone ?? null;
        }
        const rows = await tx
          .update(users)
          .set(updates)
          .where(coordinator(eq(users.id, id)))
          .returning({ id: users.id });
        return rows.length > 0 ? this.readIn(tx, id) : null;
      });
    } catch (err: unknown) {
      if (err instanceof ContactTakenError) {
        logger.warn({
          operation: 'userStore.update',
          status: 'failure',
          error: 'CONTACT_TAKEN',
          aggregator_id: id,
        });
        return { ok: false, error: { code: 'DUPLICATE_EMAIL', message: err.message } };
      }
      if (err instanceof SharedContactError) {
        logger.warn({
          operation: 'userStore.update',
          status: 'failure',
          error: 'SHARED_CONTACT',
          aggregator_id: id,
        });
        return { ok: false, error: { code: 'DUPLICATE', message: err.message } };
      }
      return this.mapWriteError('userStore.update', err, id, Date.now());
    }
    if (!updated) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
    return { ok: true, value: updated };
  }

  async updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>> {
    return this.update(id, { status, updatedBy });
  }

  async approveFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator | null>> {
    try {
      const rows = await getDb()
        .update(users)
        .set({ status: 'active', updatedBy, updatedAt: new Date() })
        .where(coordinator(eq(users.id, id), eq(users.status, 'pending')))
        .returning({ id: users.id });
      // No row: not pending, already decided.
      if (!rows[0]) return { ok: true, value: null };
      return this.reread('userStore.approveFromPending', id);
    } catch (err: unknown) {
      return this.mapWriteError('userStore.approveFromPending', err, id, Date.now());
    }
  }

  async updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .update(users)
        .set({
          signalstackOrgId,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(coordinator(eq(users.id, id)))
        .returning({ id: users.id });
      if (!rows[0]) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      const updated = await this.reread('userStore.updateSignalstackOrgId', id);
      if (updated.ok) {
        logger.info({
          operation: 'userStore.updateSignalstackOrgId',
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: id,
        });
      }
      return updated;
    } catch (err: unknown) {
      return this.mapWriteError('userStore.updateSignalstackOrgId', err, id, start);
    }
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    try {
      const rows = await getDb()
        .delete(users)
        .where(coordinator(eq(users.id, id)))
        .returning({ id: users.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return this.mapReadError('userStore.deleteById', err);
    }
  }

  async rejectFromPending(id: string, updatedBy: string): Promise<StoreResult<Coordinator | null>> {
    try {
      const now = new Date();
      const rows = await getDb()
        .update(users)
        .set({ status: 'inactive', rejectedAt: now, updatedBy, updatedAt: now })
        .where(coordinator(eq(users.id, id), eq(users.status, 'pending')))
        .returning({ id: users.id });
      // No row: not pending, already decided.
      if (!rows[0]) return { ok: true, value: null };
      return this.reread('userStore.rejectFromPending', id);
    } catch (err: unknown) {
      return this.mapWriteError('userStore.rejectFromPending', err, id, Date.now());
    }
  }

  async deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<StoreResult<DeleteIfPendingOutcome>> {
    const ABORT = Symbol('abort');
    try {
      const outcome = await getDb().transaction(async (tx) => {
        // The DELETE locks the row; a concurrent approval waits for this transaction.
        const rows = await tx
          .delete(users)
          .where(
            coordinator(eq(users.id, id), eq(users.status, 'pending'), lt(users.updatedAt, cutoff)),
          )
          .returning({ id: users.id });
        if (!rows[0]) return 'not_pending' as const;
        if (!(await beforeCommit())) throw ABORT;
        return 'deleted' as const;
      });
      return { ok: true, value: outcome };
    } catch (err: unknown) {
      if (err === ABORT) return { ok: true, value: 'aborted' };
      return this.mapWriteError('userStore.deleteIfPending', err, id, Date.now());
    }
  }

  async search(filter: SearchCoordinatorsFilter): Promise<StoreResult<SearchCoordinatorsPage>> {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 20));
    if (filter.orgIds !== null && filter.orgIds.length === 0) {
      return { ok: true, value: { rows: [], nextCursor: null } };
    }
    try {
      const conds: (SQL | undefined)[] = [];
      if (filter.orgIds !== null) conds.push(inArray(users.orgId, filter.orgIds));
      if (filter.status) conds.push(eq(users.status, filter.status));
      if (filter.serves) {
        // '{}' serves every domain.
        conds.push(sql`(${users.serves} = '{}' OR ${filter.serves} = ANY(${users.serves}))`);
      }
      // Compare at millisecond precision: the cursor is a JS Date, `created_at`
      // has microseconds, and rows inserted in one transaction share an instant.
      const createdMs = sql`date_trunc('milliseconds', ${users.createdAt})`;
      if (filter.cursor) {
        const c = filter.cursor;
        conds.push(
          sql`(${createdMs}, ${users.id}) < (${c.createdAt.toISOString()}::timestamptz, ${c.id}::uuid)`,
        );
      }
      const rows = await this.selectJoined()
        .where(coordinator(...conds))
        .orderBy(sql`${createdMs} desc`, desc(users.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(toDomain);
      const last = page.at(-1);
      return {
        ok: true,
        value: {
          rows: page,
          nextCursor:
            rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
        },
      };
    } catch (err: unknown) {
      return this.mapReadError('userStore.search', err);
    }
  }

  async countByOrg(orgIds: string[]): Promise<StoreResult<Record<string, OrgCoordinatorCounts>>> {
    if (orgIds.length === 0) return { ok: true, value: {} };
    try {
      const rows = await getDb()
        .select({
          orgId: users.orgId,
          total: sql<number>`count(*)::int`,
          pending: sql<number>`count(*) FILTER (WHERE ${users.status} = 'pending')::int`,
        })
        .from(users)
        .where(coordinator(inArray(users.orgId, orgIds)))
        .groupBy(users.orgId);
      const out: Record<string, OrgCoordinatorCounts> = {};
      for (const id of orgIds) out[id] = { total: 0, pending: 0 };
      for (const r of rows) if (r.orgId) out[r.orgId] = { total: r.total, pending: r.pending };
      return { ok: true, value: out };
    } catch (err: unknown) {
      return this.mapReadError('userStore.countByOrg', err);
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * Builds the shared read: `users` JOIN `contact` LEFT JOIN its org.
   *
   * The org join is LEFT so a missing org never hides a coordinator. Callers
   * filter through {@link coordinator}.
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({
        a: users,
        c: contact,
        o: {
          slug: organisations.slug,
          // Website and GST number are schema fields, stored in `profile`.
          url: sql<string | null>`${organisations.profile} ->> 'website'`,
          locations: organisations.locations,
          legalName: organisations.legalName,
          gstNumber: sql<string | null>`${organisations.profile} ->> 'gst_number'`,
        },
        // Newest registration consent (epoch ms; the API composes ISO strings).
        consent: sql<{ at: number; till: number | null } | null>`(
          SELECT json_build_object(
                   'at', (extract(epoch FROM ${consentRecord.acceptedAt}) * 1000)::bigint,
                   'till', (extract(epoch FROM ${consentRecord.validTill}) * 1000)::bigint)
            FROM ${consentRecord}
           WHERE ${consentRecord.userId} = ${users.id}
             AND ${consentRecord.source} IN ${REGISTRATION_CONSENT_SOURCES}
           ORDER BY ${consentRecord.acceptedAt} DESC, ${consentRecord.createdAt} DESC
           LIMIT 1)`,
        // The invited address: `profile.legacy_invite_email`, else the invite's.
        inviteEmail: sql<string | null>`coalesce(
          ${users.profile} ->> 'legacy_invite_email',
          (SELECT ${registrationInvites.email} FROM ${registrationInvites}
            WHERE ${registrationInvites.jti} = ${users.inviteId}))`,
      })
      .from(users)
      .innerJoin(contact, eq(contact.id, users.contactId))
      .leftJoin(organisations, eq(organisations.id, users.orgId));
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<Coordinator | null> {
    const [row] = await this.selectJoined(db)
      .where(coordinator(eq(users.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  /** Returns the first row matching `predicate`, or `null`. */
  private async findOne(op: string, predicate: SQL): Promise<StoreResult<Coordinator | null>> {
    try {
      const [row] = await this.selectJoined().where(coordinator(predicate)).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError(op, err);
    }
  }

  /**
   * Re-reads a row just written by a single-statement update.
   * A row that vanished in between is `NOT_FOUND`.
   */
  private async reread(op: string, id: string): Promise<StoreResult<Coordinator>> {
    const found = await this.findOne(op, eq(users.id, id));
    if (!found.ok) return found;
    if (!found.value) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
    return { ok: true, value: found.value };
  }

  // ─── Error mapping ────────────────────────────────────────────────────────

  private mapWriteError(
    op: string,
    err: unknown,
    contextId: string,
    start: number,
  ): StoreResult<never> {
    // Never echo the driver message: it contains query parameters (emails, phones).
    const code = pgErrorCode(err);
    const constraint = pgConstraint(err) ?? '';
    const message = err instanceof Error ? err.message : '';

    // contactId() rejects a non-canonical phone before any SQL runs. Its
    // message is fixed and safe to return.
    if (err instanceof TypeError && message.startsWith('contactId:')) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'CHECK_VIOLATION',
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'CHECK_VIOLATION', message } };
    }

    if (code === PG_UNIQUE_VIOLATION) {
      // Match each constraint explicitly; an unknown one is plain DUPLICATE.
      let storeCode: StoreError['code'] = 'DUPLICATE';
      // The same person already has a coordinator account.
      if (constraint.includes('users_contact_type_unique')) storeCode = 'DUPLICATE_EMAIL';
      else if (constraint.includes('contact_phone')) storeCode = 'DUPLICATE_PHONE';
      else if (constraint.includes('contact_email')) storeCode = 'DUPLICATE_EMAIL';
      else if (constraint.includes('slug')) storeCode = 'DUPLICATE_SLUG';
      logger.warn({
        operation: op,
        status: 'failure',
        error: storeCode,
        constraint,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: storeCode, message: `${storeCode}: ${contextId}` } };
    }
    if (code === PG_CHECK_VIOLATION) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'CHECK_VIOLATION',
        constraint,
        latency_ms: Date.now() - start,
      });
      return {
        ok: false,
        error: { code: 'CHECK_VIOLATION', message: `${constraint || 'check_violation'}` },
      };
    }
    return this.mapReadError(op, err, start);
  }

  /**
   * Maps any other database failure to `DB_UNAVAILABLE`.
   * Logs only the SQLSTATE and error class, never the driver message.
   */
  private mapReadError(op: string, err: unknown, start?: number): StoreResult<never> {
    const code = pgErrorCode(err);
    const errorType = (err as Error | undefined)?.constructor?.name ?? 'unknown';
    logger.error({
      operation: op,
      status: 'failure',
      error: code ? `database error ${code}` : errorType,
      error_type: errorType,
      sqlstate: code,
      ...(start !== undefined ? { latency_ms: Date.now() - start } : {}),
    });
    return {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: code ? `database error ${code}` : errorType },
    };
  }
}

type JoinedRow = {
  a: typeof users.$inferSelect;
  c: typeof contact.$inferSelect;
  consent: { at: number | string; till: number | string | null } | null;
  inviteEmail: string | null;
  o: {
    slug: string;
    url: string | null;
    locations: (typeof organisations.$inferSelect)['locations'];
    legalName: string | null;
    gstNumber: string | null;
  } | null;
};

/**
 * Builds the Beckn `contact` from the `contact` row, the org's company and GST,
 * and `alternate_phone`.
 *
 * Key order is fixed (jsonb order: by length, then bytes) so responses stay byte-stable.
 */
function composeContact(
  row: JoinedRow,
  company: string | undefined,
  gstNumber: string | undefined,
): BecknContact {
  const { a, c } = row;
  return {
    name: c.name ?? '',
    email: c.email,
    phone: c.phone ?? '',
    ...(company !== undefined ? { company } : {}),
    ...(gstNumber !== undefined ? { gstNumber } : {}),
    ...(a.alternatePhone != null ? { alternatePhone: a.alternatePhone } : {}),
  };
}

/**
 * Composes the consent object from the newest ledger row (`given_at` = `accepted_at`).
 * `null` when there is no registration row or it has no `valid_till`.
 */
function composeConsent(c: JoinedRow['consent']): Coordinator['consent'] {
  if (c?.till == null) return null;
  return {
    value: true,
    given_at: new Date(Number(c.at)).toISOString(),
    valid_till: new Date(Number(c.till)).toISOString(),
  };
}

function toDomain(row: JoinedRow): Coordinator {
  const { a, o } = row;
  const details = renderOrgDetails(o, a.legacyOrgDetails);
  const composed = composeContact(row, details.company, details.gstNumber);
  return {
    id: a.id,
    orgSlug: a.signalstackOrgSlug,
    actorType: 'aggregator',
    name: a.signalstackOrgName,
    type: a.serves[0] ?? null,
    serves: a.serves,
    url: details.url,
    contactId: a.contactId,
    contact: composed,
    contactPhone: composed.phone,
    contactEmail: composed.email,
    locations: details.locations,
    consent: composeConsent(row.consent),
    profile: a.profile ?? {},
    profileRef: a.profileRef,
    status: a.status,
    createdBy: a.createdBy,
    updatedBy: a.updatedBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    signalstackOrgId: a.signalstackOrgId,
    parentOrgId: a.orgId,
    isDefaultOrg: o?.slug === DEFAULT_ORG_SLUG,
    inviteEmail: row.inviteEmail,
    inviteId: a.inviteId,
    rejectedAt: a.rejectedAt,
  };
}

/**
 * Restricts a filter to coordinator accounts.
 *
 * Every read and write of this store uses it. `users` also holds admin
 * accounts, and an admin id must never resolve as a coordinator; it gets NOT_FOUND.
 *
 * @param conds - Further conditions (undefined entries are ignored).
 * @returns The combined condition.
 */
function coordinator(...conds: (SQL | undefined)[]): SQL {
  const isCoordinator = eq(users.userType, 'coordinator');
  return and(isCoordinator, ...conds) ?? isCoordinator;
}
