/**
 * Unit tests for InMemorySignalStackWriter and SignalStackWriterFake.
 *
 * These tests exercise the in-memory implementation directly (they live in the
 * same package, so using InMemorySignalStackWriter is correct here per
 * testing.md §5). SignalStackWriterFake is exercised for the seed/dashboard
 * pinning paths because the fake adds that surface.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySignalStackWriter } from '../memory.js';
import { SignalStackWriterFake } from '../testing.js';
import type { SignalStackDashboardPage } from '../interface.js';

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// onboard()
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.onboard', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns ok with deterministic ids on first call', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'carpenter' },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_id).toBe('mem-user-1');
    expect(result.value.profile_item_id).toBe('mem-item-1');
    expect(result.value.onboarded_at).toBe(ISO_FIXED);
  });

  it('re-uses the same user when phone matches', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    const second = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha Updated',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-2',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    // Same user id, new profile id
    expect(second.value.user_id).toBe('mem-user-1');
    expect(second.value.profile_item_id).toBe('mem-item-2');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: '',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when neither email nor phone is given', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_CONFLICT when email and phone map to different users', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Priya',
      email: 'priya@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-2',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    // Attempt to onboard with phone from user-1 AND email from user-2
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Conflict',
      phoneNumber: '+919876543210',
      email: 'priya@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-3',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_CONFLICT');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when name is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: '',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when channel/source_id are missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      email: 'asha@example.com',
      channel: '' as unknown as 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('rejects an under-18 onboard with U18_NOT_ALLOWED', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Young Person',
      email: 'young@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
      age: 16,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_REQUEST');
    expect(result.error.message).toContain('U18_NOT_ALLOWED');
  });

  it('stores profiles accessible via listProfiles()', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'welder' },
    });

    expect(writer.listProfiles()).toHaveLength(1);
  });

  it('records the onboarded user in listUsers()', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    const users = writer.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]!.name).toBe('Asha');
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// upsertAggregator()
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.upsertAggregator', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('mints a new org_id on first call', async () => {
    const result = await writer.upsertAggregator({
      external_id: 'ext-1',
      name: 'Org One',
      slug: 'org-one',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.org_id).toBe('mem-org-1');
    expect(result.value.external_id).toBe('ext-1');
  });

  it('returns the same org_id on a repeated call with the same external_id', async () => {
    await writer.upsertAggregator({ external_id: 'ext-1', name: 'Org One', slug: 'org-one' });
    const second = await writer.upsertAggregator({
      external_id: 'ext-1',
      name: 'Org One Updated',
      slug: 'org-one-v2',
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.value.org_id).toBe('mem-org-1');
    expect(second.value.name).toBe('Org One Updated');
    expect(second.value.slug).toBe('org-one-v2');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when external_id is missing', async () => {
    const result = await writer.upsertAggregator({ external_id: '', name: 'Test', slug: 'test' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('records the upserted org in listAggregators()', async () => {
    await writer.upsertAggregator({ external_id: 'ext-1', name: 'Org One', slug: 'org-one' });

    const aggregators = writer.listAggregators();
    expect(aggregators).toHaveLength(1);
    expect(aggregators[0]!.external_id).toBe('ext-1');
  });
});

// ---------------------------------------------------------------------------
// probeUser() — validation branches on the in-memory impl
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.probeUser', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const result = await writer.probeUser({
      email: 'asha@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when network/domain are missing', async () => {
    const result = await writer.probeUser({
      actingOrgId: 'org-1',
      email: 'asha@example.com',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('reports an own user with no item yet (seeded without an item)', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedOwnUser({ actingOrgId: 'org-1', email: 'no-item@example.com' });

    const result = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'no-item@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_exists).toBe(true);
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.lifecycle_summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fetchDashboard() — canonical new shape (emptyDomainSlice)
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.fetchDashboard — canonical empty shape', () => {
  it('synthesises seeker and provider slices with the new rollup shape', async () => {
    const writer = new InMemorySignalStackWriter();
    const result = await writer.fetchDashboard({ actingOrgId: 'org-x' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both domains are present
    expect(result.value.by_domain['seeker']).toBeDefined();
    expect(result.value.by_domain['provider']).toBeDefined();

    // Validate new rollup shape for seeker
    const slice = result.value.by_domain['seeker']!;
    expect(Array.isArray(slice.items)).toBe(true);
    expect(slice.items).toEqual([]);
    expect(slice.rollup).toEqual({
      total_items: 0,
      complete_profiles: 0,
      has_applications: 0,
      by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
      by_initiated_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      by_received_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      total_users: 0,
      avg_items_per_user: 0,
      avg_actions_per_user: 0,
      mode_wise_counts: {},
    });
    expect(slice.total_matching).toBe(0);
    expect(slice.next_cursor).toBeNull();

    // Metadata present
    expect(result.value.metadata.last_computed_at).toBe(ISO_FIXED);
    expect(result.value.metadata.ttl_seconds).toBe(3600);
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const writer = new InMemorySignalStackWriter();
    const result = await writer.fetchDashboard({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — pinned payload via SignalStackWriterFake.seed()
// ---------------------------------------------------------------------------

describe('SignalStackWriterFake.seed — pinned dashboard', () => {
  it('returns the pinned page for the matching actingOrgId', async () => {
    const fake = new SignalStackWriterFake();

    const pinnedPage: SignalStackDashboardPage = {
      by_domain: {
        seeker: {
          rollup: {
            total_items: 10,
            complete_profiles: 7,
            has_applications: 4,
            by_status: { new: 2, active: 6, at_risk: 1, inactive: 1 },
            by_initiated_action_status: { create: 10, accept: 8, reject: 2, cancel: 0 },
            by_received_action_status: { create: 0, accept: 9, reject: 1, cancel: 0 },
            total_users: 5,
            avg_items_per_user: 2.0,
            avg_actions_per_user: 4.0,
            mode_wise_counts: { bulk: 3, link: 7 },
          },
          items: [
            {
              profile_item_id: 'p-priya',
              user_id: 'u-priya',
              name: 'Priya',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              onboarded_via: 'bulk',
              profile_status: 'new',
              profile_completion_pct: 60,
              profile_created_at: '2026-03-01T00:00:00Z',
              profile_last_updated_at: '2026-03-02T00:00:00Z',
              age_days: 10,
              initiated: { create: 1, accept: 0, reject: 0, cancel: 0 },
              received: { create: 0, accept: 0, reject: 0, cancel: 0 },
              last_initiated_at: { create: '2026-03-01T00:00:00Z' },
              last_received_at: {},
              actionable_tags: ['incomplete_profile'],
            },
          ],
          total_matching: 10,
          next_cursor: null,
        },
      },
      metadata: {
        last_computed_at: '2026-03-01T00:00:00Z',
        ttl_seconds: 3600,
        refreshed: true,
      },
    };

    fake.seed({
      dashboards: [{ acting_org_id: 'org-pinned', page: pinnedPage }],
    });

    const result = await fake.fetchDashboard({ actingOrgId: 'org-pinned' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const slice = result.value.by_domain['seeker']!;
    expect(slice.rollup.total_items).toBe(10);
    expect(slice.rollup.complete_profiles).toBe(7);
    expect(slice.rollup.has_applications).toBe(4);
    expect(slice.rollup.by_status).toEqual({ new: 2, active: 6, at_risk: 1, inactive: 1 });
    expect(slice.rollup.by_initiated_action_status).toEqual({
      create: 10,
      accept: 8,
      reject: 2,
      cancel: 0,
    });
    expect(slice.rollup.by_received_action_status).toEqual({
      create: 0,
      accept: 9,
      reject: 1,
      cancel: 0,
    });
    expect(slice.rollup.total_users).toBe(5);
    expect(slice.rollup.mode_wise_counts).toEqual({ bulk: 3, link: 7 });
    expect(slice.items).toHaveLength(1);
    expect((slice.items[0] as Record<string, unknown>)['name']).toBe('Priya');
    expect(result.value.metadata.refreshed).toBe(true);
  });

  it('falls back to the synthesised empty shape for an unregistered actingOrgId', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.fetchDashboard({ actingOrgId: 'org-not-seeded' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.by_domain['seeker']!.rollup.total_items).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exportDashboardCsv()
// ---------------------------------------------------------------------------

describe('SignalStackWriterFake.seed — pinned csv export', () => {
  it('returns the pinned csv string', async () => {
    const fake = new SignalStackWriterFake();
    const csv = 'name,status\nAsha,active\nPriya,new';
    fake.seed({ dashboardExports: [{ acting_org_id: 'org-1', csv }] });

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-1' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.csv).toBe(csv);
    expect(result.value.filename).toMatch(/^aggregator-dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('uses status in the generated filename when status filter is set', async () => {
    const fake = new SignalStackWriterFake();
    fake.seed({ dashboardExports: [{ acting_org_id: 'org-1', csv: 'name,status\nAsha,active' }] });

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-1', status: 'active' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.filename).toContain('active');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when no csv is seeded', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-no-csv' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.exportDashboardCsv({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});

describe('InMemorySignalStackWriter.fetchDecryptedProfiles', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns the seeded item_state for its own items, skips the rest', async () => {
    const onboarded = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan', phone: '+919876801011' },
    });
    expect(onboarded.success).toBe(true);
    if (!onboarded.success) return;
    const itemId = onboarded.value.profile_item_id;

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-1',
      itemIds: [itemId, 'missing-item'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toHaveLength(1);
    expect(result.value.profiles[0]!.item_id).toBe(itemId);
    expect(result.value.profiles[0]!.item_state.name).toBe('Velu Murugan');
    expect(result.value.skipped).toEqual(['missing-item']);
  });

  it('skips items owned by a different acting org', async () => {
    const onboarded = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan' },
    });
    if (!onboarded.success) return;
    const itemId = onboarded.value.profile_item_id;

    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-2', itemIds: [itemId] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toEqual([]);
    expect(result.value.skipped).toEqual([itemId]);
  });

  it('returns ValidationError on empty itemIds', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-1', itemIds: [] });
    expect(result.success).toBe(false);
  });

  it('returns ValidationError when actingOrgId is missing', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: '', itemIds: ['item-1'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('honours the fields projection (fields:[] → empty item_state) and returns the contact block', async () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      profiles: [
        {
          item_id: 'item-1',
          created_by: 'sys',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          acting_org_id: 'org-1',
          item_state: { name: 'Asha', phone: '+910000000000' },
          contact: {
            name: { value: 'Asha', source: 'item' },
            email: { value: 'asha@example.com', source: 'user' },
          },
        },
      ],
    });

    const result = await fake.fetchDecryptedProfiles({
      actingOrgId: 'org-1',
      itemIds: ['item-1'],
      fields: [],
      contact: ['name', 'email', 'phone'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const row = result.value.profiles[0]!;
    // fields:[] → item_state projected to nothing
    expect(row.item_state).toEqual({});
    // contact block present, matching the HTTP impl's shape
    expect(row.contact).toEqual({
      name: { value: 'Asha', source: 'item' },
      email: { value: 'asha@example.com', source: 'user' },
      // unseeded canonical field resolves to the "absent in both" shape
      phone: { value: null, source: null },
    });
  });

  it('projects to named fields and resolves contact:true to all three canonical fields', async () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      profiles: [
        {
          item_id: 'item-1',
          created_by: 'sys',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          acting_org_id: 'org-1',
          item_state: { name: 'Asha', phone: '+910000000000', extra: 'drop-me' },
          contact: { name: { value: 'Asha', source: 'item' } },
        },
      ],
    });

    const result = await fake.fetchDecryptedProfiles({
      actingOrgId: 'org-1',
      itemIds: ['item-1'],
      fields: ['name'], // keep only 'name' (present); phone/extra dropped
      contact: true, // → resolves all three canonical fields
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const row = result.value.profiles[0]!;
    expect(row.item_state).toEqual({ name: 'Asha' });
    expect(row.contact).toEqual({
      name: { value: 'Asha', source: 'item' },
      email: { value: null, source: null },
      phone: { value: null, source: null },
    });
  });

  it('omits the contact block when no contact projection is requested', async () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      profiles: [
        {
          item_id: 'item-1',
          created_by: 'sys',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          acting_org_id: 'org-1',
          item_state: { name: 'Asha' },
        },
      ],
    });

    const result = await fake.fetchDecryptedProfiles({ actingOrgId: 'org-1', itemIds: ['item-1'] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles[0]!.contact).toBeUndefined();
    // no fields projection → full item_state
    expect(result.value.profiles[0]!.item_state).toEqual({ name: 'Asha' });
  });
});
