/**
 * Postgres organisation store, in `@aggregator-dpg/api`.
 *
 * Queries the `organisations` table. Every query is scoped to
 * `org_type = 'aggregator'` ({@link scoped}) except `findRoot`. Driver errors
 * are mapped to `OrgStoreError` codes.
 *
 * The owner is an `admin` account in `users`; its email, phone and name live
 * in `contact` and its IdP login in `user_identities`. The owner's contact and
 * account are written in the same transaction as the org row. Every write
 * re-reads the joined row in that transaction, because `RETURNING` cannot
 * include the joined owner. A database trigger releases the owner's account
 * once it owns no org.
 *
 * Every read joins the parent row and the parent's `org_known_as` row, and
 * picks the name for the org's key from that row's list, so `knownAsName` is
 * resolved with no second query.
 */

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { organisations, orgKnownAs, contact, userIdentities, users } from '../../db/schema.js';
import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import {
  SYSTEM_KNOWN_AS,
  knownAsChoices,
  type KnownAsValues,
  type KnownAsValuesRequest,
} from '@aggregator-dpg/shared-primitives/user-org';
import { defaultKnownAsKey, fillKnownAsKeys, knownAsKeyValid } from '../known-as.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, pgConstraint } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import { linkContact, type DbExecutor } from '../../db/contact-writes.js';
import {
  IdentityMismatchError,
  IdentityTakenError,
  linkAdminAccount,
  linkIdentity,
} from '../../db/account-writes.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import {
  OrganisationStoreBase,
  DEFAULT_ORG_SLUG,
  type Organisation,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
  type OrgDeleteIfPendingOutcome,
  type SearchOrgsFilter,
  type SearchOrgsPage,
  type TreeRules,
} from './interface.js';
import {
  DESCENDANT_LEVEL_CAP,
  buildTree,
  canParent,
  moveRefusal,
  newChildRefusal,
  subtree,
  type Tree,
  type TreeNode,
  type TreeRefusal,
} from './tree.js';

/** Wraps a failure of the caller's `recordConsent` hook so `create` can tell it apart. */
class ConsentHookError extends Error {
  constructor(cause: unknown) {
    super('recordConsent failed', { cause });
    this.name = 'ConsentHookError';
  }
}

/** A tree write was refused; rolls the transaction back and maps to `code`. */
class TreeRefusalError extends Error {
  constructor(
    readonly code: TreeRefusal | 'ORG_BUSY' | 'KNOWN_AS_INVALID' | 'ORG_MOVED' | 'NOT_EDITABLE',
  ) {
    super(code);
    this.name = 'TreeRefusalError';
  }
}

/** A sent "known as" key is not in the stored list; rolls the transaction back. */
class UnknownKnownAsKeyError extends Error {
  constructor(readonly index: number) {
    super('KNOWN_AS_UNKNOWN_KEY');
    this.name = 'UnknownKnownAsKeyError';
  }
}

/** SQLSTATE `lock_not_available`, raised by `FOR UPDATE NOWAIT`. */
const PG_LOCK_NOT_AVAILABLE = '55P03';

/** The parent org, joined to read its name. */
const parentOrg = alias(organisations, 'parent_org');

/** The parent's "known as" row, joined to read the name of the org's key. */
const parentKnownAs = alias(orgKnownAs, 'parent_known_as');

export class PostgresOrganisationStore extends OrganisationStoreBase {
  async create(input: CreateOrgInput, rules: TreeRules): Promise<OrgStoreResult<Organisation>> {
    const start = Date.now();
    try {
      const created = await getDb().transaction(async (tx) => {
        await lockTree(tx);
        const contactId = await linkContact(tx, {
          email: input.ownerEmail,
          phone: input.ownerPhone ?? null,
          name: input.ownerName ?? null,
        });
        const ownerUserId = await linkAdminAccount(tx, contactId);
        if (input.ownerKcSub)
          await linkIdentity(tx, ownerUserId, IDP_PROVIDER, input.ownerKcSub, 'admin');
        const parent = await resolveParent(tx, input.parentId);
        const depth = parent.depth + 1;
        const refused = newChildRefusal(
          parent.depth,
          await countLive(tx, parent.id),
          await countLive(tx),
          rules,
        );
        if (refused) throw new TreeRefusalError(refused);
        const [row] = await tx
          .insert(organisations)
          .values({
            slug: input.slug,
            name: input.displayName,
            orgType: 'aggregator',
            parentId: parent.id,
            depth,
            state: input.state ?? null,
            orgOwner: ownerUserId,
            kcGroupId: input.kcGroupId ?? null,
            locations: input.locations ?? [],
            knownAs: defaultKnownAsKey(await listOf(tx, parent.id)),
            profile: input.profile ?? {},
            profileRef: input.profileRef ?? null,
            createdBy: 'self',
            updatedBy: 'self',
          })
          .returning({ id: organisations.id });
        if (!row) throw new Error('insert returned no row');
        // The consent row commits with the org, or neither does.
        if (input.recordConsent) {
          try {
            await input.recordConsent(tx, row.id);
          } catch (hookErr: unknown) {
            throw new ConsentHookError(hookErr);
          }
        }
        return this.readIn(tx, row.id);
      });
      if (!created) return errResult('DB_UNAVAILABLE', 'org row not readable after insert');
      return { ok: true, value: created };
    } catch (e) {
      if (e instanceof TreeRefusalError) return refusal('orgStore.create', e, start);
      if (e instanceof ConsentHookError) {
        logger.error({
          operation: 'orgStore.create',
          status: 'failure',
          error: 'CONSENT_WRITE_FAILED',
          error_type: (e.cause as Error | undefined)?.name ?? 'unknown',
          latency_ms: Date.now() - start,
        });
        return errResult('CONSENT_WRITE_FAILED', 'consent could not be recorded');
      }
      return mapDbError('orgStore.create', e);
    }
  }

  async revive(
    id: string,
    parentId: string | undefined,
    rules: TreeRules,
  ): Promise<OrgStoreResult<Organisation>> {
    const start = Date.now();
    try {
      const revived = await getDb().transaction(async (tx) => {
        await lockTree(tx);
        const [org] = await tx
          .select({ status: organisations.status })
          .from(organisations)
          .where(scoped(and(eq(organisations.id, id), eq(organisations.status, 'inactive'))))
          .limit(1);
        if (!org) return null;
        const [child] = await tx
          .select({ id: organisations.id })
          .from(organisations)
          .where(eq(organisations.parentId, id))
          .limit(1);
        if (child) throw new TreeRefusalError('NOT_MOVABLE');
        const parent = await resolveParent(tx, parentId);
        const refused = newChildRefusal(
          parent.depth,
          await countLive(tx, parent.id),
          await countLive(tx),
          rules,
        );
        if (refused) throw new TreeRefusalError(refused);
        const depth = parent.depth + 1;
        await tx
          .update(organisations)
          .set({
            parentId: parent.id,
            depth,
            knownAs: defaultKnownAsKey(await listOf(tx, parent.id)),
            status: 'pending',
            rejectedAt: null,
            updatedAt: new Date(),
          })
          .where(scoped(eq(organisations.id, id)));
        return this.readIn(tx, id);
      });
      if (!revived) return errResult('NOT_FOUND', id);
      return { ok: true, value: revived };
    } catch (e) {
      if (e instanceof TreeRefusalError) return refusal('orgStore.revive', e, start);
      return mapDbError('orgStore.revive', e);
    }
  }

  async move(
    id: string,
    change: { parentId: string },
    rules: TreeRules,
  ): Promise<
    OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }>
  > {
    const start = Date.now();
    try {
      const result = await getDb().transaction(async (tx) => {
        await lockTree(tx);
        // NOWAIT: a row held by another write (the pending clean-up) answers at once.
        const [locked] = await tx
          .select({ id: organisations.id })
          .from(organisations)
          .where(eq(organisations.id, id))
          .for('update', { noWait: true });
        if (!locked) throw new TreeRefusalError('NOT_FOUND');
        const tree = await loadTree(tx);
        const refused = moveRefusal(tree, id, change.parentId, rules);
        if (refused) throw new TreeRefusalError(refused);
        const org = tree.byId.get(id)!;
        const oldParentId = org.parentId;
        if (org.parentId === change.parentId) return { oldParentId, movedCount: 0 };
        const delta = tree.byId.get(change.parentId)!.depth + 1 - org.depth;
        const [current] = await tx
          .select({ knownAs: organisations.knownAs })
          .from(organisations)
          .where(eq(organisations.id, id));
        const newList = await listOf(tx, change.parentId);
        const keep = current !== undefined && knownAsKeyValid(newList, current.knownAs);
        await tx
          .update(organisations)
          .set({
            parentId: change.parentId,
            ...(keep ? {} : { knownAs: defaultKnownAsKey(newList) }),
            updatedAt: new Date(),
          })
          .where(scoped(eq(organisations.id, id)));
        const moved = await tx.execute<{ id: string }>(sql`
          WITH RECURSIVE sub(id) AS (
            SELECT ${id}::uuid
            UNION
            SELECT o.id FROM ${organisations} o JOIN sub s ON o.parent_id = s.id)
          UPDATE ${organisations} o SET depth = o.depth + ${delta}::int
            FROM sub WHERE o.id = sub.id
          RETURNING o.id`);
        return { oldParentId, movedCount: moved.rows.length };
      });
      const org = await this.findById(id);
      if (!org.ok) return org;
      if (!org.value) return errResult('NOT_FOUND', id);
      logger.info({
        operation: 'orgStore.move',
        status: 'success',
        moved_count: result.movedCount,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: { org: org.value, ...result } };
    } catch (e) {
      if (e instanceof TreeRefusalError) return refusal('orgStore.move', e, start);
      if (pgErrorCode(e) === PG_LOCK_NOT_AVAILABLE) {
        return refusal('orgStore.move', new TreeRefusalError('ORG_BUSY'), start);
      }
      return mapDbError('orgStore.move', e);
    }
  }

  async parentOptions(
    id: string,
    rules: TreeRules,
  ): Promise<
    OrgStoreResult<{
      subtreeSize: number;
      options: Array<{ org: Organisation; ok: boolean; reason: OrgStoreError['code'] | null }>;
    }>
  > {
    try {
      // Every org, the root included: the tree is small (bounded by max_total_orgs).
      const rows = await this.selectJoined().orderBy(
        desc(eq(organisations.orgType, 'network_facilitator')),
        sql`lower(${organisations.name})`,
        asc(organisations.id),
      );
      if (!rows.some((r) => r.o.id === id && r.o.orgType === 'aggregator')) {
        return errResult('NOT_FOUND', id);
      }
      const tree = buildTree(rows.map((r) => toNode(r.o)));
      const options = rows
        .filter((r) => r.o.id !== id)
        .map((r) => {
          const reason = moveRefusal(tree, id, r.o.id, rules);
          return { org: toDomain(r), ok: reason === null, reason };
        });
      return { ok: true, value: { subtreeSize: subtree(tree, id).length, options } };
    } catch (e) {
      return mapDbError('orgStore.parentOptions', e);
    }
  }

  async childCounts(ids: readonly string[]): Promise<OrgStoreResult<Record<string, number>>> {
    const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    if (ids.length === 0) return { ok: true, value: out };
    try {
      const rows = await getDb()
        .select({ parentId: organisations.parentId, n: sql<number>`count(*)::int` })
        .from(organisations)
        .where(and(counted(), inArray(organisations.parentId, [...ids])))
        .groupBy(organisations.parentId);
      for (const r of rows) if (r.parentId !== null) out[r.parentId] = Number(r.n);
      return { ok: true, value: out };
    } catch (e) {
      return mapDbError('orgStore.childCounts', e);
    }
  }

  async countTotal(): Promise<OrgStoreResult<number>> {
    try {
      return { ok: true, value: await countLive(getDb()) };
    } catch (e) {
      return mapDbError('orgStore.countTotal', e);
    }
  }

  async findById(id: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.findOne(eq(organisations.id, id));
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.findOne(eq(organisations.slug, slug));
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<Organisation | null>> {
    const e = email.trim().toLowerCase();
    // An owner may own several orgs, so pick live first, then newest. The
    // Default org is skipped: the network admin owns it.
    return this.findOne(eq(contact.email, e), true);
  }

  async findByOwnerPhone(phone: string): Promise<OrgStoreResult<Organisation | null>> {
    // Same as findByOwnerEmail, keyed on phone.
    return this.findOne(eq(contact.phone, phone), true);
  }

  async ownerIsShared(id: string): Promise<OrgStoreResult<boolean>> {
    try {
      // Shared when the owner owns another org or also has a coordinator account.
      const rows = await getDb().execute<{ shared: boolean }>(sql`
        WITH me AS (
          SELECT o.org_owner, u.contact_id
            FROM ${organisations} o JOIN ${users} u ON u.id = o.org_owner
           WHERE o.id = ${id})
        SELECT EXISTS (
                 SELECT 1 FROM ${organisations} other, me
                  WHERE other.org_owner = me.org_owner AND other.id <> ${id})
            OR EXISTS (
                 SELECT 1 FROM ${users} c, me
                  WHERE c.contact_id = me.contact_id AND c.user_type = 'coordinator') AS shared`);
      return { ok: true, value: Boolean(rows.rows[0]?.shared) };
    } catch (e) {
      return mapDbError('orgStore.ownerIsShared', e);
    }
  }

  async listActive(): Promise<OrgStoreResult<Organisation[]>> {
    try {
      const rows = await this.selectJoined()
        .where(scoped(eq(organisations.status, 'active')))
        .orderBy(sql`lower(${organisations.name})`);
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listActive', e);
    }
  }

  async listPending(updatedBefore?: Date): Promise<OrgStoreResult<Organisation[]>> {
    try {
      const where = updatedBefore
        ? and(eq(organisations.status, 'pending'), lt(organisations.updatedAt, updatedBefore))
        : eq(organisations.status, 'pending');
      const rows = await this.selectJoined().where(scoped(where));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listPending', e);
    }
  }

  async findDefault(): Promise<OrgStoreResult<Organisation | null>> {
    return this.findOne(eq(organisations.slug, DEFAULT_ORG_SLUG));
  }

  async findRoot(): Promise<OrgStoreResult<Organisation | null>> {
    try {
      const [row] = await this.selectJoined()
        .where(eq(organisations.orgType, 'network_facilitator'))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return mapDbError('orgStore.findRoot', e);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<Organisation>> {
    // The owner's IdP login lives on the owner's account, not the org row.
    const { ownerKcSub, displayName, profileMerge, ...rest } = patch;
    const columns: Record<string, unknown> =
      displayName === undefined ? { ...rest } : { ...rest, name: displayName };
    if (profileMerge && Object.keys(profileMerge).length > 0) {
      columns['profile'] = mergedProfileSql(profileMerge);
    }
    try {
      const updated = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(organisations)
          .set({ ...columns, updatedAt: new Date() })
          .where(scoped(eq(organisations.id, id)))
          .returning({ id: organisations.id, orgOwner: organisations.orgOwner });
        const [row] = rows;
        if (!row) return null;
        // A null subject never unlinks: a recorded login is only ever added.
        if (ownerKcSub) await linkIdentity(tx, row.orgOwner, IDP_PROVIDER, ownerKcSub, 'admin');
        return this.readIn(tx, id);
      });
      if (!updated) return errResult('NOT_FOUND', id);
      return { ok: true, value: updated };
    } catch (e) {
      return mapDbError('orgStore.update', e);
    }
  }

  async setKnownAs(
    id: string,
    key: string,
    expectedParentId: string,
    updatedBy: string,
  ): Promise<OrgStoreResult<Organisation>> {
    const start = Date.now();
    try {
      const updated = await getDb().transaction(async (tx) => {
        await lockTree(tx);
        const [org] = await tx
          .select({
            parentId: organisations.parentId,
            slug: organisations.slug,
            status: organisations.status,
          })
          .from(organisations)
          .where(scoped(eq(organisations.id, id)))
          .limit(1);
        if (!org) return null;
        if (org.slug === DEFAULT_ORG_SLUG || org.status === 'inactive') {
          throw new TreeRefusalError('NOT_EDITABLE');
        }
        if (org.parentId !== expectedParentId) throw new TreeRefusalError('ORG_MOVED');
        const list = await listOf(tx, expectedParentId);
        if (!knownAsChoices(list).some((e) => e.key === key)) {
          throw new TreeRefusalError('KNOWN_AS_INVALID');
        }
        await tx
          .update(organisations)
          .set({ knownAs: key, updatedBy, updatedAt: new Date() })
          .where(scoped(eq(organisations.id, id)));
        return this.readIn(tx, id);
      });
      if (!updated) return errResult('NOT_FOUND', id);
      return { ok: true, value: updated };
    } catch (e) {
      if (e instanceof TreeRefusalError) return refusal('orgStore.setKnownAs', e, start);
      return mapDbError('orgStore.setKnownAs', e);
    }
  }

  async setKnownAsValues(
    id: string,
    requested: KnownAsValuesRequest,
    updatedBy: string,
  ): Promise<OrgStoreResult<{ org: Organisation; values: KnownAsValues; resetCount: number }>> {
    const start = Date.now();
    try {
      const result = await getDb().transaction(async (tx) => {
        await lockTree(tx);
        // Matched by id alone, not scoped(): the root has a list too.
        const [org] = await tx
          .select({ orgType: organisations.orgType, slug: organisations.slug })
          .from(organisations)
          .where(eq(organisations.id, id))
          .limit(1);
        if (!org) return null;
        if (org.orgType === 'aggregator' && org.slug === DEFAULT_ORG_SLUG) {
          throw new TreeRefusalError('NOT_EDITABLE');
        }
        const stored = await listOf(tx, id);
        const filled = fillKnownAsKeys(requested, stored);
        if (!filled.ok) throw new UnknownKnownAsKeyError(filled.error.index);
        const values = filled.value;
        await saveKnownAs(tx, id, stored, values, updatedBy);
        await tx
          .update(organisations)
          .set({ updatedBy, updatedAt: new Date() })
          .where(eq(organisations.id, id));
        // Children whose key left the list take the new default. updated_at is
        // left alone, so the pending clean-up timing does not move.
        const keep = [SYSTEM_KNOWN_AS.key, ...values.map((e) => e.key)];
        const reset = await tx
          .update(organisations)
          .set({ knownAs: defaultKnownAsKey(values) })
          .where(
            scoped(
              and(
                eq(organisations.parentId, id),
                ne(organisations.slug, DEFAULT_ORG_SLUG),
                notInArray(organisations.knownAs, keep),
              ),
            ),
          )
          .returning({ id: organisations.id });
        const [row] = await this.selectJoined(tx).where(eq(organisations.id, id)).limit(1);
        return row ? { org: toDomain(row), values, resetCount: reset.length } : null;
      });
      if (!result) return errResult('NOT_FOUND', id);
      logger.info({
        operation: 'orgStore.setKnownAsValues',
        status: 'success',
        org_id: id,
        reset_count: result.resetCount,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: result };
    } catch (e) {
      if (e instanceof TreeRefusalError) return refusal('orgStore.setKnownAsValues', e, start);
      if (e instanceof UnknownKnownAsKeyError) {
        logger.warn({
          operation: 'orgStore.setKnownAsValues',
          status: 'failure',
          error: 'KNOWN_AS_UNKNOWN_KEY',
          index: e.index,
          latency_ms: Date.now() - start,
        });
        return {
          ok: false,
          error: { code: 'KNOWN_AS_UNKNOWN_KEY', message: 'refused: unknown key', index: e.index },
        };
      }
      return mapDbError('orgStore.setKnownAsValues', e);
    }
  }

  async knownAsValues(orgId: string): Promise<OrgStoreResult<KnownAsValues>> {
    try {
      return { ok: true, value: await listOf(getDb(), orgId) };
    } catch (e) {
      return mapDbError('orgStore.knownAsValues', e);
    }
  }

  async defaultKnownAsNames(
    orgIds: readonly string[],
  ): Promise<OrgStoreResult<Record<string, string>>> {
    if (orgIds.length === 0) return { ok: true, value: {} };
    try {
      const rows = await getDb()
        .select({ orgId: orgKnownAs.orgId, values: orgKnownAs.knownAsValues })
        .from(orgKnownAs)
        .where(inArray(orgKnownAs.orgId, [...orgIds]));
      const names: Record<string, string> = {};
      for (const r of rows) {
        const entry = r.values.find((e) => e.default === true);
        if (entry) names[r.orgId] = entry.name;
      }
      return { ok: true, value: names };
    } catch (e) {
      return mapDbError('orgStore.defaultKnownAsNames', e);
    }
  }

  async countStaleKnownAs(): Promise<OrgStoreResult<number>> {
    try {
      const [row] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(organisations)
        .where(
          and(
            counted(),
            ne(organisations.knownAs, SYSTEM_KNOWN_AS.key),
            sql`NOT EXISTS (SELECT 1 FROM ${orgKnownAs} k
                             WHERE k.org_id = ${organisations.parentId}
                               AND k.known_as_values @> jsonb_build_array(
                                     jsonb_build_object('key', ${organisations.knownAs})))`,
          ),
        );
      return { ok: true, value: Number(row?.n ?? 0) };
    } catch (e) {
      return mapDbError('orgStore.countStaleKnownAs', e);
    }
  }

  async deleteById(id: string): Promise<OrgStoreResult<void>> {
    try {
      // Never the root or the Default org: they are not removable here.
      await getDb()
        .delete(organisations)
        .where(scoped(and(eq(organisations.id, id), ne(organisations.slug, DEFAULT_ORG_SLUG))));
      return { ok: true, value: undefined };
    } catch (e) {
      return mapDbError('orgStore.deleteById', e);
    }
  }

  async approve(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.casFromPending(id, 'active', updatedBy);
  }

  async reject(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.casFromPending(id, 'inactive', updatedBy);
  }

  async listOwnedBy(ownerUserId: string): Promise<OrgStoreResult<Organisation[]>> {
    try {
      const rows = await this.selectJoined()
        .where(scoped(eq(organisations.orgOwner, ownerUserId)))
        .orderBy(sql`lower(${organisations.name})`, asc(organisations.id));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listOwnedBy', e);
    }
  }

  async search(filter: SearchOrgsFilter): Promise<OrgStoreResult<SearchOrgsPage>> {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 20));
    if (filter.orgIds !== null && filter.orgIds.length === 0) {
      return { ok: true, value: { rows: [], nextCursor: null } };
    }
    const lname = sql`lower(${organisations.name})`;
    try {
      const conds: (SQL | undefined)[] = [];
      if (filter.orgIds !== null) conds.push(inArray(organisations.id, filter.orgIds));
      if (filter.status) conds.push(eq(organisations.status, filter.status));
      if (filter.descendantsOf) {
        // The walk stops after a fixed number of levels, so a cycle cannot loop.
        conds.push(sql`${organisations.id} IN (
          WITH RECURSIVE below(id, lvl) AS (
            SELECT id, 1 FROM ${organisations} WHERE parent_id = ${filter.descendantsOf}
            UNION
            SELECT o.id, b.lvl + 1 FROM ${organisations} o JOIN below b ON o.parent_id = b.id
             WHERE b.lvl < ${DESCENDANT_LEVEL_CAP})
          SELECT id FROM below)`);
      }
      if (filter.parentId) conds.push(eq(organisations.parentId, filter.parentId));
      if (filter.namePrefix) {
        // A prefix match on the name; LIKE wildcards in the input are escaped.
        const p = filter.namePrefix.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
        const pattern = `${p}%`;
        conds.push(sql`${lname} LIKE ${pattern}`);
      }
      if (filter.cursor) {
        const c = filter.cursor;
        conds.push(
          or(
            sql`${lname} > ${c.name.toLowerCase()}`,
            and(sql`${lname} = ${c.name.toLowerCase()}`, gt(organisations.id, c.id)),
          ),
        );
      }
      const rows = await this.selectJoined()
        .where(scoped(and(...conds) ?? sql`true`))
        .orderBy(lname, asc(organisations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(toDomain);
      const last = page.at(-1);
      return {
        ok: true,
        value: {
          rows: page,
          nextCursor: rows.length > limit && last ? { name: last.displayName, id: last.id } : null,
        },
      };
    } catch (e) {
      return mapDbError('orgStore.search', e);
    }
  }

  async descendantIds(ids: readonly string[]): Promise<OrgStoreResult<string[]>> {
    if (ids.length === 0) return { ok: true, value: [] };
    try {
      // The walk stops after a fixed number of levels, so a cycle cannot loop.
      const rows = await getDb().execute<{ id: string }>(sql`
        WITH RECURSIVE below(id, lvl) AS (
          SELECT o.id, 1 FROM ${organisations} o
           WHERE o.parent_id IN (${sql.join(
             ids.map((id) => sql`${id}::uuid`),
             sql`, `,
           )}) AND o.org_type = 'aggregator'
          UNION
          SELECT o.id, b.lvl + 1 FROM ${organisations} o JOIN below b ON o.parent_id = b.id
           WHERE o.org_type = 'aggregator' AND b.lvl < ${DESCENDANT_LEVEL_CAP})
        SELECT DISTINCT id FROM below`);
      const given = new Set(ids);
      return { ok: true, value: rows.rows.map((r) => r.id).filter((id) => !given.has(id)) };
    } catch (e) {
      return mapDbError('orgStore.descendantIds', e);
    }
  }

  async childIds(ids: readonly string[]): Promise<OrgStoreResult<string[]>> {
    if (ids.length === 0) return { ok: true, value: [] };
    try {
      const rows = await getDb()
        .select({ id: organisations.id })
        .from(organisations)
        .where(
          and(inArray(organisations.parentId, [...ids]), eq(organisations.orgType, 'aggregator')),
        );
      return { ok: true, value: rows.map((r) => r.id) };
    } catch (e) {
      return mapDbError('orgStore.childIds', e);
    }
  }

  async deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<OrgStoreResult<OrgDeleteIfPendingOutcome>> {
    const ABORT = Symbol('abort');
    try {
      const outcome = await getDb().transaction(async (tx) => {
        // The DELETE locks the row, so a concurrent approval waits for this transaction.
        const rows = await tx
          .delete(organisations)
          .where(
            scoped(
              and(
                eq(organisations.id, id),
                eq(organisations.status, 'pending'),
                lt(organisations.updatedAt, cutoff),
                ne(organisations.slug, DEFAULT_ORG_SLUG),
              ),
            ),
          )
          .returning({ id: organisations.id });
        if (!rows[0]) return 'not_pending' as const;
        if (!(await beforeCommit())) throw ABORT;
        return 'deleted' as const;
      });
      return { ok: true, value: outcome };
    } catch (e) {
      if (e === ABORT) return { ok: true, value: 'aborted' };
      return mapDbError('orgStore.deleteIfPending', e);
    }
  }

  private async casFromPending(
    id: string,
    next: 'active' | 'inactive',
    updatedBy: string,
  ): Promise<OrgStoreResult<Organisation | null>> {
    try {
      const [row] = await getDb()
        .update(organisations)
        // Stamp the write-once rejected_at on reject only.
        .set({
          status: next,
          updatedAt: new Date(),
          updatedBy,
          ...(next === 'inactive' ? { rejectedAt: new Date() } : {}),
        })
        .where(scoped(and(eq(organisations.id, id), eq(organisations.status, 'pending'))))
        .returning({ id: organisations.id });
      if (!row) return { ok: true, value: null };
    } catch (e) {
      return mapDbError('orgStore.casFromPending', e);
    }
    return this.findOne(eq(organisations.id, id));
  }

  /**
   * Builds the read used by every query: the org, its owner's account and
   * contact, and the owner's IdP login. The inner joins are safe because
   * `org_owner` is NOT NULL.
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({
        o: organisations,
        c: contact,
        ownerKcSub: userIdentities.subject,
        parentName: parentOrg.name,
        parentKnownAsName: sql<string | null>`(
          SELECT e->>'name' FROM jsonb_array_elements(${parentKnownAs.knownAsValues}) e
           WHERE e->>'key' = ${organisations.knownAs} LIMIT 1)`,
      })
      .from(organisations)
      .leftJoin(parentOrg, eq(parentOrg.id, organisations.parentId))
      .leftJoin(parentKnownAs, eq(parentKnownAs.orgId, organisations.parentId))
      .innerJoin(users, eq(users.id, organisations.orgOwner))
      .innerJoin(contact, eq(contact.id, users.contactId))
      .leftJoin(
        userIdentities,
        and(eq(userIdentities.userId, users.id), eq(userIdentities.provider, IDP_PROVIDER)),
      );
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<Organisation | null> {
    const [row] = await this.selectJoined(db)
      .where(scoped(eq(organisations.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  /**
   * Reads at most one org.
   *
   * @param predicate - The filter.
   * @param byOwner - When true, match admin owners only, skip the Default org,
   *   and pick live first, then newest.
   */
  private async findOne(
    predicate: SQL,
    byOwner = false,
  ): Promise<OrgStoreResult<Organisation | null>> {
    try {
      const q = this.selectJoined().where(
        scoped(
          byOwner
            ? and(predicate, eq(users.userType, 'admin'), ne(organisations.slug, DEFAULT_ORG_SLUG))!
            : predicate,
        ),
      );
      const [row] = await (byOwner
        ? q
            .orderBy(
              asc(sql`CASE WHEN ${organisations.status} IN ('pending','active') THEN 0 ELSE 1 END`),
              desc(organisations.createdAt),
            )
            .limit(1)
        : q.limit(1));
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return mapDbError('orgStore.findOne', e);
    }
  }
}

type JoinedRow = {
  o: typeof organisations.$inferSelect;
  c: typeof contact.$inferSelect;
  ownerKcSub: string | null;
  parentName: string | null;
  /** Name of the org's key in the parent's list; `null` when the list has no such entry. */
  parentKnownAsName: string | null;
};

function toDomain(row: JoinedRow): Organisation {
  const { o, c } = row;
  const isDefault = o.orgType === 'aggregator' && o.slug === DEFAULT_ORG_SLUG;
  let knownAsName: string | null = null;
  if (o.orgType !== 'network_facilitator') {
    knownAsName = isDefault
      ? SYSTEM_KNOWN_AS.name
      : (row.parentKnownAsName ?? SYSTEM_KNOWN_AS.name);
  }
  return {
    id: o.id,
    slug: o.slug,
    displayName: o.name,
    state: o.state,
    contactId: c.id,
    ownerUserId: o.orgOwner,
    ownerEmail: c.email,
    ownerPhone: c.phone,
    ownerName: c.name,
    ownerKcSub: row.ownerKcSub,
    kcGroupId: o.kcGroupId,
    profile: o.profile ?? {},
    profileRef: o.profileRef,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    updatedBy: o.updatedBy,
    rejectedAt: o.rejectedAt,
    isDefault,
    locations: (o.locations ?? []) as BecknLocation[],
    legalName: o.legalName,
    knownAs: o.knownAs,
    knownAsName,
    depth: o.depth,
    parentId: o.parentId,
    parentName: row.parentName,
    description: o.description,
  };
}

/**
 * Picks the parent for a new or revived org and locks it until the write commits.
 *
 * The lock keeps a concurrent decision from deactivating the parent first.
 *
 * @param tx - The write transaction.
 * @param requested - The requested parent id; the root when absent.
 * @returns The parent id and depth.
 * @throws {TreeRefusalError} `INVALID_PARENT` when the requested org is not the root or an active, non-Default aggregator org.
 */
async function resolveParent(
  tx: DbExecutor,
  requested: string | undefined,
): Promise<{ id: string; depth: number }> {
  if (requested === undefined) {
    const [root] = await tx
      .select({ id: organisations.id, depth: organisations.depth })
      .from(organisations)
      .where(eq(organisations.orgType, 'network_facilitator'))
      .limit(1);
    if (!root) throw new Error('network-facilitator root missing');
    return root;
  }
  const [parent] = await tx
    .select(NODE_COLUMNS)
    .from(organisations)
    .where(eq(organisations.id, requested))
    .for('share')
    .limit(1);
  if (!parent || !canParent(toNode(parent))) throw new TreeRefusalError('INVALID_PARENT');
  return parent;
}

/**
 * Takes the tree lock until the transaction ends.
 *
 * Must be the first statement of every transaction that changes the tree or its counts.
 *
 * @param tx - The write transaction.
 */
async function lockTree(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:org-tree'))`);
}

/** The columns the tree checks read. */
const NODE_COLUMNS = {
  id: organisations.id,
  parentId: organisations.parentId,
  depth: organisations.depth,
  status: organisations.status,
  orgType: organisations.orgType,
  slug: organisations.slug,
};

type NodeRow = Pick<
  typeof organisations.$inferSelect,
  'id' | 'parentId' | 'depth' | 'status' | 'orgType' | 'slug'
>;

function toNode(row: NodeRow): TreeNode {
  return {
    id: row.id,
    parentId: row.parentId,
    depth: row.depth,
    status: row.status,
    isRoot: row.orgType === 'network_facilitator',
    isDefault: row.orgType === 'aggregator' && row.slug === DEFAULT_ORG_SLUG,
  };
}

/**
 * Reads the "known as" values of an org or the root, in list order.
 *
 * @param db - Executor.
 * @param orgId - The org id.
 * @returns The list; empty when the org has no row.
 */
async function listOf(db: DbExecutor, orgId: string): Promise<KnownAsValues> {
  const [row] = await db
    .select({ values: orgKnownAs.knownAsValues })
    .from(orgKnownAs)
    .where(eq(orgKnownAs.orgId, orgId))
    .limit(1);
  return row?.values ?? [];
}

/**
 * Writes an org's `org_known_as` row: upserts the list, or deletes the row
 * when the list is empty. An unchanged list is not written, so `updated_at`
 * and `updated_by` stay. Must run in the caller's transaction, under the tree lock.
 *
 * @param tx - The write transaction.
 * @param orgId - The org id.
 * @param stored - The org's list before the change.
 * @param values - The new list, every key set.
 * @param updatedBy - The acting admin's user id.
 */
async function saveKnownAs(
  tx: DbExecutor & Pick<ReturnType<typeof getDb>, 'delete'>,
  orgId: string,
  stored: KnownAsValues,
  values: KnownAsValues,
  updatedBy: string,
): Promise<void> {
  if (values.length === 0) {
    await tx.delete(orgKnownAs).where(eq(orgKnownAs.orgId, orgId));
    return;
  }
  if (sameKnownAs(stored, values)) return;
  const now = new Date();
  await tx
    .insert(orgKnownAs)
    .values({ orgId, knownAsValues: values, updatedBy, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: orgKnownAs.orgId,
      set: { knownAsValues: values, updatedBy, updatedAt: now },
    });
}

/** Whether two lists have the same entries in the same order. */
function sameKnownAs(a: KnownAsValues, b: KnownAsValues): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.key === b[i]!.key &&
        e.name === b[i]!.name &&
        (e.default === true) === (b[i]!.default === true),
    )
  );
}

/** Reads every org, the root included, as a tree snapshot. */
async function loadTree(tx: DbExecutor): Promise<Tree> {
  const rows = await tx.select(NODE_COLUMNS).from(organisations);
  return buildTree(rows.map(toNode));
}

/** Aggregator orgs that count toward the limits: pending or active, not the Default org. */
function counted(): SQL {
  return scoped(
    and(
      inArray(organisations.status, ['pending', 'active']),
      ne(organisations.slug, DEFAULT_ORG_SLUG),
    ),
  );
}

/**
 * Counts orgs toward the limits.
 *
 * @param db - Executor.
 * @param parentId - When given, only that org's direct children.
 * @returns The count.
 */
async function countLive(db: DbExecutor, parentId?: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organisations)
    .where(
      parentId === undefined ? counted() : and(counted(), eq(organisations.parentId, parentId)),
    );
  return Number(row?.n ?? 0);
}

/**
 * SQL that merges `merge` into the stored `profile` in one statement, so a
 * concurrent edit of other keys is not lost: non-null values replace, `null`
 * removes the key, other keys are kept.
 *
 * @param merge - Keys to set or remove.
 * @returns The `profile` value for an UPDATE's SET.
 */
function mergedProfileSql(merge: Record<string, unknown>): SQL {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(merge)) {
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  // One `- key` per removed key: a JS array parameter is not a Postgres array.
  return remove.reduce<SQL>(
    (expr, key) => sql`(${expr} - ${key}::text)`,
    sql`(${organisations.profile} || ${JSON.stringify(set)}::jsonb)`,
  );
}

/**
 * Restricts a predicate to `aggregator` orgs.
 *
 * Every read and write in this store uses it, so the root is never returned or changed.
 *
 * @param predicate - The caller's filter.
 * @returns The scoped filter.
 */
function scoped(predicate: SQL | undefined): SQL {
  return and(eq(organisations.orgType, 'aggregator'), predicate)!;
}

/**
 * Maps a database failure to an `OrgStoreError` and logs it.
 *
 * Logs SQLSTATE and constraint name only, never the driver message (it holds parameters).
 *
 * @param op - Operation name for the log entry.
 * @param e - The thrown error.
 * @returns The failure result.
 */
function mapDbError(op: string, e: unknown): OrgStoreResult<never> {
  if (e instanceof IdentityTakenError || e instanceof IdentityMismatchError) {
    // The owner's IdP login conflicts with a recorded one: never overwritten.
    logger.warn({ operation: op, status: 'failure', error: 'identity_conflict', reason: e.name });
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'owner login conflict' } };
  }
  const code = pgErrorCode(e);
  const constraint = pgConstraint(e) ?? '';
  const error = classifyWriteError(e, code, constraint);
  logger.warn({
    operation: op,
    status: 'failure',
    error: error.code,
    sqlstate: code,
    constraint: constraint || undefined,
  });
  return { ok: false, error };
}

function classifyWriteError(
  e: unknown,
  code: string | undefined,
  constraint: string,
): OrgStoreError {
  // Only a unique violation (SQLSTATE 23505) maps to a duplicate error, so a
  // connection failure that mentions a constraint name is not misreported.
  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint.includes('organisations_name_live_unique')) {
      return err('DUPLICATE_NAME', 'organisation name already in use');
    }
    if (constraint.includes('organisations_slug_live_unique')) {
      return err('DUPLICATE_SLUG', 'slug already in use');
    }
    if (constraint.includes('contact_email_unique')) {
      return err('DUPLICATE_EMAIL', 'owner email already belongs to another person');
    }
    if (constraint.includes('contact_phone_unique')) {
      return err('DUPLICATE_PHONE', 'owner phone already belongs to another person');
    }
  }
  // Never echo the driver message: Drizzle includes the query parameters in it.
  return err('DB_UNAVAILABLE', code ? `database error ${code}` : (e as Error).name);
}

function err(code: OrgStoreError['code'], message: string): OrgStoreError {
  return { code, message } as OrgStoreError;
}

/** Logs and returns a refused tree write. */
function refusal<T>(op: string, e: TreeRefusalError, start: number): OrgStoreResult<T> {
  logger.warn({ operation: op, status: 'failure', error: e.code, latency_ms: Date.now() - start });
  return errResult(e.code, `refused: ${e.code}`);
}

function errResult<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: err(code, message) };
}
