/**
 * Unit tests for the SignalStackWriterFake `seed()` user/aggregator paths and
 * the `buildDecryptedProfileRow` test-data builder.
 *
 * The `seed()` profile/dashboard/dashboardExport paths are already exercised
 * by memory.test.ts (they back the dashboard-pinning suites there); this file
 * focuses on the `users` and `aggregators` seed arrays plus the standalone
 * builder, which no other test file touches.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect } from 'vitest';
import { SignalStackWriterFake, buildDecryptedProfileRow } from '../testing.js';

describe('SignalStackWriterFake.seed — users', () => {
  it('seeds a user with an explicit id', () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      users: [{ id: 'user-abc', name: 'Asha', email: 'asha@example.com', role: 'user' }],
    });

    const users = fake.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'user-abc',
      name: 'Asha',
      email: 'asha@example.com',
      phoneNumber: null,
      role: 'user',
    });
  });

  it('mints a sequential seed-user-N id when none is given', () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      users: [{ name: 'Asha' }, { name: 'Priya' }],
    });

    const users = fake.listUsers();
    expect(users.map((u) => u.id)).toEqual(['seed-user-1', 'seed-user-2']);
    expect(users[0]!.email).toBeNull();
    expect(users[0]!.phoneNumber).toBeNull();
    expect(users[0]!.role).toBe('user');
  });

  it('re-seeding the same id overwrites the previous row', () => {
    const fake = new SignalStackWriterFake();
    fake.seed({ users: [{ id: 'user-1', name: 'Asha' }] });
    fake.seed({ users: [{ id: 'user-1', name: 'Asha Updated' }] });

    const users = fake.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]!.name).toBe('Asha Updated');
  });
});

describe('SignalStackWriterFake.seed — aggregators', () => {
  it('seeds an aggregator with an explicit org_id', () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      aggregators: [
        {
          org_id: 'org-pinned',
          external_id: 'ext-1',
          name: 'Org One',
          slug: 'org-one',
          metadata: { tier: 'gold' },
        },
      ],
    });

    const aggregators = fake.listAggregators();
    expect(aggregators).toHaveLength(1);
    expect(aggregators[0]).toMatchObject({
      org_id: 'org-pinned',
      external_id: 'ext-1',
      name: 'Org One',
      slug: 'org-one',
      metadata: { tier: 'gold' },
    });
  });

  it('mints a sequential seed-org-N id when none is given', () => {
    const fake = new SignalStackWriterFake();
    fake.seed({
      aggregators: [
        { external_id: 'ext-1', name: 'Org One', slug: 'org-one' },
        { external_id: 'ext-2', name: 'Org Two', slug: 'org-two' },
      ],
    });

    const aggregators = fake.listAggregators();
    expect(aggregators.map((a) => a.org_id)).toEqual(['seed-org-1', 'seed-org-2']);
  });
});

describe('buildDecryptedProfileRow', () => {
  it('returns a fully-populated default row', () => {
    const row = buildDecryptedProfileRow();
    expect(row).toEqual({
      item_id: 'item-1',
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_state: { name: 'Default Name', phone: '+910000000000' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('applies overrides on top of the defaults', () => {
    const row = buildDecryptedProfileRow({
      item_id: 'item-custom',
      item_state: { name: 'Velu Murugan' },
    });
    expect(row.item_id).toBe('item-custom');
    expect(row.item_state).toEqual({ name: 'Velu Murugan' });
    // Untouched defaults still apply.
    expect(row.item_network).toBe('blue_dot');
  });
});
