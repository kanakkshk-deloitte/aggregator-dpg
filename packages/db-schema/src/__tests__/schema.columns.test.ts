/**
 * Column-shape regression tests for every `pgTable` in `schema.ts` that
 * isn't already covered by `aggregator-orgs.schema.test.ts` or
 * `schema.test.ts`.
 *
 * There is no business logic in a Drizzle table definition to exercise —
 * the meaningful assertion is that each exported column keeps its expected
 * SQL name, nullability, default-presence, primary-key/generated-column
 * status, and Postgres column type. If someone renames a column, flips a
 * `.notNull()`, or removes a `.generatedAlwaysAs()`, these tests fail
 * instead of silently drifting from the migrations that were generated
 * from this file.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import {
  users,
  organisations,
  bulkUploads,
  registrationLinks,
  linkSubmissions,
  consentRecord,
  onboarding,
} from '../schema.js';

describe('users columns', () => {
  it('identity + lifecycle columns', () => {
    expect(users.id.name).toBe('id');
    expect(users.id.primary).toBe(true);
    expect(users.id.hasDefault).toBe(true);
    expect(users.id.columnType).toBe('PgUUID');

    expect(users.signalstackOrgSlug.name).toBe('signalstack_org_slug');
    expect(users.signalstackOrgSlug.notNull).toBe(true);
    expect(users.signalstackOrgSlug.isUnique).toBe(true);

    expect(users.signalstackOrgName.name).toBe('signalstack_org_name');
    expect(users.signalstackOrgName.notNull).toBe(true);

    // `serves` (0029, was `type`): the domain ids served; '{}' = every domain.
    expect(users.serves.name).toBe('serves');
    expect(users.serves.notNull).toBe(true);
    expect(users.serves.hasDefault).toBe(true);
    expect('type' in users).toBe(false);
    expect('actorType' in users).toBe(false);

    expect(users.status.name).toBe('status');
    expect(users.status.notNull).toBe(true);
    expect(users.status.hasDefault).toBe(true);

    expect(users.createdBy.name).toBe('created_by');
    expect(users.createdBy.notNull).toBe(true);
    expect(users.updatedBy.name).toBe('updated_by');
    expect(users.updatedBy.notNull).toBe(true);

    expect(users.createdAt.name).toBe('created_at');
    expect(users.createdAt.notNull).toBe(true);
    expect(users.createdAt.hasDefault).toBe(true);
    expect(users.updatedAt.name).toBe('updated_at');
    expect(users.updatedAt.notNull).toBe(true);
    expect(users.updatedAt.hasDefault).toBe(true);

    expect(users.signalstackOrgId.name).toBe('signalstack_org_id');
    expect(users.signalstackOrgId.notNull).toBe(false);
  });

  it('contact FK (0025) + alternate_phone (0029, was contact_extra)', () => {
    expect(users.contactId.name).toBe('contact_id');
    expect(users.contactId.notNull).toBe(true);
    expect(users.alternatePhone.name).toBe('alternate_phone');
    expect(users.alternatePhone.notNull).toBe(false);
    expect('contactExtra' in users).toBe(false);
  });

  it('the legacy Beckn contact jsonb and generated lookup columns are gone (0026)', () => {
    expect('contact' in users).toBe(false);
    expect('contactPhone' in users).toBe(false);
    expect('contactEmail' in users).toBe(false);
  });

  it('consent lives only in consent_record; invite_id replaces invite_email (0029)', () => {
    expect('consent' in users).toBe(false);
    expect('inviteEmail' in users).toBe(false);
    expect(users.inviteId.name).toBe('invite_id');
    expect(users.inviteId.notNull).toBe(false);
  });
});

describe('organisations remaining columns (not covered by organisations.schema.test.ts)', () => {
  it('id is a defaulted primary key', () => {
    expect(organisations.id.name).toBe('id');
    expect(organisations.id.primary).toBe(true);
    expect(organisations.id.hasDefault).toBe(true);
  });
});

describe('bulk_uploads columns', () => {
  it('lifecycle + counters', () => {
    expect(bulkUploads.id.primary).toBe(true);
    expect(bulkUploads.userId.name).toBe('user_id');
    expect(bulkUploads.userId.notNull).toBe(true);

    expect(bulkUploads.participantType.name).toBe('participant_type');
    expect(bulkUploads.participantType.notNull).toBe(true);

    expect(bulkUploads.s3Key.name).toBe('s3_key');
    expect(bulkUploads.s3Key.notNull).toBe(true);
    // ETag is NULL while status='pending' — cannot be notNull.
    expect(bulkUploads.s3Etag.name).toBe('s3_etag');
    expect(bulkUploads.s3Etag.notNull).toBe(false);

    expect(bulkUploads.status.name).toBe('status');
    expect(bulkUploads.status.notNull).toBe(true);
    expect(bulkUploads.status.hasDefault).toBe(true);

    expect(bulkUploads.schemaId.name).toBe('schema_id');
    expect(bulkUploads.schemaId.notNull).toBe(true);
    expect(bulkUploads.schemaVersion.name).toBe('schema_version');
    expect(bulkUploads.schemaVersion.notNull).toBe(true);

    expect(bulkUploads.uploadedBy.name).toBe('uploaded_by');
    expect(bulkUploads.uploadedBy.notNull).toBe(true);

    expect(bulkUploads.lastProgressAt.name).toBe('last_progress_at');
    expect(bulkUploads.lastProgressAt.notNull).toBe(false);
    expect(bulkUploads.completedAt.name).toBe('completed_at');
    expect(bulkUploads.completedAt.notNull).toBe(false);
  });
});

describe('registration_links remaining columns', () => {
  it('domain/context/status/expiry/audit columns', () => {
    expect(registrationLinks.userId.name).toBe('user_id');
    expect(registrationLinks.userId.notNull).toBe(true);

    expect(registrationLinks.slug.name).toBe('slug');
    expect(registrationLinks.slug.notNull).toBe(true);

    expect(registrationLinks.domain.name).toBe('domain');
    expect(registrationLinks.domain.notNull).toBe(true);

    expect(registrationLinks.context.name).toBe('context');
    expect(registrationLinks.context.notNull).toBe(true);
    expect(registrationLinks.context.hasDefault).toBe(true);

    expect(registrationLinks.qrObjectKey.name).toBe('qr_object_key');
    expect(registrationLinks.qrObjectKey.notNull).toBe(false);

    expect(registrationLinks.status.name).toBe('status');
    expect(registrationLinks.status.notNull).toBe(true);
    expect(registrationLinks.status.hasDefault).toBe(true);

    expect(registrationLinks.expiresAt.name).toBe('expires_at');
    expect(registrationLinks.expiresAt.notNull).toBe(false);

    expect(registrationLinks.createdBy.name).toBe('created_by');
    expect(registrationLinks.createdBy.notNull).toBe(true);
  });
});

describe('link_submissions columns', () => {
  it('outcome + snapshot payload columns', () => {
    expect(linkSubmissions.linkId.name).toBe('link_id');
    expect(linkSubmissions.linkId.notNull).toBe(true);

    expect(linkSubmissions.userId.name).toBe('user_id');
    expect(linkSubmissions.userId.notNull).toBe(true);

    expect(linkSubmissions.metadataSnapshot.name).toBe('metadata_snapshot');
    expect(linkSubmissions.metadataSnapshot.notNull).toBe(true);
    expect(linkSubmissions.metadataSnapshot.hasDefault).toBe(true);

    expect(linkSubmissions.submittedData.name).toBe('submitted_data');
    expect(linkSubmissions.submittedData.notNull).toBe(true);
    expect(linkSubmissions.submittedData.hasDefault).toBe(true);

    expect(linkSubmissions.outcome.name).toBe('outcome');
    expect(linkSubmissions.outcome.notNull).toBe(true);
    expect(linkSubmissions.outcome.hasDefault).toBe(false);
    expect(linkSubmissions.outcome.columnType).toBe('PgEnumColumn');

    expect(linkSubmissions.rolledUpAt.name).toBe('rolled_up_at');
    expect(linkSubmissions.rolledUpAt.notNull).toBe(false);
  });
});

describe('consent_record columns', () => {
  it('polymorphic subject + versioned consent columns', () => {
    expect(consentRecord.id.primary).toBe(true);

    expect(consentRecord.subjectType.name).toBe('subject_type');
    expect(consentRecord.subjectType.notNull).toBe(true);

    expect(consentRecord.subjectId.name).toBe('subject_id');
    expect(consentRecord.subjectId.notNull).toBe(true);

    expect(consentRecord.termsVersion.name).toBe('terms_version');
    expect(consentRecord.termsVersion.notNull).toBe(true);
    expect(consentRecord.termsVersion.columnType).toBe('PgInteger');

    expect(consentRecord.privacyVersion.name).toBe('privacy_version');
    expect(consentRecord.privacyVersion.notNull).toBe(true);

    expect(consentRecord.network.name).toBe('network');
    expect(consentRecord.network.notNull).toBe(true);

    // Nullable — the network-default registration has no brand override.
    expect(consentRecord.brand.name).toBe('brand');
    expect(consentRecord.brand.notNull).toBe(false);

    expect(consentRecord.source.name).toBe('source');
    expect(consentRecord.source.notNull).toBe(true);

    // Server-stamped at accept time — no DB default, the app supplies it.
    expect(consentRecord.acceptedAt.name).toBe('accepted_at');
    expect(consentRecord.acceptedAt.notNull).toBe(true);
    expect(consentRecord.acceptedAt.hasDefault).toBe(false);

    // Typed links (0029): NULL once the subject is deleted.
    expect(consentRecord.userId.name).toBe('user_id');
    expect(consentRecord.userId.notNull).toBe(false);
    expect(consentRecord.orgId.name).toBe('org_id');
    expect(consentRecord.orgId.notNull).toBe(false);
    expect(consentRecord.validTill.name).toBe('valid_till');
    expect(consentRecord.validTill.notNull).toBe(false);

    expect(consentRecord.createdAt.name).toBe('created_at');
    expect(consentRecord.createdAt.hasDefault).toBe(true);
  });
});

describe('onboarding columns', () => {
  it('period window + rollup counters', () => {
    expect(onboarding.userId.name).toBe('user_id');
    expect(onboarding.userId.notNull).toBe(true);

    expect(onboarding.signalstackOrgSlug.name).toBe('signalstack_org_slug'); // renamed in 0029
    expect(onboarding.signalstackOrgSlug.notNull).toBe(true);

    expect(onboarding.source.name).toBe('source');
    expect(onboarding.source.notNull).toBe(true);
    expect(onboarding.source.columnType).toBe('PgEnumColumn');

    // batch_id / link_id are mutually exclusive by source (bulk vs link);
    // both nullable at the column level, enforced by partial unique indexes.
    expect(onboarding.batchId.name).toBe('batch_id');
    expect(onboarding.batchId.notNull).toBe(false);
    expect(onboarding.linkId.name).toBe('link_id');
    expect(onboarding.linkId.notNull).toBe(false);

    expect(onboarding.periodStart.name).toBe('period_start');
    expect(onboarding.periodStart.notNull).toBe(true);
    expect(onboarding.periodEnd.name).toBe('period_end');
    expect(onboarding.periodEnd.notNull).toBe(true);

    expect(onboarding.total.name).toBe('total');
    expect(onboarding.total.notNull).toBe(true);
    expect(onboarding.total.hasDefault).toBe(false);
    expect(onboarding.total.columnType).toBe('PgInteger');

    expect(onboarding.passed.name).toBe('passed');
    expect(onboarding.passed.notNull).toBe(true);
    expect(onboarding.passed.hasDefault).toBe(true);

    expect(onboarding.failed.name).toBe('failed');
    expect(onboarding.failed.notNull).toBe(true);
    expect(onboarding.failed.hasDefault).toBe(true);

    expect(onboarding.skipped.name).toBe('skipped');
    expect(onboarding.skipped.notNull).toBe(true);
    expect(onboarding.skipped.hasDefault).toBe(true);
  });
});
