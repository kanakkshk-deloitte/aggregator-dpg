/**
 * Unit tests for orgOptionsInTreeOrder.
 *
 * Covers: tree order (parents first, siblings by name), path labels with the
 * "known as" label, a raw key when not configured, an org whose parent is not
 * listed, and an empty list.
 */
import { describe, it, expect } from 'vitest';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { orgOptionsInTreeOrder, orgsBelow, topmostOwned } from '@/lib/console-org-options';

type OrgRow = OrgSearchResponse['orgs'][number];

const row = (
  id: string,
  name: string,
  parentId: string | null,
  over: Partial<OrgRow> = {},
): OrgRow => ({
  id,
  slug: id,
  name,
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  url: null,
  locations: [],
  legal_name: null,
  gst_number: null,
  known_as: 'aggregator',
  known_as_name: 'Aggregator',
  depth: 3,
  parent_id: parentId,
  parent_name: null,
  created_at: 't',
  updated_at: 't',
  coordinator_count: 0,
  child_count: 0,
  pending_count: 0,
  ...over,
});

describe('orgOptionsInTreeOrder', () => {
  it('orders parents before children and siblings by name, with path labels', () => {
    const options = orgOptionsInTreeOrder([
      row('m', 'Mysuru', 'k', { known_as_name: 'District' }),
      row('z', 'zeta', 'root'),
      row('k', 'Karnataka', 'root', { known_as_name: 'State' }),
      row('b', 'Bengaluru', 'k', { known_as_name: 'District' }),
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'Karnataka (State)',
      'Karnataka › Bengaluru (District)',
      'Karnataka › Mysuru (District)',
      'zeta (Aggregator)',
    ]);
    expect(options[2]).toMatchObject({ id: 'm', name: 'Mysuru' });
  });

  it('shows the raw key when the value is not configured', () => {
    const [o] = orgOptionsInTreeOrder([
      row('a', 'Alpha', null, { known_as: 'old', known_as_name: null }),
    ]);
    expect(o?.label).toBe('Alpha (old)');
  });

  it('starts a path at an org whose parent is not listed', () => {
    const options = orgOptionsInTreeOrder([row('m', 'Mysuru', 'not-reachable')]);
    expect(options.map((o) => o.label)).toEqual(['Mysuru (Aggregator)']);
  });

  it('returns nothing for no orgs', () => {
    expect(orgOptionsInTreeOrder([])).toEqual([]);
  });
});

describe('orgsBelow / topmostOwned', () => {
  const tree = [
    row('s', 'State', null),
    row('d', 'District', 's'),
    row('a', 'Agg', 'd'),
    row('x', 'Other', null),
    row('y', 'Other child', 'x'),
  ];

  it('lists every org below one, at any depth, without it', () => {
    expect(
      orgsBelow('s', tree)
        .map((o) => o.id)
        .sort(),
    ).toEqual(['a', 'd']);
    expect(orgsBelow('a', tree)).toEqual([]);
  });

  it('keeps only owned orgs that sit under no other owned org', () => {
    expect(topmostOwned(['d', 's', 'y'], tree).map((o) => o.id)).toEqual(['y', 's']);
    expect(topmostOwned([], tree)).toEqual([]);
  });
});
