/**
 * Unit tests for the coordinator manage/view scope (`@aggregator-dpg/api`,
 * RBAC #873): which organisations' coordinators an admin may change, which it
 * may only read, and that a narrowing is always recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexRoles, type RoleIndex } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { inManageScope, manageableOrgIds } from '../manage-scope.js';
import { _setRbacRuntime, type RbacMode } from '../runtime.js';
import { shippedRoleIndex, shippedRoles } from '../testing.js';
import { buildAdminActor, type Actor } from '../../auth/actor/index.js';

const roles = await shippedRoleIndex();
/** The shipped roles with org.manage taken out, so an owner's scope narrows. */
const rolesWithoutOrgManage = indexRoles(
  (await shippedRoles()).map((r) => ({
    ...r,
    permissions: r.permissions.filter((p) => p !== 'org.manage'),
  })),
);

const ROOT = '00000000-0000-4000-8000-0000000000r1'.replace('r', 'e');
const OWNED = '00000000-0000-4000-8000-0000000000f1';

function req() {
  const log = { debug: vi.fn(), warn: vi.fn() };
  return { log: log as never, method: 'GET', routeOptions: { url: '/v1/user/search' }, spy: log };
}

function setup(mode: RbacMode extends 'off' ? never : 'log' | 'enforce', index: RoleIndex = roles) {
  _setRbacRuntime({ mode, roles: index, authorizer: new AuthorizerFake() });
}

/** The network admin: owns the root plus one aggregator organisation. */
function networkAdmin(): Actor {
  return buildAdminActor({
    orgs: [
      { id: ROOT, orgType: 'network_facilitator', relation: 'owner', isDefault: false },
      { id: OWNED, orgType: 'aggregator', relation: 'owner', isDefault: true },
    ],
  });
}

afterEach(() => _setRbacRuntime(null));

describe('manageableOrgIds', () => {
  it('keeps the network admin to the aggregator organisations it owns, under enforce', async () => {
    setup('enforce');
    const r = req();

    const ids = await manageableOrgIds(r as never, networkAdmin(), ROOT);

    // The root is never a coordinator's organisation; only the owned aggregator org is.
    expect(ids).toEqual([OWNED]);
    expect(inManageScope(ids, OWNED)).toBe(true);
    expect(inManageScope(ids, 'some-other-org')).toBe(false);
  });

  it('records the narrowing in enforce mode, where it actually withholds', async () => {
    setup('enforce', rolesWithoutOrgManage);
    const r = req();

    expect(await manageableOrgIds(r as never, networkAdmin(), ROOT)).toEqual([]);

    expect(r.spy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rbac.manage_scope',
        status: 'failure',
        mode: 'enforce',
        reasons: ['org_manage_not_held'],
      }),
    );
  });

  it('logs but withholds nothing in log mode', async () => {
    setup('log', rolesWithoutOrgManage);
    const r = req();

    const ids = await manageableOrgIds(r as never, networkAdmin(), ROOT);

    expect(ids).toEqual([OWNED]); // full reach — log mode blocks nothing
    expect(r.spy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'rbac.manage_scope', status: 'skipped', mode: 'log' }),
    );
  });

  it("keeps the network admin's view to the organisations it owns", async () => {
    setup('enforce');
    const r = req();

    const ids = await manageableOrgIds(r as never, networkAdmin(), ROOT, 'view');

    // network.administer in the root no longer opens other organisations' coordinators.
    expect(ids).toEqual([OWNED]);
    expect(r.spy.warn).not.toHaveBeenCalled();
  });

  it('returns reach unchanged when RBAC is off', async () => {
    _setRbacRuntime(null);
    const r = req();

    expect(await manageableOrgIds(r as never, networkAdmin(), ROOT)).toEqual([OWNED]);
    expect(r.spy.warn).not.toHaveBeenCalled();
  });
});
