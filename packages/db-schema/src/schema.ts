/**
 * Drizzle table definitions for the aggregator database, in the db-schema package.
 *
 * Main tables:
 *   - `contact`: one row per person (name, email, phone), keyed by the
 *     `contactId()` hash of `lower(email):phone`. Other rows reference it by
 *     `contact_id`.
 *   - `users`: one row per account. A `coordinator` row holds a coordinator's
 *     registration, its Signals org, the domains it serves, its org and its
 *     status. An `admin` row is an org owner's identity only. Consent lives
 *     only in `consent_record`.
 *   - `organisations`: the network-facilitator root, the Default org and every
 *     aggregator org.
 *   - `bulk_uploads`: one row per CSV upload, with its status. Counters and
 *     per-row state are in Redis during the run; afterwards counters are in
 *     `onboarding` and row errors in `errors.csv` on S3.
 *
 * Keycloak keeps its own copy of a user's email, phone and name, plus
 * `decision_made`. The `contact` table is the application's copy. The two
 * are not synced after registration.
 *
 * CHECK constraints, the `contact` cleanup trigger, the slug immutability
 * triggers and the `consent_record` append-only trigger are defined in the
 * migrations, not here.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  smallint,
  boolean,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';

export type {
  BecknContact,
  BecknLocation,
  ConsentRecord,
} from '@aggregator-dpg/shared-primitives/aggregator';

/**
 * A coordinator's own org-detail values that differ from its org's.
 *
 * A key is present only where the values differ. `null` or `[]` records an
 * empty own value.
 */
export interface LegacyOrgDetails {
  url?: string | null;
  locations?: BecknLocation[];
  company?: string | null;
  gstNumber?: string | null;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

/**
 * Account role. `coordinator` is a coordinator account; `admin` is an org owner's identity.
 */
export const userTypeEnum = pgEnum('user_type', ['admin', 'coordinator']);

// Domain ids (participant types) are plain `text`, not an enum. The
// application validates them against the network's `domainIds`.

/** Registration status of a coordinator or an org. */
export const registrationStatusEnum = pgEnum('registration_status', [
  'pending',
  'active',
  'inactive',
  'retired',
]);

export const bulkUploadStatusEnum = pgEnum('bulk_upload_status', [
  'pending',
  'uploaded',
  'file_validating',
  'file_failed',
  'row_processing',
  'finalising',
  'completed',
  'failed',
]);

export const registrationLinkStatusEnum = pgEnum('registration_link_status', [
  'draft',
  'live',
  'retired',
]);

export const linkSubmissionOutcomeEnum = pgEnum('link_submission_outcome', [
  'passed',
  'skipped',
  'failed',
]);

export const onboardingSourceEnum = pgEnum('onboarding_source', ['bulk', 'link']);

/**
 * Status of a coordinator invite.
 *
 * `pending` is the only live state. `consumed`, `revoked` and `expired` are
 * final. At most one pending invite exists per (org, email).
 */
export const registrationInviteStatusEnum = pgEnum('registration_invite_status', [
  'pending',
  'consumed',
  'revoked',
  'expired',
]);

// ─── Campaign async jobs ─────────────────────────────────────────────────────
// Job model shared by every campaign channel. A request becomes one
// `campaign_job` row plus one `campaign_job_item` row per target item. The
// worker writes each item's final status. The job status is derived from item
// counts, not stored as a counter.

/**
 * Overall status of a campaign job, derived from its item statuses.
 *
 * `queued` until the worker picks it up, then `processing`, then one of:
 * `completed` (no failures), `partial` (some failures), `failed` (nothing succeeded).
 */
export const campaignJobStatusEnum = pgEnum('campaign_job_status', [
  'queued',
  'processing',
  'partial',
  'completed',
  'failed',
]);

/**
 * Status of a single campaign job item.
 *
 * Open: `pending`.
 * Success: `resolved` (export data fetched), `submitted` (voice call sent,
 * outcome not yet known), `sent` (email delivered).
 * Skipped, not counted as failures: `skipped_not_owned` (org does not own the
 * item), `skipped_no_contact` (no address or number), `duplicate_active`
 * (same item and action already in progress).
 * Error: `failed`.
 */
export const campaignJobItemStatusEnum = pgEnum('campaign_job_item_status', [
  'pending',
  'resolved',
  'submitted',
  'sent',
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
  'failed',
]);

/** Which campaign channel a job belongs to; picks the worker handler. */
export const campaignChannelEnum = pgEnum('campaign_channel', ['export', 'email', 'voice']);

/**
 * Which phase of a campaign this audit row records; the result is in `campaignAuditOutcomeEnum`.
 *
 * A campaign writes `requested` then `completed` with the same correlation
 * id.
 */
export const campaignAuditEventEnum = pgEnum('campaign_audit_event', ['requested', 'completed']);

/**
 * The audited action. `dump` is no longer written (the dump route is gone) but
 * stays so existing audit rows remain valid.
 */
export const campaignAuditChannelEnum = pgEnum('campaign_audit_channel', [
  'export',
  'email',
  'voice',
  'dump',
]);

/** Result of a completed action. NULL on `requested` rows. */
export const campaignAuditOutcomeEnum = pgEnum('campaign_audit_outcome', [
  'succeeded',
  'partial',
  'failed',
]);

// ─── contact ─────────────────────────────────────────────────────────────────
// One row per person: name, email and phone.
// `id` is the sha256 hex of `lower(email):phone` (`contactId()` in
// `@aggregator-dpg/shared-primitives/contact`, `contact_id_of()` in SQL). It is
// derived from PII, so never log it. Every FK to it is `contact_id` with
// `ON UPDATE CASCADE`, because changing the email or phone changes the id.

export const contact = pgTable(
  'contact',
  {
    id: text('id').primaryKey(),
    /** Lowercased, trimmed. Unique across every role. */
    email: text('email').notNull(),
    /** Canonical `normalisePhone` form, or NULL. Unique across every role. */
    phone: text('phone'),
    /** NULL when never captured. */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contact_email_unique').on(table.email),
    uniqueIndex('contact_phone_unique')
      .on(table.phone)
      .where(sql`phone IS NOT NULL`),
  ],
);

// ─── users ───────────────────────────────────────────────────────────────────
// One row per account. A `coordinator` row holds the coordinator's
// registration and its own Signals org (`signalstack_org_*`). An `admin` row
// (an org owner) is identity only; its coordinator-only columns are NULL
// (`users_role_shape_chk`).
//
// The TypeScript types below describe coordinator rows. Admin rows are written
// only by `db/account-writes.ts` and read through narrow column selects.
//
// Migrations are hand-written SQL in apps/api/drizzle/migrations. Do not run
// `drizzle-kit generate` on this file: coordinator-only columns are typed
// `.notNull()` here but are nullable in the database.

export const users = pgTable(
  'users',
  {
    // Identity
    id: uuid('id').primaryKey().defaultRandom(),
    /** Account role. */
    userType: userTypeEnum('user_type').notNull(),
    /** The coordinator's Signals org slug, also the `[org]` segment of public links. Immutable. */
    signalstackOrgSlug: text('signalstack_org_slug')
      .notNull()
      .unique('users_signalstack_org_slug_unique'),
    /** The coordinator's Signals org name. */
    signalstackOrgName: text('signalstack_org_name').notNull(),
    // Domain ids the coordinator serves, e.g. `{seeker}`. Empty means every
    // domain. `'{}'` for admin accounts.
    serves: text('serves')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // The person behind this account.
    contactId: text('contact_id')
      .notNull()
      .references((): typeof contact.id => contact.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    // Optional Beckn contact `alternatePhone`. Not an identity field, so not on `contact`.
    alternatePhone: text('alternate_phone'),

    // The coordinator's own `url` and `locations` where they differ from its
    // org's. Shown when the org's field is empty.
    legacyOrgDetails: jsonb('legacy_org_details').$type<LegacyOrgDetails>(),

    // Schema-driven registration fields that have no column of their own. A
    // value never lives both here and in a typed column. New schema fields
    // land here, so they need no migration.
    profile: jsonb('profile')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The schema that produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
    // Needed to read `profile` later. NULL on older rows.
    profileRef: text('profile_ref'),

    // Lifecycle
    status: registrationStatusEnum('status').notNull().default('pending'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Signals org id returned by POST /admin/aggregator/upsert. Copy of the
    // `signalstack_org_id` Keycloak attribute, so the worker and public-link
    // path can set `x-acting-org-id` without calling Keycloak. NULL until
    // approval or login records it.
    signalstackOrgId: text('signalstack_org_id'),

    // The coordinator's org. Coordinators with no other org belong to the
    // Default org. NULL for admin accounts; their orgs are found by
    // `organisations.org_owner`.
    orgId: uuid('org_id')
      .notNull()
      .references((): AnyPgColumn => organisations.id, { onDelete: 'restrict' }),

    // The invite the coordinator registered with. The invited address may
    // differ from the contact email. An invited address with no matching
    // invite row is kept in `profile.legacy_invite_email`.
    inviteId: uuid('invite_id').references((): AnyPgColumn => registrationInvites.jti, {
      onDelete: 'set null',
    }),

    // Set once when a pending registration is rejected, never changed after.
    // Used for the re-registration waiting period. NULL unless rejected.
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  },
  (table) => [
    // Email and phone uniqueness is enforced on `contact`.
    // Approval queue filter.
    index('users_status_idx').on(table.status),
    // One account per person per role.
    uniqueIndex('users_contact_type_unique').on(table.contactId, table.userType),
    index('users_org_idx').on(table.orgId),
    index('users_invite_idx')
      .on(table.inviteId)
      .where(sql`invite_id IS NOT NULL`),
  ],
);

// ─── user_identities ─────────────────────────────────────────────────────────
// Login identities per account: one per provider per account, and one account
// per external login. `provider` is currently 'keycloak'.

export const userIdentities = pgTable(
  'user_identities',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'user_identities_pkey', columns: [table.userId, table.provider] }),
    unique('user_identities_provider_subject_unique').on(table.provider, table.subject),
  ],
);

// ─── organisations ───────────────────────────────────────────────────────────
// Exactly one `network_facilitator` org (the root, `parent_id` NULL). Every
// other org is an `aggregator` under it, including the Default org
// (`slug = 'default'`). Status `inactive` means rejected.

export const orgTypeEnum = pgEnum('org_type', ['network_facilitator', 'aggregator']);

export const organisations = pgTable(
  'organisations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Immutable for aggregator orgs (it names the Keycloak group); the NF slug follows config. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Immutable (`organisations_lock`). */
    orgType: orgTypeEnum('org_type').notNull(),
    /** NULL only for the network facilitator. */
    parentId: uuid('parent_id').references((): AnyPgColumn => organisations.id, {
      onDelete: 'restrict',
    }),
    // Same value as in `locations`, kept as plain text.
    state: text('state'),
    // The owner's `admin` account in `users`, shared by every org it owns.
    orgOwner: uuid('org_owner')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    kcGroupId: text('kc_group_id'),
    // Org details, shown for every coordinator of the org. `url` and
    // `gst_number` are no longer written: their values live in `profile`.
    url: text('url'),
    locations: jsonb('locations')
      .$type<BecknLocation[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    legalName: text('legal_name'),
    gstNumber: text('gst_number'),
    /** Key of the org's "known as" value: from the parent's list, or `aggregator`. */
    knownAs: text('known_as').notNull().default('aggregator'),
    /** Depth in the tree: root 0, top-level 1. Set by the store (migration 0032). */
    depth: smallint('depth').notNull(),
    // Written by the org owner in the console. Informational only.
    description: text('description'),
    // Fields of the org-registration schema (website, GST number, domains and
    // any a deployment adds). Also holds `address` and `coordinates`, which are
    // copied into `locations`.
    profile: jsonb('profile')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Which schema variant produced `profile`, e.g. `blue_dot/org-registration.v1`. */
    profileRef: text('profile_ref'),
    status: registrationStatusEnum('status').notNull().default('pending'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Set once on rejection, like `users.rejected_at`.
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  },
  (table) => [
    index('organisations_status_idx').on(table.status),
    index('organisations_org_owner_idx').on(table.orgOwner),
    index('organisations_parent_status_idx').on(table.parentId, table.status),
    // Slug is unique among pending and active orgs. Generated slugs have a random suffix.
    uniqueIndex('organisations_slug_live_unique')
      .on(table.slug)
      .where(sql`status IN ('pending','active')`),
    // Aggregator org names are unique (case-insensitive) among pending and active orgs.
    uniqueIndex('organisations_name_live_unique')
      .on(sql`lower(${table.name})`)
      .where(sql`org_type = 'aggregator' AND status IN ('pending','active')`),
    uniqueIndex('organisations_single_nf')
      .on(table.orgType)
      .where(sql`org_type = 'network_facilitator'`),
  ],
);

// ─── org_known_as ────────────────────────────────────────────────────────────
// The "known as" values an org defines for its direct children, one row per
// org (migration 0034). A child's `organisations.known_as` holds a key of its
// parent's list, or `aggregator`. An org with an empty list has no row.

export const orgKnownAs = pgTable('org_known_as', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  /**
   * The list as the API serves it, in display order. The API checks the
   * entries on every write; the table checks only the array shape and the
   * cap of 20 entries.
   */
  knownAsValues: jsonb('known_as_values').$type<KnownAsValues>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** The acting admin's user id. */
  updatedBy: text('updated_by').notNull(),
});

// ─── registration_invites ────────────────────────────────────────────────────
// Coordinator invites. The row makes an invite single-use, revocable and
// traceable, since the invitee has no Keycloak user yet. The invite JWT's
// `sub` is this row's `jti`.

export const registrationInvites = pgTable(
  'registration_invites',
  {
    jti: uuid('jti').primaryKey().defaultRandom(),
    /** Currently always `coordinator`. */
    role: text('role').notNull().default('coordinator'),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Lowercased and trimmed. Must match the submitted email. */
    email: text('email').notNull(),
    status: registrationInviteStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Subject of the owner or admin who created the invite. Used for audit. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('registration_invites_org_idx').on(table.orgId),
    // One pending invite per (org, email). Finished invites do not block a new one.
    uniqueIndex('registration_invites_pending_unique')
      .on(table.orgId, table.email)
      .where(sql`status = 'pending'`),
  ],
);

export type RegistrationInviteRow = typeof registrationInvites.$inferSelect;
export type NewRegistrationInviteRow = typeof registrationInvites.$inferInsert;

// ─── bulk_uploads ────────────────────────────────────────────────────────────

export const bulkUploads = pgTable(
  'bulk_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The user's org at insert time. Set by the `*_set_org_id` BEFORE INSERT
    // trigger; inserts never pass it.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' })
      .$defaultFn(() => sql`NULL`),
    // A domain id of the active network. The application validates it.
    participantType: text('participant_type').notNull(),
    s3Key: text('s3_key').notNull(),
    // ETag read on upload confirmation (POST /:id/start). NULL while pending.
    s3Etag: text('s3_etag'),
    status: bulkUploadStatusEnum('status').notNull().default('pending'),
    statusReason: text('status_reason'),
    errorsCsvS3Key: text('errors_csv_s3_key'),
    schemaId: text('schema_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // Watchdog scan for stalled uploads.
    index('bulk_uploads_status_progress_idx').on(table.status, table.lastProgressAt),
    // Per-user concurrency cap and tenant queries.
    index('bulk_uploads_user_status_idx').on(table.userId, table.status),
  ],
);

// ─── registration_links ──────────────────────────────────────────────────────

export const registrationLinks = pgTable(
  'registration_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The user's org at insert time. Set by the `*_set_org_id` BEFORE INSERT
    // trigger; inserts never pass it.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' })
      .$defaultFn(() => sql`NULL`),
    slug: text('slug').notNull(),
    domain: text('domain').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    registrationMode: text('registration_mode').notNull().default('form'),
    // Not written. QR codes are generated client-side. Kept for reading old rows.
    qrObjectKey: text('qr_object_key'),
    status: registrationLinkStatusEnum('status').notNull().default('draft'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Slug is unique per user; the public URL is `/<org_slug>/<slug>`.
    uniqueIndex('registration_links_user_slug_unique').on(table.userId, table.slug),
    index('registration_links_user_status_idx').on(table.userId, table.status),
  ],
);

// ─── link_submissions ────────────────────────────────────────────────────────

export const linkSubmissions = pgTable(
  'link_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => registrationLinks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The user's org at insert time. Set by the `*_set_org_id` BEFORE INSERT
    // trigger; inserts never pass it.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' })
      .$defaultFn(() => sql`NULL`),
    metadataSnapshot: jsonb('metadata_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    submittedData: jsonb('submitted_data').$type<Record<string, unknown>>().notNull().default({}),
    outcome: linkSubmissionOutcomeEnum('outcome').notNull(),
    rolledUpAt: timestamp('rolled_up_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Rollup pickup of rows not yet rolled up.
    index('link_submissions_rollup_pickup_idx').on(table.rolledUpAt, table.createdAt),
    index('link_submissions_link_idx').on(table.linkId),
    index('link_submissions_user_created_idx').on(table.userId, table.createdAt),
  ],
);

// ─── consent_record ──────────────────────────────────────────────────────────
// Append-only ledger of consent acceptances, and the only store of consent.
// One row per acceptance, with both document versions. `subject_type` +
// `subject_id` is the permanent audit key. `user_id` / `org_id` become NULL
// when the subject is deleted; the row stays. The `consent_record_append_only`
// trigger blocks every DELETE and any other UPDATE.

export const consentRecord = pgTable(
  'consent_record',
  {
    /** Surrogate primary key; generated randomly by Postgres. */
    id: uuid('id').primaryKey().defaultRandom(),

    /** Discriminator for the subject: `'user'` = `users.id`; `'organisation'` = `organisations.id`. */
    subjectType: text('subject_type').notNull(),

    /** The id of the subject that accepted the terms (kept after the subject is deleted). */
    subjectId: uuid('subject_id').notNull(),

    /** The consenting user while it exists (`subject_type = 'user'`). */
    userId: uuid('user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),

    /** The consenting organisation while it exists (`subject_type = 'organisation'`). */
    orgId: uuid('org_id').references((): AnyPgColumn => organisations.id, {
      onDelete: 'set null',
    }),

    /** Version of the Terms of Service document accepted (= config `current_version`). */
    termsVersion: integer('terms_version').notNull(),

    /** Version of the Privacy Policy document accepted (= config `current_version`). */
    privacyVersion: integer('privacy_version').notNull(),

    /** Signal Stack network identifier the registration is under (e.g. `blue_dot`). */
    network: text('network').notNull(),

    /** Per-brand variant, or NULL when the registration is under the network default. */
    brand: text('brand'),

    /**
     * How consent was captured.
     *
     * `'registration'`, `'registration-backfill'`, or `` `bulk_upload:<id>:v<n>` ``.
     */
    source: text('source').notNull(),

    /** Server-stamped moment the registrant accepted. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),

    /** Until when the registration consent is valid; NULL when not recorded. */
    validTill: timestamp('valid_till', { withTimezone: true }),

    /** Row-creation timestamp; set automatically by Postgres on INSERT. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('consent_record_subject_idx').on(table.subjectType, table.subjectId),
    index('consent_record_user_idx')
      .on(table.userId, table.acceptedAt.desc())
      .where(sql`user_id IS NOT NULL`),
    index('consent_record_org_idx')
      .on(table.orgId)
      .where(sql`org_id IS NOT NULL`),
  ],
);

// ─── onboarding (unified metrics rollup) ─────────────────────────────────────

export const onboarding = pgTable(
  'onboarding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The user's org at insert time. Set by the `*_set_org_id` BEFORE INSERT
    // trigger; inserts never pass it.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' })
      .$defaultFn(() => sql`NULL`),
    signalstackOrgSlug: text('signalstack_org_slug').notNull(),
    source: onboardingSourceEnum('source').notNull(),
    // For source='bulk': bulk_uploads.id. For source='link': NULL.
    batchId: uuid('batch_id'),
    // For source='link': registration_links.id. For source='bulk': NULL.
    linkId: uuid('link_id').references(() => registrationLinks.id, { onDelete: 'set null' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    total: integer('total').notNull(),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Bulk: one row per upload.
    uniqueIndex('onboarding_bulk_batch_unique')
      .on(table.batchId)
      .where(sql`${table.source} = 'bulk'`),
    // Link: one row per (user, link, period). Upsert target for hourly rollups.
    uniqueIndex('onboarding_link_rollup_unique')
      .on(table.userId, table.linkId, table.periodStart)
      .where(sql`${table.source} = 'link'`),
    index('onboarding_user_source_idx').on(table.userId, table.source, table.periodStart),
    index('onboarding_batch_idx').on(table.batchId),
  ],
);

// ─── campaign_job / campaign_job_item ────────────────────────────────────────

/**
 * One free-form campaign metadata pair, e.g. `{key:'purpose', value:'audit'}`.
 *
 * The request's `metadata` list is stored on the job unchanged.
 */
export interface CampaignMetadataPair {
  key: string;
  value: string;
}

export const campaignJob = pgTable(
  'campaign_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The user's org at insert time. Set by the `*_set_org_id` BEFORE INSERT
    // trigger; inserts never pass it.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' })
      .$defaultFn(() => sql`NULL`),
    // The token's `signalstack_org_id` claim. Every read, list and cap query filters on it.
    signalstackOrgId: text('signalstack_org_id').notNull(),
    channel: campaignChannelEnum('channel').notNull(),
    status: campaignJobStatusEnum('status').notNull().default('queued'),
    // A repeated `Idempotency-Key` returns the original job. NULL when not sent.
    idempotencyKey: text('idempotency_key'),
    // The request's `metadata` list, unchanged.
    metadata: jsonb('metadata')
      .$type<CampaignMetadataPair[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-channel `content` block (empty `{}` for export).
    content: jsonb('content')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The requesting user's token email. Not used for authorisation.
    requestedBy: text('requested_by').notNull(),
    // Inbound `x-request-id`, forwarded downstream for tracing.
    requestId: text('request_id'),
    errorReason: text('error_reason'),
    // Updated after each processing chunk. The watchdog fails jobs where it is stale.
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Stamped when the job reaches a terminal status.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Set once the job's notification, such as the export download email, is sent.
     *
     * A retry must not send it again, or the recipient gets a second link to the same PII.
     */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    // Voice only: raw provider responses from create and start.
    providerResponse: jsonb('provider_response'),
  },
  (table) => [
    // Idempotency key is unique per org, so keys from different orgs cannot collide.
    uniqueIndex('campaign_job_idempotency_key_unique')
      .on(table.signalstackOrgId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // Per-org listing (newest first) and active-job cap.
    index('campaign_job_org_status_idx').on(table.signalstackOrgId, table.status, table.createdAt),
    // Watchdog scan for stalled processing jobs.
    index('campaign_job_status_progress_idx').on(table.status, table.lastProgressAt),
  ],
);

export const campaignJobItem = pgTable(
  'campaign_job_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => campaignJob.id, { onDelete: 'cascade' }),
    // Copy of the job's channel, so item queries need no join. Set at insert.
    channel: campaignChannelEnum('channel').notNull(),
    itemId: uuid('item_id').notNull(),
    // The action applied to the item (email, voice). NULL for export, which
    // excludes exports from the active dedup index below.
    action: text('action'),
    status: campaignJobItemStatusEnum('status').notNull().default('pending'),
    // Provider ids used to match a later outcome to this row (voice: Raya call
    // id, batch id and last polled status; email: message id).
    providerRef: text('provider_ref'),
    rayaBatchId: text('raya_batch_id'),
    lastProviderStatus: text('last_provider_status'),
    // Why the item skipped or failed, and how many handler attempts it took.
    skipReason: text('skip_reason'),
    errorReason: text('error_reason'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Stamped when the item reaches a terminal status.
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // Status counts and item listing.
    index('campaign_job_item_job_status_idx').on(table.jobId, table.status),
    // One row per item per job, so a retried insert is a no-op.
    uniqueIndex('campaign_job_item_job_item_unique').on(table.jobId, table.itemId),
    // The same (item, action) cannot be `pending`, `resolved` or `submitted` in
    // two jobs at once. Rows with no action (exports) are not deduplicated.
    uniqueIndex('campaign_job_item_active_dedup')
      .on(table.itemId, table.action)
      .where(sql`status IN ('pending','resolved','submitted') AND action IS NOT NULL`),
  ],
);

/**
 * Append-only audit of every campaign action that releases data.
 *
 * Kept separate from `campaign_job` and `campaign_job_item`, which can change
 * and be cleaned up. Joined by `correlation_id = campaign_job.id`.
 *
 * Never store a participant PII value here; only field names and counts. The
 * only identities stored are operators. Status and list GET routes are not
 * audited.
 */
export const campaignPiiAudit = pgTable(
  'campaign_pii_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The `campaign_job.id`.
    correlationId: uuid('correlation_id').notNull(),
    event: campaignAuditEventEnum('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // ── Who ────────────────────────────────────────────────────────────────
    actorUserId: text('actor_user_id'),
    // NULL only on historical `dump` rows.
    actorSignalstackOrgId: text('actor_signalstack_org_id'),
    actorAzp: text('actor_azp'),
    // Export-link recipient. An operator address, never a participant's.
    recipientRef: text('recipient_ref'),

    // ── What ───────────────────────────────────────────────────────────────
    channel: campaignAuditChannelEnum('channel').notNull(),
    // PII field names, never values. An empty array means no PII field was
    // released; NULL means unknown.
    piiFields: text('pii_fields').array(),
    itemCount: integer('item_count'),

    // ── When ───────────────────────────────────────────────────────────────
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // ── Where ──────────────────────────────────────────────────────────────
    destination: text('destination'),
    network: text('network'),
    instance: text('instance'),
    requestIp: text('request_ip'),

    // ── Why ────────────────────────────────────────────────────────────────
    purpose: text('purpose'),
    // Not used yet.
    consentRef: text('consent_ref'),

    // ── How ────────────────────────────────────────────────────────────────
    endpoint: text('endpoint'),
    traceId: text('trace_id'),
    outcome: campaignAuditOutcomeEnum('outcome'),
    errorCode: text('error_code'),

    // ── How many ───────────────────────────────────────────────────────────
    requestedCount: integer('requested_count'),
    resolvedCount: integer('resolved_count'),
    skippedCount: integer('skipped_count'),
    failedCount: integer('failed_count'),
    sentCount: integer('sent_count'),

    // Non-PII extras.
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('campaign_pii_audit_org_created_idx').on(table.actorSignalstackOrgId, table.createdAt),
    index('campaign_pii_audit_correlation_idx').on(table.correlationId),
    index('campaign_pii_audit_channel_created_idx').on(table.channel, table.createdAt),
  ],
);

// ─── Inferred row types ──────────────────────────────────────────────────────

export type ContactRow = typeof contact.$inferSelect;
export type NewContactRow = typeof contact.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type OrganisationRow = typeof organisations.$inferSelect;
export type NewOrganisationRow = typeof organisations.$inferInsert;
export type BulkUploadRow = typeof bulkUploads.$inferSelect;
export type NewBulkUploadRow = typeof bulkUploads.$inferInsert;
export type RegistrationLinkRow = typeof registrationLinks.$inferSelect;
export type NewRegistrationLinkRow = typeof registrationLinks.$inferInsert;
export type LinkSubmissionRow = typeof linkSubmissions.$inferSelect;
export type NewLinkSubmissionRow = typeof linkSubmissions.$inferInsert;
export type OnboardingRow = typeof onboarding.$inferSelect;
export type NewOnboardingRow = typeof onboarding.$inferInsert;
export type CampaignJob = typeof campaignJob.$inferSelect;
export type NewCampaignJob = typeof campaignJob.$inferInsert;
export type CampaignJobItem = typeof campaignJobItem.$inferSelect;
export type NewCampaignJobItem = typeof campaignJobItem.$inferInsert;

/**
 * Inferred select type for a `consent_record` row.
 */
export type ConsentRecordRow = typeof consentRecord.$inferSelect;

/** Inferred insert type for `consent_record`. `id` and `created_at` have DB defaults. */
export type NewConsentRecordRow = typeof consentRecord.$inferInsert;

// ─── RBAC ────────────────────────────────────────────────────────────────────
// Permissions are grouped into roles. `user_role` holds the extra roles a user
// has in an org; base roles follow membership and are not stored. `iam_audit`
// is append-only (trigger).

export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description').notNull(),
  sensitive: boolean('sensitive').notNull().default(false),
  deprecated: boolean('deprecated').notNull().default(false),
});

export const role = pgTable(
  'role',
  {
    key: text('key').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    accountType: userTypeEnum('account_type').notNull(),
    baseFor: text('base_for'),
    assignableOrgTypes: orgTypeEnum('assignable_org_types').array().notNull(),
    assignedBy: text('assigned_by').references(() => permission.key, { onDelete: 'restrict' }),
    maxDays: integer('max_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('role_base_for_unique')
      .on(table.baseFor)
      .where(sql`base_for IS NOT NULL`),
  ],
);

export const rolePermission = pgTable(
  'role_permission',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => role.key, { onDelete: 'cascade', onUpdate: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permission.key, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.roleKey, table.permissionKey] })],
);

export const userRole = pgTable(
  'user_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: text('role_key')
      .notNull()
      .references(() => role.key, { onDelete: 'restrict', onUpdate: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('user_role_live_unique')
      .on(table.userId, table.roleKey, table.orgId)
      .where(sql`revoked_at IS NULL`),
    index('user_role_user_idx').on(table.userId),
    index('user_role_org_idx').on(table.orgId),
  ],
);

export const iamAudit = pgTable(
  'iam_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    event: text('event').notNull(),
    actorUserId: uuid('actor_user_id'),
    targetUserId: uuid('target_user_id'),
    targetOrgId: uuid('target_org_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [index('iam_audit_at_idx').on(table.at)],
);

export type UserRoleRow = typeof userRole.$inferSelect;
export type IamAuditRow = typeof iamAudit.$inferSelect;
