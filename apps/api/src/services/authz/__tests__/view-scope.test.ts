/**
 * Unit tests for the read-only reach one level below an owner's organisations.
 *
 * Covers: adding direct children only, an empty reach, a store failure, the
 * network admin's reach (the top-level orgs), and which orgs are only viewed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrganisationStoreFake,
  _setOrganisationStore,
  buildOrganisation,
} from '../../organisation-store/index.js';
import { isOnlyViewed, viewableOrgIds, withChildren } from '../view-scope.js';
import type { Actor } from '../../auth/actor/index.js';

const owner = (orgIds: string[]): Actor =>
  ({
    userId: 'u1',
    userType: 'admin',
    orgs: orgIds.map((id) => ({ id, orgType: 'aggregator', relation: 'owner' })),
  }) as unknown as Actor;

const networkAdmin = (rootId: string): Actor =>
  ({
    userId: 'na',
    userType: 'admin',
    orgs: [{ id: rootId, orgType: 'network_facilitator', relation: 'owner' }],
  }) as unknown as Actor;

/** root → s → d → a, and root → x. */
function seedTree(): OrganisationStoreFake {
  const store = new OrganisationStoreFake();
  store.seed([
    buildOrganisation({ id: 's', slug: 's', parentId: 'root' }),
    buildOrganisation({ id: 'd', slug: 'd', parentId: 's' }),
    buildOrganisation({ id: 'a', slug: 'a', parentId: 'd' }),
    buildOrganisation({ id: 'x', slug: 'x', parentId: 'root' }),
  ]);
  _setOrganisationStore(store);
  return store;
}

const sorted = (r: Awaited<ReturnType<typeof withChildren>>) => (r.ok ? [...r.value].sort() : r);

afterEach(() => _setOrganisationStore(null));

describe('withChildren', () => {
  it('adds the direct children of the given orgs, nothing deeper', async () => {
    seedTree();
    expect(sorted(await withChildren(['s']))).toEqual(['d', 's']);
  });

  it('keeps an empty list as it is', async () => {
    seedTree();
    expect(await withChildren([])).toEqual({ ok: true, value: [] });
  });

  it('passes a store failure on', async () => {
    const store = seedTree();
    vi.spyOn(store, 'childIds').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const r = await withChildren(['s']);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('viewableOrgIds / isOnlyViewed', () => {
  it('lets an owner read its org and its direct children, not a grandchild or a sibling', async () => {
    seedTree();
    expect(sorted(await viewableOrgIds(owner(['s'])))).toEqual(['d', 's']);
  });

  it('lets the owner of a child read that child and its children only', async () => {
    seedTree();
    expect(sorted(await viewableOrgIds(owner(['d'])))).toEqual(['a', 'd']);
  });

  it('lets the network admin read the top-level orgs only', async () => {
    seedTree();
    expect(sorted(await viewableOrgIds(networkAdmin('root')))).toEqual(['root', 's', 'x']);
  });

  it('gives a coordinator nothing', async () => {
    seedTree();
    const coordinator = { ...owner(['s']), userType: 'coordinator' } as unknown as Actor;
    expect(await viewableOrgIds(coordinator)).toEqual({ ok: true, value: [] });
  });

  it('marks a child of an owner as only viewed, its own org as not', () => {
    const actor = owner(['s']);
    expect(isOnlyViewed(actor, 's')).toBe(false);
    expect(isOnlyViewed(actor, 'd')).toBe(true);
    expect(isOnlyViewed(actor, null)).toBe(true);
  });
});
