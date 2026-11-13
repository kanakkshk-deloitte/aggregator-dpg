/**
 * Organisation store contract; the system of record for orgs.
 *
 * Belongs to `@aggregator-dpg/api`. An org is a row of `organisations`; the
 * Keycloak group is a mirror this store does not read. Approval is an atomic
 * compare-and-set on status. Every method returns `OrgStoreResult<T>` and
 * never throws.
 *
 * Every method except {@link OrganisationStoreBase.findRoot} sees `aggregator`
 * orgs only, never the network-facilitator root. Owner lookups also skip the
 * Default org, which the network admin owns.
 */

import type { AggregatorStatus, BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import type {
  KnownAsValues,
  KnownAsValuesRequest,
} from '@aggregator-dpg/shared-primitives/user-org';
import type { RecordConsentHook } from '../consent-ledger/hook.js';

/** Slug of the fixed Default org, which holds coordinators with no other org. */
export const DEFAULT_ORG_SLUG = 'default';

export interface Organisation {
  id: string;
  slug: string;
  displayName: string;
  state: string | null;
  /** FK to `contact.id`, the owner's contact. PII-derived hash: never log it. */
  contactId: string;
  /** The owner's admin account (`users.id`). */
  ownerUserId: string;
  /** Owner email, lowercased, from the linked contact. */
  ownerEmail: string;
  /** Owner phone (canonical), from the linked contact. */
  ownerPhone: string | null;
  /**
   * Owner name, from the linked contact. `null` for older owners until
   * `scripts/backfill-owner-contact-names.ts` has run.
   */
  ownerName: string | null;
  ownerKcSub: string | null;
  kcGroupId: string | null;
  /**
   * Registration fields that have no column of their own. The typed columns
   * above take precedence.
   */
  profile: Record<string, unknown>;
  /** Schema variant that produced `profile`, e.g. `blue_dot/org-registration.v1`; may be null. */
  profileRef: string | null;
  status: AggregatorStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Who made the last write: an admin user id (console), `'admin'` (emailed
   * link) or `'self'`; `null` when unknown.
   */
  updatedBy: string | null;
  /** Write-once rejection time; drives the cooling window. */
  rejectedAt: Date | null;
  /** Whether this is the fixed Default org (slug {@link DEFAULT_ORG_SLUG}). */
  isDefault: boolean;
  /** Org details, shown for every coordinator of the org. */
  locations: BecknLocation[];
  legalName: string | null;
  /** Key of the org's "known as" value: a key of the parent's list, or `aggregator`. */
  knownAs: string;
  /**
   * Name of `knownAs`: the parent's value with that key ("Aggregator" for a key
   * the parent does not have, and for the Default org). `null` for the root.
   */
  knownAsName: string | null;
  /** Depth in the tree: 0 for the root, 1 for a top-level org. Set by the store on create and move. */
  depth: number;
  /** The parent org's id; the root for a top-level org, `null` for the root itself. */
  parentId: string | null;
  /** The parent org's name; `null` for the root. */
  parentName: string | null;
  /** The owner's description of the org. Informational only. */
  description: string | null;
}

/**
 * Tree limits, read from instance config by the caller. The store applies
 * them under its tree lock.
 */
export interface TreeRules {
  /** The deepest an aggregator org can be; 1 keeps every org under the root. */
  maxDepth: number;
  /** The most pending and active direct children of any org, root included; `null` is no limit. */
  maxChildren: number | null;
  /** The most pending and active aggregator orgs, root and Default excluded. */
  maxTotalOrgs: number;
}

export interface CreateOrgInput {
  slug: string;
  displayName: string;
  state?: string | null;
  ownerEmail: string;
  ownerPhone?: string | null;
  /** Owner's name as submitted; stored on the contact when it has none yet. */
  ownerName?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  profile?: Record<string, unknown>;
  profileRef?: string | null;
  /** Org locations from the registration form's address. */
  locations?: BecknLocation[];
  /**
   * Parent org id; the root when omitted. Must be the root or an active,
   * non-Default aggregator org, else `INVALID_PARENT`.
   */
  parentId?: string;
  /**
   * Writes the org's consent ledger row inside the create transaction.
   * Required, so no org is created without a consent record.
   */
  recordConsent: RecordConsentHook;
}

export interface UpdateOrgPatch {
  displayName?: string;
  state?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  status?: AggregatorStatus;
  /** Write-once rejection time; set to `null` to revive after cooling. */
  rejectedAt?: Date | null;
  /** Org details, edited from the console. */
  locations?: BecknLocation[];
  legalName?: string | null;
  description?: string | null;
  /**
   * Keys to merge into `profile`: each value replaces the stored one, `null`
   * removes the key, keys not named are kept.
   */
  profileMerge?: Record<string, unknown>;
  /** Who made this write: an admin user id, `'self'` or `'admin'`. */
  updatedBy?: string;
}

/** Keyset position in an org search page (by name, then id). */
export interface OrgCursor {
  name: string;
  id: string;
}

/**
 * A scoped org search. `orgIds = null` means every aggregator org (the
 * network admin); an empty array means none.
 */
export interface SearchOrgsFilter {
  orgIds: string[] | null;
  status?: AggregatorStatus;
  /** Case-insensitive name prefix. */
  namePrefix?: string;
  /** Only orgs below this org, at any depth (the org itself excluded). */
  descendantsOf?: string;
  /** Only the direct children of this org. */
  parentId?: string;
  cursor?: OrgCursor;
  /** 1..100, default 20. */
  limit?: number;
}

/** One page of an org search; `nextCursor` is null on the last page. */
export interface SearchOrgsPage {
  rows: Organisation[];
  nextCursor: OrgCursor | null;
}

/** Outcome of {@link OrganisationStoreBase.deleteIfPending}. */
export type OrgDeleteIfPendingOutcome = 'deleted' | 'not_pending' | 'aborted';

export type OrgStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DUPLICATE_NAME'; message: string }
  /** The owner's email already belongs to another person. */
  | { code: 'DUPLICATE_EMAIL'; message: string }
  /** The owner's phone already belongs to another person. */
  | { code: 'DUPLICATE_PHONE'; message: string }
  /** The requested parent is not the root or an active, non-Default aggregator org. */
  | { code: 'INVALID_PARENT'; message: string }
  /** The org, or the deepest org below it, would sit deeper than `maxDepth`. */
  | { code: 'DEPTH_LIMIT'; message: string }
  /** The parent already has `maxChildren` pending or active children. */
  | { code: 'CHILD_LIMIT'; message: string }
  /** The instance already holds `maxTotalOrgs` pending or active aggregator orgs. */
  | { code: 'TOTAL_LIMIT'; message: string }
  /** The new parent is the org itself or an org below it. */
  | { code: 'PARENT_CYCLE'; message: string }
  /** The org is the root, the Default org, or not pending or active. */
  | { code: 'NOT_MOVABLE'; message: string }
  /** The org row is locked by another write. */
  | { code: 'ORG_BUSY'; message: string }
  /** The "known as" key is not one of the parent's choices. */
  | { code: 'KNOWN_AS_INVALID'; message: string }
  /** The org's parent is not the one the caller checked: it was moved. */
  | { code: 'ORG_MOVED'; message: string }
  /** A sent "known as" key is not in the org's stored list; `index` is the entry. */
  | { code: 'KNOWN_AS_UNKNOWN_KEY'; message: string; index: number }
  /** The org is the Default org or a rejected org, whose "known as" values do not change. */
  | { code: 'NOT_EDITABLE'; message: string }
  /** The `recordConsent` hook failed; nothing was created. */
  | { code: 'CONSENT_WRITE_FAILED'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type OrgStoreResult<T> = { ok: true; value: T } | { ok: false; error: OrgStoreError };

/**
 * Abstract org persistence port. Concrete implementations must implement every
 * method (no partial stubs) and preserve the exact signatures.
 */
export abstract class OrganisationStoreBase {
  /**
   * Creates a pending org under its parent.
   *
   * @param input - The org, its owner and its parent.
   * The new org's `known_as` is the parent's default entry, else `aggregator`.
   *
   * @param rules - Tree limits.
   * @returns The new org; `INVALID_PARENT`, `DEPTH_LIMIT`, `CHILD_LIMIT` or `TOTAL_LIMIT` when refused.
   */
  abstract create(input: CreateOrgInput, rules: TreeRules): Promise<OrgStoreResult<Organisation>>;
  /**
   * Sets a rejected org back to `pending` under the parent of the new registration.
   *
   * Checks the parent and the limits as {@link create} does, with the org counted as new.
   * Sets `depth` from the parent. Sets `known_as` to the parent's default entry, else
   * `aggregator`, as for a new org.
   *
   * @param id - The rejected org's id.
   * @param parentId - The new parent; the root when absent.
   * @param rules - Tree limits.
   * @returns The revived org; `NOT_FOUND` when the org is not rejected, `NOT_MOVABLE` when it has
   *   child orgs, `INVALID_PARENT`, `DEPTH_LIMIT`, `CHILD_LIMIT` or `TOTAL_LIMIT` when refused.
   */
  abstract revive(
    id: string,
    parentId: string | undefined,
    rules: TreeRules,
  ): Promise<OrgStoreResult<Organisation>>;
  /**
   * Moves an org and every org below it under a new parent.
   *
   * Recomputes `depth` for the moved orgs. Moving to the current parent changes nothing.
   * The moved org keeps its `known_as` when the new parent's list has the key or the key is
   * `aggregator`; otherwise it takes the new parent's default entry, else `aggregator`. Orgs
   * below it keep theirs.
   *
   * @param id - The org to move; must be pending or active, not the root or the Default org.
   * @param change - The new parent.
   * @param rules - Tree limits.
   * @returns The moved org, its parent before the move and the number of orgs moved; `NOT_MOVABLE`,
   *   `ORG_BUSY`, `INVALID_PARENT`, `PARENT_CYCLE`, `CHILD_LIMIT` or `DEPTH_LIMIT` when refused.
   */
  abstract move(
    id: string,
    change: { parentId: string },
    rules: TreeRules,
  ): Promise<OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }>>;
  /**
   * Lists every candidate parent for a move, with the result the move would give.
   *
   * @param id - The org to move.
   * @param rules - Tree limits.
   * @returns The size of the org's subtree (the org included) and one option per candidate.
   */
  abstract parentOptions(
    id: string,
    rules: TreeRules,
  ): Promise<
    OrgStoreResult<{
      subtreeSize: number;
      options: Array<{ org: Organisation; ok: boolean; reason: OrgStoreError['code'] | null }>;
    }>
  >;
  /**
   * Counts pending and active direct children per org, Default excluded.
   *
   * @param ids - The parent org ids.
   * @returns Count per id; every given id is present.
   */
  abstract childCounts(ids: readonly string[]): Promise<OrgStoreResult<Record<string, number>>>;
  /**
   * Counts pending and active aggregator orgs, Default excluded.
   *
   * @returns The count checked against `maxTotalOrgs`.
   */
  abstract countTotal(): Promise<OrgStoreResult<number>>;
  abstract findById(id: string): Promise<OrgStoreResult<Organisation | null>>;
  abstract findBySlug(slug: string): Promise<OrgStoreResult<Organisation | null>>;
  abstract findByOwnerEmail(email: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Finds an org whose owner holds this phone.
   *
   * Used by the org-create check that keeps one phone per person; the phone
   * is the OTP login key.
   *
   * @param phone - Canonical (`normalisePhone`) phone.
   * @returns The first matching org, or `null`.
   */
  abstract findByOwnerPhone(phone: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists active aggregator orgs (the registration dropdown), Default
   * included, sorted by name (case-insensitive).
   *
   * @returns Active aggregator orgs, possibly empty.
   */
  abstract listActive(): Promise<OrgStoreResult<Organisation[]>>;
  /**
   * Finds the fixed Default org.
   *
   * @returns The Default org, or `null` when it is not seeded.
   */
  abstract findDefault(): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Finds the network-facilitator root; the only method that returns it.
   *
   * @returns The root org, or `null` when absent.
   */
  abstract findRoot(): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists `pending` orgs, optionally only those last updated before `updatedBefore`.
   *
   * Used by the stale-pending cleanup. The age filter keeps fresh rows from
   * filling the cleanup's row cap.
   *
   * @param updatedBefore - When set, only rows with `updated_at < updatedBefore`.
   * @returns Matching `pending` rows (may be empty).
   */
  abstract listPending(updatedBefore?: Date): Promise<OrgStoreResult<Organisation[]>>;
  /**
   * Updates an org's fields in one write.
   *
   * @param id - The org id.
   * @param patch - The fields to change.
   * @returns The updated org; `NOT_FOUND` when absent.
   */
  abstract update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<Organisation>>;
  /**
   * Sets an org's `known_as` to one of its parent's choices.
   *
   * Takes the tree lock first, so a move or a list edit cannot change the
   * parent or its list between the check and the write.
   *
   * @param id - The org; an aggregator org other than the Default org.
   * @param key - The new key: an entry of the parent's list, or `aggregator` when the list is empty.
   * @param expectedParentId - The parent the caller checked the actor against.
   * @param updatedBy - The acting admin's user id.
   * @returns The updated org; `NOT_FOUND`, `NOT_EDITABLE` (the Default org or a rejected org),
   *   `ORG_MOVED` (the parent is not `expectedParentId`) or `KNOWN_AS_INVALID` when refused.
   */
  abstract setKnownAs(
    id: string,
    key: string,
    expectedParentId: string,
    updatedBy: string,
  ): Promise<OrgStoreResult<Organisation>>;
  /**
   * Replaces the "known as" values an org defines for its direct children.
   *
   * Takes the tree lock first, then reads the org's stored values and fills
   * the missing keys from them (`fillKnownAsKeys`). The org's list is saved in
   * one transaction; an empty list removes it, and an unchanged list is not
   * written. In the same transaction, every child (any status, the Default
   * org excluded) whose key is neither in the new list nor `aggregator` takes
   * the new default entry, else `aggregator`. Those children keep their
   * `updated_at`. The root can be written too.
   *
   * @param id - The org, or the root.
   * @param values - The requested list; a sent key must be in the stored list.
   * @param updatedBy - The acting admin's user id.
   * @returns The updated org, the saved list and the number of children reset;
   *   `NOT_FOUND`, `NOT_EDITABLE` (the Default org) or `KNOWN_AS_UNKNOWN_KEY` when refused.
   */
  abstract setKnownAsValues(
    id: string,
    values: KnownAsValuesRequest,
    updatedBy: string,
  ): Promise<OrgStoreResult<{ org: Organisation; values: KnownAsValues; resetCount: number }>>;
  /**
   * Reads the "known as" values an org defines for its direct children.
   *
   * @param orgId - The org, or the root.
   * @returns The values in list order; empty when the org has none or does not exist.
   */
  abstract knownAsValues(orgId: string): Promise<OrgStoreResult<KnownAsValues>>;
  /**
   * Reads the name of each org's default "known as" value: the value a new child gets.
   *
   * @param orgIds - The orgs, the root allowed.
   * @returns The name per org id; an org with no default value is absent.
   */
  abstract defaultKnownAsNames(
    orgIds: readonly string[],
  ): Promise<OrgStoreResult<Record<string, string>>>;
  /**
   * Counts pending and active aggregator orgs, Default excluded, whose
   * `known_as` is neither `aggregator` nor a key of their parent's values.
   * Such orgs read as "Aggregator".
   *
   * @returns The count.
   */
  abstract countStaleKnownAs(): Promise<OrgStoreResult<number>>;
  /**
   * Hard-deletes an org row by id.
   *
   * Used by the stale-pending cleanup after the Keycloak group and owner are removed.
   *
   * @param id - The org id to delete.
   * @returns `ok` with `void`; `NOT_FOUND` is treated as success (idempotent).
   */
  abstract deleteById(id: string): Promise<OrgStoreResult<void>>;
  /**
   * Whether the org's owner is still needed elsewhere.
   *
   * True when the owner owns another org or also has a coordinator account.
   * A shared owner keeps their IdP user when this org is deleted.
   *
   * @param id - Org UUID.
   * @returns `true` inside `ok` when the owner is shared.
   */
  abstract ownerIsShared(id: string): Promise<OrgStoreResult<boolean>>;
  /**
   * Moves the org from pending to active with an atomic compare-and-set.
   *
   * @param id - The org id.
   * @param updatedBy - The decider, written in the same statement (`'admin'`
   *   for an emailed link, else the admin's user id).
   * @returns The updated row, or `null` when the row was not pending (another decision won).
   */
  abstract approve(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Moves the org from pending to inactive (rejected) with an atomic compare-and-set.
   *
   * @param id - The org id.
   * @param updatedBy - The decider (see {@link approve}).
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract reject(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists the aggregator orgs (Default included) an admin account owns.
   *
   * @param ownerUserId - The admin `users.id`.
   * @returns The owned orgs, by name; empty when none.
   */
  abstract listOwnedBy(ownerUserId: string): Promise<OrgStoreResult<Organisation[]>>;
  /**
   * Searches aggregator orgs by name, scoped and keyset-paged.
   *
   * @param filter - Scope (`orgIds`), filters and cursor.
   * @returns One page; an empty scope returns no rows.
   */
  abstract search(filter: SearchOrgsFilter): Promise<OrgStoreResult<SearchOrgsPage>>;
  /**
   * Ids of every aggregator org below the given orgs, at any depth, any status.
   *
   * @param ids - The orgs to look below; an empty list returns none.
   * @returns The descendant ids, without the given ids themselves.
   */
  abstract descendantIds(ids: readonly string[]): Promise<OrgStoreResult<string[]>>;
  /**
   * Ids of the aggregator orgs directly below the given orgs, any status.
   *
   * @param ids - The parent org ids; an empty list returns none.
   * @returns The child ids.
   */
  abstract childIds(ids: readonly string[]): Promise<OrgStoreResult<string[]>>;
  /**
   * Deletes an org only while it is still `pending` and older than `cutoff`.
   *
   * The row stays locked until `beforeCommit` (the Keycloak clean-up) has run,
   * so a concurrent approval waits and then finds the row gone.
   *
   * @param id - Org id.
   * @param cutoff - Only rows last updated before this instant.
   * @param beforeCommit - Runs with the row locked; `false` aborts the delete.
   * @returns `deleted`, `not_pending` (decided, fresh or gone), or `aborted`.
   */
  abstract deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<OrgStoreResult<OrgDeleteIfPendingOutcome>>;
}
