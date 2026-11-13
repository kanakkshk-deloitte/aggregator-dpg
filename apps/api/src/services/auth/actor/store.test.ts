/**
 * Unit tests for the store-backed actor resolver (design: the database, not the
 * token, is the authority for who a caller is).
 *
 * Exercises both resolve entry points — a token with an `aggregator_id` claim
 * (coordinator) and one without (resolved through the recorded IdP login to a
 * coordinator or an org-owning admin) — and every store-failure branch, using
 * the in-memory stores with method overrides to inject failures (fakes over
 * mocks, per testing.md).
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdentityStoreFake } from '../../identity-store/testing.js';
import { _setIdentityStore } from '../../identity-store/index.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import { InMemoryRoleStore, _setRoleStore } from '../../role-store/index.js';
import { _setRbacRuntime } from '../../authz/runtime.js';
import { shippedRoleIndex } from '../../authz/testing.js';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { StoreActorResolver } from './store.js';

const COORD_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'kc-sub-1';

describe('StoreActorResolver', () => {
  let coordStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;
  let identity: IdentityStoreFake;
  let roleStore: InMemoryRoleStore;
  const resolver = new StoreActorResolver();

  beforeEach(() => {
    coordStore = new UserStoreFake();
    orgStore = new OrganisationStoreFake();
    identity = new IdentityStoreFake();
    roleStore = new InMemoryRoleStore();
    _setUserStore(coordStore);
    _setRoleStore(roleStore);
    _setOrganisationStore(orgStore);
    _setIdentityStore(identity);
  });

  afterEach(() => {
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdentityStore(null);
    _setRoleStore(null);
    _setRbacRuntime(null);
  });

  describe('claimed coordinator (aggregator_id present)', () => {
    it('resolves to the coordinator when the recorded login is this subject', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active' })]);
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      const r = await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT });
      expect(r).toEqual({
        ok: true,
        value: expect.objectContaining({ userId: COORD_ID, userType: 'coordinator', active: true }),
      });
    });

    it('resolves a coordinator with no parent org to an empty orgs list', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active', parentOrgId: null })]);
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      const r = await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT });
      expect(r.ok && r.value?.orgs).toEqual([]);
    });

    it('resolves to null when the subject does not match the recorded login', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active' })]);
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: 'someone-else' }]);
      expect(await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT })).toEqual({
        ok: true,
        value: null,
      });
    });

    it('reports UNAVAILABLE when the identity store fails', async () => {
      identity.subjectOf = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('reports UNAVAILABLE when the coordinator row read fails', async () => {
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      coordStore.findById = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('resolves to null when the claimed coordinator row is gone', async () => {
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      expect(await resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT })).toEqual({
        ok: true,
        value: null,
      });
    });
  });

  describe('token without aggregator_id', () => {
    it('resolves to null when no login is recorded for the subject', async () => {
      expect(await resolver.resolve({ subject: SUBJECT })).toEqual({ ok: true, value: null });
    });

    it('reports UNAVAILABLE when the login lookup fails', async () => {
      identity.userOf = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('resolves a recorded login that is a coordinator (no claim, missing mapper)', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active' })]);
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r).toEqual({
        ok: true,
        value: expect.objectContaining({ userId: COORD_ID, userType: 'coordinator' }),
      });
    });

    it('reports UNAVAILABLE when the coordinator probe fails', async () => {
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      coordStore.findById = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('resolves an admin owning active orgs, the root marking the network admin', async () => {
      identity.seed([{ userId: ADMIN_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      const root = buildOrganisation({
        id: 'root-1',
        slug: 'network',
        ownerUserId: ADMIN_ID,
        status: 'active',
      });
      orgStore.seedRoot(root);
      orgStore.seed([
        buildOrganisation({ id: 'org-a', slug: 'a', ownerUserId: ADMIN_ID, status: 'active' }),
        buildOrganisation({ id: 'org-b', slug: 'b', ownerUserId: ADMIN_ID, status: 'inactive' }),
      ]);
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value?.userType).toBe('admin');
      expect(r.value?.active).toBe(true);
      const orgTypes = r.value?.orgs.map((o) => `${o.orgType}:${o.id}`) ?? [];
      // Root present, the active aggregator org present, the inactive one excluded.
      expect(orgTypes).toContain('network_facilitator:root-1');
      expect(orgTypes).toContain('aggregator:org-a');
      expect(orgTypes).not.toContain('aggregator:org-b');
    });

    it('resolves an admin owning nothing active as inactive with no orgs', async () => {
      identity.seed([{ userId: ADMIN_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r).toEqual({
        ok: true,
        value: { userId: ADMIN_ID, userType: 'admin', active: false, orgs: [] },
      });
    });

    it('reports UNAVAILABLE when the owned-orgs read fails', async () => {
      identity.seed([{ userId: ADMIN_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      orgStore.listOwnedBy = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('reports UNAVAILABLE when the root read fails', async () => {
      identity.seed([{ userId: ADMIN_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      orgStore.findRoot = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const r = await resolver.resolve({ subject: SUBJECT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });
  });

  describe('additional roles', () => {
    const asCoordinator = async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active' })]);
      identity.seed([{ userId: COORD_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      return resolver.resolve({ aggregatorId: COORD_ID, subject: SUBJECT });
    };
    const rbacOn = async () =>
      _setRbacRuntime({
        mode: 'log',
        roles: await shippedRoleIndex(),
        authorizer: new AuthorizerFake(),
      });

    it('attaches the live roles when RBAC is on', async () => {
      await rbacOn();
      roleStore.seed([{ userId: COORD_ID, roleKey: 'data_export', orgId: 'org-a' }]);
      const r = await asCoordinator();
      expect(r.ok && r.value?.roles).toEqual([
        { roleKey: 'data_export', orgId: 'org-a', expiresAt: null },
      ]);
    });

    it('reports UNAVAILABLE when the role store fails with RBAC on', async () => {
      await rbacOn();
      roleStore.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
      const r = await asCoordinator();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('UNAVAILABLE');
    });

    it('skips the role store when RBAC is off', async () => {
      roleStore.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
      const r = await asCoordinator();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).not.toHaveProperty('roles');
    });
  });

  describe('byUserId (no token: the token-roles sync)', () => {
    it('resolves a coordinator by its id, even with no recorded login', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'active' })]);
      const r = await resolver.byUserId(COORD_ID);
      expect(r.ok && r.value?.userType).toBe('coordinator');
      expect(r.ok && r.value?.active).toBe(true);
    });

    it('resolves a pending coordinator as inactive', async () => {
      coordStore.seed([buildCoordinator({ id: COORD_ID, status: 'pending' })]);
      const r = await resolver.byUserId(COORD_ID);
      expect(r.ok && r.value?.active).toBe(false);
    });

    it('resolves an admin by its id, with the active orgs it owns', async () => {
      orgStore.seedRoot(
        buildOrganisation({
          id: 'root-1',
          slug: 'network',
          ownerUserId: ADMIN_ID,
          status: 'active',
        }),
      );
      const r = await resolver.byUserId(ADMIN_ID);
      expect(r.ok && r.value?.userType).toBe('admin');
      expect(r.ok && r.value?.orgs.map((o) => o.orgType)).toEqual(['network_facilitator']);
    });

    it('agrees with resolve() for a linked admin', async () => {
      identity.seed([{ userId: ADMIN_ID, provider: IDP_PROVIDER, subject: SUBJECT }]);
      orgStore.seed([
        buildOrganisation({ id: 'org-a', slug: 'a', ownerUserId: ADMIN_ID, status: 'active' }),
      ]);
      expect(await resolver.byUserId(ADMIN_ID)).toEqual(
        await resolver.resolve({ subject: SUBJECT }),
      );
    });
  });
});
