/**
 * Index, unique-constraint, and foreign-key regression tests for every
 * `pgTable` in `schema.ts`.
 *
 * Drizzle's `pgTable(name, columns, (table) => ({...}))` third argument
 * (the index/constraint builder) and a column's `.references(() => other.id)`
 * callback are both stored lazily and only invoked when something calls
 * `getTableConfig()` (or drizzle-kit's migration generator does, in
 * production). Merely importing `schema.ts` executes the columns and enums
 * but never runs those callback bodies — which is exactly why
 * `schema.ts`'s function coverage was ~8% despite every table "loading"
 * fine. Calling `getTableConfig(table)` here — and, for foreign keys,
 * calling `.reference()` on the result — both exercises those callback
 * bodies for coverage *and* asserts real facts a future refactor could
 * break: index names/columns/uniqueness, partial-index predicates, and
 * which table+column a foreign key actually points at.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  contact,
  users,
  userIdentities,
  organisations,
  bulkUploads,
  registrationLinks,
  linkSubmissions,
  consentRecord,
  onboarding,
  campaignJob,
} from '../schema.js';

/** Extracts the SQL column name for an index-column entry that is a plain column (not a SQL expression like `lower(x)`). */
function colName(entry: unknown): string | undefined {
  return typeof entry === 'object' && entry !== null && 'name' in entry
    ? (entry as { name?: string }).name
    : undefined;
}

describe('aggregators: indexes + foreign key', () => {
  const cfg = getTableConfig(users);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('users');
  });

  it('has the status filter index and the contact_id index (uniqueness lives on contact)', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['users_status_idx'].config.unique).toBe(false);
    expect(byName['users_status_idx'].config.columns.map(colName)).toEqual(['status']);

    expect(byName['users_actor_type_idx']).toBeUndefined(); // dropped with actor_type (0029)

    expect(byName['users_contact_type_unique'].config.unique).toBe(true);
    expect(byName['users_contact_type_unique'].config.columns.map(colName)).toEqual([
      'contact_id',
      'user_type',
    ]);

    expect(byName['users_invite_idx'].config.columns.map(colName)).toEqual(['invite_id']); // 0029
    expect(cfg.indexes).toHaveLength(4);
  });

  it('contact_id FK points at contact.id — RESTRICT on delete, CASCADE on update (re-key)', () => {
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0] === users.contactId)!;
    expect(fk.reference().foreignTable).toBe(contact);
    expect(fk.reference().foreignColumns[0]).toBe(contact.id);
    expect(fk.onDelete).toBe('restrict');
    expect(fk.onUpdate).toBe('cascade');
  });

  it('org_id FK points at organisations.id — RESTRICT on delete', () => {
    expect(cfg.foreignKeys).toHaveLength(3);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0] === users.orgId)!;
    expect(fk.reference().foreignTable).toBe(organisations);
    expect(fk.reference().foreignColumns[0]).toBe(organisations.id);
    expect(fk.onDelete).toBe('restrict');
  });

  it('invite_id FK points at registration_invites.jti — SET NULL on delete (0029)', () => {
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0] === users.inviteId)!;
    expect(fk.reference().foreignColumns[0]!.name).toBe('jti');
    expect(fk.onDelete).toBe('set null');
  });
});

describe('bulk_uploads: indexes + foreign key', () => {
  const cfg = getTableConfig(bulkUploads);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('bulk_uploads');
  });

  it('has the watchdog and per-aggregator-cap composite indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['bulk_uploads_status_progress_idx'].config.columns.map(colName)).toEqual([
      'status',
      'last_progress_at',
    ]);
    expect(byName['bulk_uploads_user_status_idx'].config.columns.map(colName)).toEqual([
      'user_id',
      'status',
    ]);
    expect(cfg.indexes).toHaveLength(2);
  });

  it('aggregator_id FK cascades on delete of the parent aggregator', () => {
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(bulkUploads.userId);
    expect(ref.foreignTable).toBe(users);
    expect(ref.foreignColumns[0]).toBe(users.id);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('registration_links: indexes + foreign key', () => {
  const cfg = getTableConfig(registrationLinks);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('registration_links');
  });

  it('slug uniqueness is scoped per aggregator (two users may share a slug)', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'registration_links_user_slug_unique');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['user_id', 'slug']);
  });

  it('has a non-unique status filter index', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'registration_links_user_status_idx');
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.columns.map(colName)).toEqual(['user_id', 'status']);
    expect(cfg.indexes).toHaveLength(2);
  });

  it('aggregator_id FK cascades on delete of the parent aggregator', () => {
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(registrationLinks.userId);
    expect(ref.foreignTable).toBe(users);
    expect(ref.foreignColumns[0]).toBe(users.id);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('link_submissions: indexes + foreign keys', () => {
  const cfg = getTableConfig(linkSubmissions);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('link_submissions');
  });

  it('has the metrics-rollup pickup index and per-link/per-aggregator indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['link_submissions_rollup_pickup_idx'].config.columns.map(colName)).toEqual([
      'rolled_up_at',
      'created_at',
    ]);
    expect(byName['link_submissions_link_idx'].config.columns.map(colName)).toEqual(['link_id']);
    expect(byName['link_submissions_user_created_idx'].config.columns.map(colName)).toEqual([
      'user_id',
      'created_at',
    ]);
    expect(cfg.indexes).toHaveLength(3);
  });

  it('foreign keys: link + aggregator (cascade), org (restrict)', () => {
    expect(cfg.foreignKeys).toHaveLength(3);
    const byColumn = new Map(cfg.foreignKeys.map((fk) => [fk.reference().columns[0], fk]));

    const linkFk = byColumn.get(linkSubmissions.linkId);
    const linkRef = linkFk?.reference();
    expect(linkRef?.foreignTable).toBe(registrationLinks);
    expect(linkRef?.foreignColumns[0]).toBe(registrationLinks.id);
    expect(linkFk?.onDelete).toBe('cascade');

    const aggregatorFk = byColumn.get(linkSubmissions.userId);
    const aggregatorRef = aggregatorFk?.reference();
    expect(aggregatorRef?.foreignTable).toBe(users);
    expect(aggregatorRef?.foreignColumns[0]).toBe(users.id);
    expect(aggregatorFk?.onDelete).toBe('cascade');
  });
});

describe('consent_record: indexes and links', () => {
  const cfg = getTableConfig(consentRecord);

  it('is consent_record with typed links that never delete the row (ON DELETE SET NULL)', () => {
    expect(cfg.name).toBe('consent_record');
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) expect(fk.onDelete).toBe('set null');
  });

  it('has the audit-key index and the two partial link indexes', () => {
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'consent_record_org_idx',
      'consent_record_subject_idx',
      'consent_record_user_idx',
    ]);
    const idx = cfg.indexes.find((i) => i.config.name === 'consent_record_subject_idx')!;
    expect(idx.config.unique).toBe(false);
    expect(idx.config.columns.map(colName)).toEqual(['subject_type', 'subject_id']);
  });
});

describe('onboarding: indexes + foreign keys', () => {
  const cfg = getTableConfig(onboarding);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('onboarding');
  });

  it('bulk rows are unique per batch_id, scoped to source=bulk', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'onboarding_bulk_batch_unique');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['batch_id']);
    expect(idx?.config.where).toBeDefined();
  });

  it('link rows are unique per (aggregator, link, period_start), scoped to source=link', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'onboarding_link_rollup_unique');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['user_id', 'link_id', 'period_start']);
    expect(idx?.config.where).toBeDefined();
  });

  it('has the non-unique aggregator-source-period and batch lookup indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['onboarding_user_source_idx'].config.columns.map(colName)).toEqual([
      'user_id',
      'source',
      'period_start',
    ]);
    expect(byName['onboarding_batch_idx'].config.unique).toBe(false);
    expect(byName['onboarding_batch_idx'].config.columns.map(colName)).toEqual(['batch_id']);
    expect(cfg.indexes).toHaveLength(4);
  });

  it('foreign keys: aggregator (cascade), link (set null), org (restrict)', () => {
    expect(cfg.foreignKeys).toHaveLength(3);
    const byColumn = new Map(cfg.foreignKeys.map((fk) => [fk.reference().columns[0], fk]));

    const aggregatorFk = byColumn.get(onboarding.userId);
    const aggregatorRef = aggregatorFk?.reference();
    expect(aggregatorRef?.foreignTable).toBe(users);
    expect(aggregatorRef?.foreignColumns[0]).toBe(users.id);
    expect(aggregatorFk?.onDelete).toBe('cascade');

    const linkFk = byColumn.get(onboarding.linkId);
    const linkRef = linkFk?.reference();
    expect(linkRef?.foreignTable).toBe(registrationLinks);
    expect(linkRef?.foreignColumns[0]).toBe(registrationLinks.id);
    expect(linkFk?.onDelete).toBe('set null');
  });
});

describe('contact: indexes (migration 0025)', () => {
  const cfg = getTableConfig(contact);

  it('table name is contact with a text primary key', () => {
    expect(cfg.name).toBe('contact');
    expect(contact.id.primary).toBe(true);
    expect(contact.id.columnType).toBe('PgText');
  });

  it('email is unique; phone is partial-unique over non-null values', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['contact_email_unique'].config.unique).toBe(true);
    expect(byName['contact_email_unique'].config.columns.map(colName)).toEqual(['email']);
    expect(byName['contact_phone_unique'].config.unique).toBe(true);
    expect(byName['contact_phone_unique'].config.columns.map(colName)).toEqual(['phone']);
    expect(byName['contact_phone_unique'].config.where).toBeDefined();
    expect(cfg.indexes).toHaveLength(2);
  });

  it('nullable phone and name, required email', () => {
    expect(contact.email.notNull).toBe(true);
    expect(contact.phone.notNull).toBe(false);
    expect(contact.name.notNull).toBe(false);
  });
});

describe('user_identities (migration 0027)', () => {
  it('is keyed by (user_id, provider) and unique per (provider, subject)', () => {
    const cfg = getTableConfig(userIdentities);
    expect(cfg.name).toBe('user_identities');
    expect(cfg.primaryKeys[0]?.columns.map(colName)).toEqual(['user_id', 'provider']);
    expect(cfg.uniqueConstraints[0]?.columns.map(colName)).toEqual(['provider', 'subject']);
    const fk = cfg.foreignKeys[0]!;
    expect(fk.reference().foreignTable).toBe(users);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('tenant tables: org_id (migration 0028)', () => {
  it.each([
    ['bulk_uploads', bulkUploads],
    ['registration_links', registrationLinks],
    ['link_submissions', linkSubmissions],
    ['onboarding', onboarding],
    ['campaign_job', campaignJob],
  ] as const)(
    '%s.org_id is a required RESTRICT FK to organisations, optional on insert',
    (_name, table) => {
      expect(table.orgId.name).toBe('org_id');
      expect(table.orgId.notNull).toBe(true);
      // Filled by the BEFORE INSERT trigger: inserts may omit it.
      expect(table.orgId.hasDefault).toBe(true);
      const fk = getTableConfig(table).foreignKeys.find(
        (f) => f.reference().columns[0] === table.orgId,
      )!;
      expect(fk.reference().foreignTable).toBe(organisations);
      expect(fk.onDelete).toBe('restrict');
    },
  );
});
