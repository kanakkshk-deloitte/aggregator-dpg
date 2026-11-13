/**
 * Coordinator store contract for the api app.
 *
 * Persistence port for coordinator rows of the `users` table. Adapters:
 * Postgres for production, in-memory for tests.
 *
 * Name, email and phone live in the `contact` table, referenced by
 * `contactId`; `contact`, `contactPhone` and `contactEmail` are composed from it.
 *
 * `url`, `locations`, `contact.company` and `contact.gstNumber` are read from
 * the coordinator's org, falling back per field to `legacy_org_details`. This
 * store never writes them; the org's owner edits them.
 *
 * Consent lives only in the `consent_record` ledger. `create` writes it through
 * `recordConsent` inside its transaction; reads take the newest registration row.
 */

import type {
  ActorType,
  AggregatorStatus,
  BecknContact,
  BecknLocation,
  ConsentRecord,
  RoleType,
} from '@aggregator-dpg/shared-primitives/aggregator';
import type { RecordConsentHook } from '../consent-ledger/hook.js';

export type { RecordConsentHook };

/**
 * A coordinator's own org-detail values.
 * A key is present only where the value differs from the org's.
 */
export interface LegacyOrgDetails {
  url?: string | null;
  locations?: BecknLocation[];
  company?: string | null;
  gstNumber?: string | null;
}

export interface Coordinator {
  id: string;
  orgSlug: string;
  /** Always `'aggregator'`. */
  actorType: ActorType;
  name: string;
  /** The first domain of {@link serves}, or `null` when it serves every domain. */
  type: RoleType | null;
  /** The network domain ids the coordinator serves; `[]` = every domain. */
  serves: RoleType[];
  /** From the org, else the coordinator's own value. */
  url: string | null;
  /** FK to `contact.id`. A PII-derived hash; never log it. */
  contactId: string;
  /** Beckn contact, composed from the linked `contact` row and `alternate_phone`. */
  contact: BecknContact;
  /** The contact's phone. */
  contactPhone: string;
  /** The contact's email, lowercased. */
  contactEmail: string;
  /** From the org, else the coordinator's own value. */
  locations: BecknLocation[];
  /**
   * The newest registration consent from the ledger (`given_at` = its `accepted_at`).
   * `null` only when the ledger has no registration row for the coordinator.
   */
  consent: ConsentRecord | null;
  /**
   * Schema-driven registration fields with no column of their own. `{}` when
   * the deployment's registration schema declares no extra fields.
   */
  profile: Record<string, unknown>;
  /**
   * Which schema variant produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
   * May be NULL on older rows.
   */
  profileRef: string | null;
  status: AggregatorStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Signalstack organisation id returned by `POST /admin/aggregator/upsert`.
   * Mirrors the `signalstack_org_id` Keycloak attribute. NULL until approval
   * (or the login-time backfill) records it. Used for the `x-acting-org-id` header.
   */
  signalstackOrgId: string | null;
  /**
   * The coordinator's org (`users.org_id`), the single authority for the
   * org-coordinator link. Every coordinator has one; the type allows `null`
   * only for a store without org data.
   */
  parentOrgId: string | null;
  /** Whether {@link parentOrgId} is the fixed Default org. */
  isDefaultOrg: boolean;
  /**
   * Email the coordinator was invited at, from the invite or else
   * `profile.legacy_invite_email`. May differ from `contact.email`.
   * `null` for non-invite registrations.
   */
  inviteEmail: string | null;
  /** The invite the coordinator registered with (`registration_invites.jti`), or `null`. */
  inviteId: string | null;
  /**
   * Write-once rejection timestamp, set when a pending registration is rejected.
   * Drives the re-registration cooling window. `null` unless rejected.
   */
  rejectedAt: Date | null;
}

export interface CreateCoordinatorInput {
  orgSlug: string;
  name: string;
  /** The domain served; `null` = every domain (stored as `serves = '{}'`). */
  type: RoleType | null;
  /** `contact.company` / `contact.gstNumber` are not stored (they belong to the org). */
  contact: BecknContact;
  /**
   * The accepted consent. Only the in-memory store keeps it; Postgres reads
   * consent back from the ledger row {@link recordConsent} writes.
   */
  consent: ConsentRecord;
  /**
   * Writes the consent ledger row in the create transaction. Required, so no
   * coordinator is created without a consent record.
   */
  recordConsent: RecordConsentHook;
  createdBy: string;
  updatedBy: string;
  /** The coordinator's org (`users.org_id`). */
  orgId: string;
  /** The coordinator's own org-detail values. Set only for Default-org registrations. */
  legacyOrgDetails?: LegacyOrgDetails | null;
  /** The invite consumed by this registration (`registration_invites.jti`). */
  inviteId?: string | null;
  /**
   * Schema-driven registration fields with no column of their own. Defaults to `{}`.
   * The typed fields above take precedence.
   */
  profile?: Record<string, unknown>;
  /**
   * Which schema variant produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
   * Defaults to null when omitted.
   */
  profileRef?: string | null;
}

/**
 * Patch shape for updates.
 *
 * `orgSlug` is absent: the DB trigger `users_lock_signalstack_org_slug` rejects
 * slug changes. `id`, audit timestamps, org details and the org link are not
 * patchable here.
 */
export interface UpdateCoordinatorPatch {
  name?: string;
  type?: RoleType | null;
  /** The domains served (`[]` = every domain); wins over {@link type} when both are given. */
  serves?: RoleType[];
  /** `company` / `gstNumber` are ignored; they belong to the org. */
  contact?: BecknContact;
  status?: AggregatorStatus;
  /** Write-once rejection stamp; set only on the reject transition. */
  rejectedAt?: Date | null;
  updatedBy: string;
}

export interface ListCoordinatorsFilter {
  limit?: number;
  offset?: number;
  status?: AggregatorStatus;
  /**
   * Only rows last updated strictly before this instant.
   * Lets the stale-pending cleanup filter by age in SQL, before the row cap.
   */
  updatedBefore?: Date;
}

/** Keyset position in a {@link SearchCoordinatorsFilter} page (newest first). */
export interface CoordinatorCursor {
  createdAt: Date;
  id: string;
}

/**
 * A scoped coordinator search for the console.
 * `orgIds = null` means every org; an empty array returns no rows.
 */
export interface SearchCoordinatorsFilter {
  orgIds: string[] | null;
  status?: AggregatorStatus;
  /** A network domain id the coordinator serves (`serves = '{}'` serves every domain). */
  serves?: string;
  cursor?: CoordinatorCursor;
  /** 1..100, default 20. */
  limit?: number;
}

/** One page of a coordinator search; `nextCursor` is null on the last page. */
export interface SearchCoordinatorsPage {
  rows: Coordinator[];
  nextCursor: CoordinatorCursor | null;
}

/** Coordinator counts of one org. */
export interface OrgCoordinatorCounts {
  total: number;
  pending: number;
}

/** Outcome of {@link UserStoreBase.deleteIfPending}. */
export type DeleteIfPendingOutcome = 'deleted' | 'not_pending' | 'aborted';

export interface ListCoordinatorsPage {
  rows: Coordinator[];
  total: number;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DUPLICATE_PHONE'; message: string }
  | { code: 'DUPLICATE_EMAIL'; message: string }
  /** Unique violation on a constraint this layer does not recognise. */
  | { code: 'DUPLICATE'; message: string }
  | { code: 'CHECK_VIOLATION'; message: string }
  /** The `recordConsent` hook failed; nothing was created. */
  | { code: 'CONSENT_WRITE_FAILED'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/**
 * Abstract coordinator persistence port.
 * Every method returns `StoreResult<T>` and never throws.
 */
export abstract class UserStoreBase {
  abstract create(input: CreateCoordinatorInput): Promise<StoreResult<Coordinator>>;
  abstract findById(id: string): Promise<StoreResult<Coordinator | null>>;
  abstract findBySlug(orgSlug: string): Promise<StoreResult<Coordinator | null>>;
  abstract findByContactPhone(phone: string): Promise<StoreResult<Coordinator | null>>;
  abstract findByContactEmail(email: string): Promise<StoreResult<Coordinator | null>>;
  /**
   * Returns every coordinator whose `org_id` matches the given org id.
   *
   * @param orgId - `organisations.id`.
   * @returns The org's coordinators (possibly empty); never throws.
   */
  abstract findByParentOrgId(orgId: string): Promise<StoreResult<Coordinator[]>>;
  abstract list(filter: ListCoordinatorsFilter): Promise<StoreResult<ListCoordinatorsPage>>;
  abstract update(id: string, patch: UpdateCoordinatorPatch): Promise<StoreResult<Coordinator>>;
  abstract updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>>;
  /**
   * Atomic compare-and-set `pending` to `active`.
   *
   * Only the winner gets the row, so only it sends the applicant email.
   *
   * @param id - Coordinator UUID.
   * @param updatedBy - Audit actor.
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract approveFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator | null>>;
  /**
   * Stamps the signalstack organisation id on a coordinator row.
   *
   * Called by approval and by the login-time backfill. Idempotent.
   *
   * @param id - Coordinator UUID.
   * @param signalstackOrgId - Org id returned by the upsert call.
   * @param updatedBy - Audit field; the actor that triggered the write.
   */
  abstract updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>>;
  abstract deleteById(id: string): Promise<StoreResult<void>>;
  /**
   * Atomic compare-and-set `pending` to `inactive`, stamping a write-once `rejected_at`.
   *
   * Only the winner gets the row, so only it sends the rejection email.
   *
   * @param id - Coordinator id.
   * @param updatedBy - The deciding actor (an admin user id, or `'admin'` for a signed link).
   * @returns The rejected row, or `null` when it was not pending.
   */
  abstract rejectFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator | null>>;
  /**
   * Deletes a coordinator only while it is still `pending` and older than `cutoff`.
   *
   * The row stays locked while `beforeCommit` (the Keycloak delete) runs, so a
   * concurrent approval waits and then finds the row gone. A failed `beforeCommit` keeps the row for the next pass.
   *
   * @param id - Coordinator id.
   * @param cutoff - Only rows last updated before this instant.
   * @param beforeCommit - Runs with the row locked; `false` aborts the delete.
   * @returns `deleted`, `not_pending` (decided, fresh or gone), or `aborted`.
   */
  abstract deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<StoreResult<DeleteIfPendingOutcome>>;
  /**
   * Scoped, keyset-paged coordinator search, newest first.
   *
   * @param filter - Scope (`orgIds`), filters and cursor.
   * @returns One page; an empty scope returns no rows.
   */
  abstract search(filter: SearchCoordinatorsFilter): Promise<StoreResult<SearchCoordinatorsPage>>;
  /**
   * Coordinator counts per org.
   *
   * @param orgIds - The orgs to count (empty → empty result).
   * @returns `orgId` → counts; an org without coordinators maps to zeros.
   */
  abstract countByOrg(orgIds: string[]): Promise<StoreResult<Record<string, OrgCoordinatorCounts>>>;
}
