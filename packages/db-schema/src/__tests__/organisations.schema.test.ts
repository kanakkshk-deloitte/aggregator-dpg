import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { organisations, orgKnownAs, orgTypeEnum, users } from '../schema.js';

describe('organisations schema (migration 0028)', () => {
  it('declares the org columns with snake_case SQL names', () => {
    expect(getTableConfig(organisations).name).toBe('organisations');
    expect(organisations.id.name).toBe('id');
    expect(organisations.slug.name).toBe('slug');
    expect(organisations.name.name).toBe('name');
    expect(organisations.orgType.name).toBe('org_type');
    expect(organisations.parentId.name).toBe('parent_id');
    expect(organisations.state.name).toBe('state');
    expect(organisations.orgOwner.name).toBe('org_owner');
    expect(organisations.url.name).toBe('url');
    expect(organisations.locations.name).toBe('locations');
    expect(organisations.legalName.name).toBe('legal_name');
    expect(organisations.gstNumber.name).toBe('gst_number');
    expect(organisations.kcGroupId.name).toBe('kc_group_id');
    expect(organisations.status.name).toBe('status');
    expect('displayName' in organisations).toBe(false);
    expect('ownerUserId' in organisations).toBe(false);
  });

  it('requires slug, name, org_type and owner; parent and details are optional', () => {
    expect(organisations.slug.notNull).toBe(true);
    expect(organisations.name.notNull).toBe(true);
    expect(organisations.orgType.notNull).toBe(true);
    expect(organisations.orgOwner.notNull).toBe(true);
    expect(organisations.parentId.notNull).toBe(false);
    expect(organisations.url.notNull).toBe(false);
    expect(organisations.locations.notNull).toBe(true);
    expect(organisations.locations.hasDefault).toBe(true);
  });

  it('declares known_as as a required column defaulting to aggregator (migration 0032)', () => {
    expect(organisations.knownAs.name).toBe('known_as');
    expect(organisations.knownAs.notNull).toBe(true);
    expect(organisations.knownAs.default).toBe('aggregator');
  });

  it('has no known_as_values column: the values live in org_known_as (migration 0034)', () => {
    expect('knownAsValues' in organisations).toBe(false);
  });

  it('declares org_known_as with one row per org (migration 0034)', () => {
    const cfg = getTableConfig(orgKnownAs);
    expect(cfg.name).toBe('org_known_as');
    expect(orgKnownAs.orgId.name).toBe('org_id');
    expect(orgKnownAs.orgId.primary).toBe(true);
    expect(orgKnownAs.knownAsValues.name).toBe('known_as_values');
    expect(orgKnownAs.knownAsValues.getSQLType()).toBe('jsonb');
    for (const col of [orgKnownAs.orgId, orgKnownAs.knownAsValues, orgKnownAs.updatedBy]) {
      expect(col.notNull).toBe(true);
    }
    expect(orgKnownAs.createdAt.hasDefault).toBe(true);
    expect(orgKnownAs.updatedAt.hasDefault).toBe(true);
    expect(orgKnownAs.updatedBy.hasDefault).toBe(false);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(cfg.foreignKeys[0]?.reference().foreignTable).toBe(organisations);
    expect(cfg.indexes).toEqual([]);
  });

  it('declares depth as a required smallint with no default (migration 0032)', () => {
    expect(organisations.depth.name).toBe('depth');
    expect(organisations.depth.notNull).toBe(true);
    expect(organisations.depth.hasDefault).toBe(false);
    expect(organisations.depth.getSQLType()).toBe('smallint');
  });

  it('has the two org types', () => {
    expect(orgTypeEnum.enumValues).toEqual(['network_facilitator', 'aggregator']);
  });

  it('no longer exports the pre-0028 aliases (Phase 4 naming commit)', async () => {
    const schema = (await import('../schema.js')) as Record<string, unknown>;
    expect(schema['aggregatorOrgs']).toBeUndefined();
    expect(schema['aggregators']).toBeUndefined();
  });

  it('owner and parent FKs are RESTRICT', () => {
    const cfg = getTableConfig(organisations);
    const owner = cfg.foreignKeys.find((f) => f.reference().columns[0] === organisations.orgOwner)!;
    expect(owner.reference().foreignTable).toBe(users);
    expect(owner.onDelete).toBe('restrict');
    const parent = cfg.foreignKeys.find(
      (f) => f.reference().columns[0] === organisations.parentId,
    )!;
    expect(parent.reference().foreignTable).toBe(organisations);
    expect(parent.onDelete).toBe('restrict');
  });

  it('declares the live-only slug and name indexes and the single-NF index', () => {
    const byName = Object.fromEntries(
      getTableConfig(organisations).indexes.map((i) => [i.config.name, i]),
    );
    expect(byName['organisations_slug_live_unique']?.config.unique).toBe(true);
    expect(byName['organisations_slug_live_unique']?.config.where).toBeDefined();
    expect(byName['organisations_name_live_unique']?.config.unique).toBe(true);
    expect(byName['organisations_single_nf']?.config.unique).toBe(true);
    expect(byName['organisations_status_idx']).toBeDefined();
    expect(byName['organisations_org_owner_idx']).toBeDefined();
    expect(byName['organisations_parent_status_idx']).toBeDefined();
  });
});

describe('users.org_id (migration 0028)', () => {
  it('is a required FK to organisations, RESTRICT on delete', () => {
    expect(users.orgId.name).toBe('org_id');
    expect(users.orgId.notNull).toBe(true);
    expect('parentOrgId' in users).toBe(false);
    const fk = getTableConfig(users).foreignKeys.find(
      (f) => f.reference().columns[0] === users.orgId,
    )!;
    expect(fk.reference().foreignTable).toBe(organisations);
    expect(fk.onDelete).toBe('restrict');
  });

  it('moves url / locations to the org and keeps legacy_org_details', () => {
    expect('url' in users).toBe(false);
    expect('locations' in users).toBe(false);
    expect(users.legacyOrgDetails.name).toBe('legacy_org_details');
    expect(users.legacyOrgDetails.notNull).toBe(false);
  });
});
