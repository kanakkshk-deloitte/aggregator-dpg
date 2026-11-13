import { describe, it, expect, vi } from 'vitest';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import {
  OrganisationStoreFake,
  buildDefaultOrg,
  buildOrganisation,
} from '../organisation-store/index.js';
import { warnOrgTreeOverLimits } from '../org-tree-warnings.js';

const ROOT = 'root';

const cfg = (hierarchy: Partial<OrganisationConfig['hierarchy']> = {}): OrganisationConfig => ({
  hierarchy: { max_depth: 2, max_total_orgs: 50, ...hierarchy },
});

/**
 * Root (list: state) → A (state) → B (no list) → C (state, depth 3), plus a
 * rejected D at depth 3 and the Default org. C's key is not in B's list.
 */
function seeded(): OrganisationStoreFake {
  const store = new OrganisationStoreFake();
  store.seedRoot(
    buildOrganisation({
      id: ROOT,
      slug: 'network',
      status: 'active',
      depth: 0,
    }),
  );
  store.seedKnownAsValues(ROOT, [{ key: 'state', name: 'State' }]);
  store.seed([
    buildDefaultOrg({ parentId: ROOT }),
    buildOrganisation({ id: 'a', slug: 'a', status: 'active', parentId: ROOT, knownAs: 'state' }),
    buildOrganisation({ id: 'b', slug: 'b', status: 'active', parentId: 'a', depth: 2 }),
    buildOrganisation({ id: 'c', slug: 'c', parentId: 'b', depth: 3, knownAs: 'state' }),
    buildOrganisation({ id: 'd', slug: 'd', status: 'inactive', parentId: 'b', depth: 3 }),
  ]);
  return store;
}

const checks = (warn: ReturnType<typeof vi.fn>) =>
  Object.fromEntries(
    warn.mock.calls.map(([e]) => {
      const { check, ...rest } = e as { check: string };
      return [check, rest];
    }),
  );

describe('warnOrgTreeOverLimits', () => {
  it('logs one entry per kind with counts only; a total over the limit is an error', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_children: 1, max_total_orgs: 2 }), {
      warn,
      error,
    });
    expect(checks(warn)).toEqual({
      depth: expect.objectContaining({ org_count: 1, max_depth: 2 }),
      known_as: expect.objectContaining({ org_count: 1 }),
    });
    expect(checks(error)).toEqual({
      total: expect.objectContaining({
        total_orgs: 3,
        max_total_orgs: 2,
        registration: 'closed',
      }),
    });
    for (const [e] of [...warn.mock.calls, ...error.mock.calls]) {
      expect(e).toMatchObject({ operation: 'orgTree.bootCheck', status: 'success' });
    }
  });

  it('warns, not errors, when the total is exactly at the limit', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_depth: 3, max_total_orgs: 3 }), {
      warn,
      error,
    });
    expect(checks(warn).total).toMatchObject({ total_orgs: 3, registration: 'closed' });
    expect(error).not.toHaveBeenCalled();
  });

  it('counts orgs with more children than max_children, the root included', async () => {
    const store = seeded();
    store.seed([buildOrganisation({ id: 'e', slug: 'e', parentId: ROOT })]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3, max_children: 1 }), {
      warn,
      error: vi.fn(),
    });
    expect(checks(warn).children).toMatchObject({ org_count: 1, max_children: 1 });
  });

  it('logs only the kinds over a limit', async () => {
    const warn = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_depth: 3 }), { warn, error: vi.fn() });
    // C's "state" is not in B's list.
    expect(Object.keys(checks(warn))).toEqual(['known_as']);
  });

  it('warns once when the config still has a known_as block', async () => {
    const warn = vi.fn();
    await warnOrgTreeOverLimits(
      seeded(),
      { ...cfg({ max_depth: 3 }), known_as: { values: [] } },
      { warn, error: vi.fn() },
    );
    expect(checks(warn).known_as_config).toMatchObject({
      operation: 'orgTree.bootCheck',
      status: 'skipped',
    });
    expect(Object.keys(checks(warn))).toEqual(['known_as_config', 'known_as']);
  });

  it('does not count a key in the parent list, or aggregator', async () => {
    const store = seeded();
    store.seed([
      buildOrganisation({
        id: 'b',
        slug: 'b',
        status: 'active',
        parentId: 'a',
        depth: 2,
      }),
      buildOrganisation({ id: 'e', slug: 'e', parentId: 'b', depth: 3 }),
    ]);
    store.seedKnownAsValues('b', [{ key: 'state', name: 'State' }]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3 }), { warn, error: vi.fn() });
    expect(checks(warn).known_as).toBeUndefined();
  });

  it('reads the list of a parent that is not counted', async () => {
    const store = seeded();
    store.seed([
      buildOrganisation({
        id: 'd',
        slug: 'd',
        status: 'inactive',
        parentId: 'b',
        depth: 3,
      }),
      buildOrganisation({ id: 'f', slug: 'f', parentId: 'd', depth: 3, knownAs: 'block' }),
      buildOrganisation({ id: 'g', slug: 'g', parentId: 'd', depth: 3, knownAs: 'gone' }),
    ]);
    store.seedKnownAsValues('d', [{ key: 'block', name: 'Block' }]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3 }), { warn, error: vi.fn() });
    // C ("state" under B) and G ("gone" under D).
    expect(checks(warn).known_as).toMatchObject({ org_count: 2 });
  });

  it('logs an error when the stale count cannot be read', async () => {
    const store = seeded();
    vi.spyOn(store, 'countStaleKnownAs').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const error = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3 }), { warn: vi.fn(), error });
    expect(error.mock.calls[0]?.[0]).toMatchObject({ status: 'failure', error: 'down' });
  });

  it('logs a failure as an error and returns when the store cannot be read', async () => {
    const store = seeded();
    vi.spyOn(store, 'search').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(store, cfg(), { warn, error });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      operation: 'orgTree.bootCheck',
      status: 'failure',
      error: 'down',
    });
  });
});
