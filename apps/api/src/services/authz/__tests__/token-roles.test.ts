/**
 * Unit tests for keeping the token's `roles` claim in step with the database
 * (`@aggregator-dpg/api`; docs/rbac/rbac-edge-enforcement.md §3.2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { buildAdminActor, type Actor, type ActorResult } from '../../auth/actor/index.js';
import { _setIdpAdmin } from '../../idp-admin/index.js';
import { IdpAdminFake } from '../../idp-admin/testing.js';
import { _setIdentityStore } from '../../identity-store/index.js';
import { IdentityStoreFake, buildIdentity } from '../../identity-store/testing.js';
import { _setRbacRuntime } from '../runtime.js';
import { shippedRoleIndex } from '../testing.js';
import {
  defaultTokenRolesDeps,
  syncTokenRoles,
  tokenRolesOf,
  requestTokenRolesSync,
  type TokenRolesDeps,
} from '../token-roles.js';

const NOW = 1_800_000_000_000;
const ORG = '00000000-0000-4000-8000-0000000000f1';
const ROOT = '00000000-0000-4000-8000-0000000000f0';

const coordinator = (over: Partial<Actor> = {}): Actor => ({
  userId: 'c1',
  userType: 'coordinator',
  active: true,
  orgs: [{ id: ORG, orgType: 'aggregator', relation: 'member', isDefault: false }],
  ...over,
});

/** Recording fake dependencies; each piece can be replaced per test. */
function fakeDeps(actor: ActorResult, over: Partial<TokenRolesDeps> = {}) {
  const writes: Array<{ idp: string; roles: string[] | null }> = [];
  const dirty: string[] = [];
  const deps: TokenRolesDeps = {
    actorOf: async () => actor,
    idpUserOf: async () => ({ ok: true, value: 'kc-1' }),
    writeRoles: async (idp, roles) => {
      writes.push({ idp, roles });
      return { ok: true };
    },
    withLock: async (_id, fn) => ({ acquired: true, value: await fn() }),
    markDirty: async (id) => void dirty.push(id),
    now: () => NOW,
    ...over,
  };
  return { deps, writes, dirty };
}

beforeEach(async () => {
  _setRbacRuntime({
    mode: 'enforce',
    roles: await shippedRoleIndex(),
    authorizer: new AuthorizerFake(),
  });
});

afterEach(() => {
  _setRbacRuntime(null);
  _setIdpAdmin(null);
  _setIdentityStore(null);
});

describe('tokenRolesOf', () => {
  it("lists an active coordinator's base and live additional roles", () => {
    const actor = coordinator({
      roles: [
        { roleKey: 'pii_access', orgId: ORG, expiresAt: NOW + 1 },
        { roleKey: 'data_export', orgId: ORG, expiresAt: null },
      ],
    });
    expect(tokenRolesOf(actor, NOW)).toEqual(['coordinator', 'data_export', 'pii_access']);
  });

  it('lists nothing for an inactive account or no account', () => {
    expect(tokenRolesOf(coordinator({ active: false }), NOW)).toEqual([]);
    expect(tokenRolesOf(null, NOW)).toEqual([]);
  });

  it('lists the network admin owning the root and an aggregator organisation', () => {
    const actor = buildAdminActor({
      orgs: [
        { id: ROOT, orgType: 'network_facilitator', relation: 'owner', isDefault: false },
        { id: ORG, orgType: 'aggregator', relation: 'owner', isDefault: true },
      ],
    });
    expect(tokenRolesOf(actor, NOW)).toEqual(['network_admin', 'org_admin']);
  });

  it('lists nothing with RBAC off', () => {
    _setRbacRuntime(null);
    expect(tokenRolesOf(coordinator(), NOW)).toEqual([]);
  });
});

describe('syncTokenRoles', () => {
  it('does nothing while RBAC is off', async () => {
    _setRbacRuntime(null);
    const { deps, writes } = fakeDeps({ ok: true, value: coordinator() });
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('off');
    expect(writes).toHaveLength(0);
  });

  it("writes the user's whole role list to their Keycloak user", async () => {
    const { deps, writes, dirty } = fakeDeps({
      ok: true,
      value: coordinator({ roles: [{ roleKey: 'data_export', orgId: ORG, expiresAt: null }] }),
    });
    expect(await syncTokenRoles('c1', 'role_assigned', deps)).toBe('synced');
    expect(writes).toEqual([{ idp: 'kc-1', roles: ['coordinator', 'data_export'] }]);
    expect(dirty).toEqual([]);
  });

  it('removes the attribute when the user holds no role', async () => {
    const { deps, writes } = fakeDeps({ ok: true, value: coordinator({ active: false }) });
    expect(await syncTokenRoles('c1', 'coordinator_rejected', deps)).toBe('synced');
    expect(writes).toEqual([{ idp: 'kc-1', roles: null }]);
  });

  it('skips an account that no longer exists', async () => {
    const { deps, writes, dirty } = fakeDeps({ ok: true, value: null });
    expect(await syncTokenRoles('gone', 'test', deps)).toBe('no_login');
    expect(writes).toHaveLength(0);
    expect(dirty).toHaveLength(0);
  });

  it('skips an account with no Keycloak user', async () => {
    const { deps, writes, dirty } = fakeDeps(
      { ok: true, value: coordinator() },
      { idpUserOf: async () => ({ ok: true, value: null }) },
    );
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('no_login');
    expect(writes).toHaveLength(0);
    expect(dirty).toHaveLength(0);
  });

  it('marks the user for the sweep when the database read fails', async () => {
    const { deps, writes, dirty } = fakeDeps({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'db down' },
    });
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('failed');
    expect(writes).toHaveLength(0);
    expect(dirty).toEqual(['c1']);
  });

  it('marks the user for the sweep when the Keycloak lookup fails', async () => {
    const { deps, dirty } = fakeDeps(
      { ok: true, value: coordinator() },
      {
        idpUserOf: async () => ({
          ok: false,
          error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
        }),
      },
    );
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('failed');
    expect(dirty).toEqual(['c1']);
  });

  it('marks the user for the sweep when the write fails', async () => {
    const { deps, dirty } = fakeDeps(
      { ok: true, value: coordinator() },
      {
        writeRoles: async () => ({
          ok: false,
          error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
        }),
      },
    );
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('failed');
    expect(dirty).toEqual(['c1']);
  });

  it('defers to the sweep when another write holds the lock', async () => {
    const { deps, writes, dirty } = fakeDeps(
      { ok: true, value: coordinator() },
      { withLock: async () => ({ acquired: false }) },
    );
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('deferred');
    expect(writes).toHaveLength(0);
    expect(dirty).toEqual(['c1']);
  });

  it('never throws: an unexpected error marks the user for the sweep', async () => {
    const { deps, dirty } = fakeDeps(
      { ok: true, value: coordinator() },
      {
        actorOf: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(await syncTokenRoles('c1', 'test', deps)).toBe('failed');
    expect(dirty).toEqual(['c1']);
  });
});

describe('the default dependencies', () => {
  async function kcUser(idp: IdpAdminFake, aggregatorId?: string): Promise<string> {
    const created = await idp.createUser({
      email: `${aggregatorId ?? 'admin'}@example.org`,
      attributes: aggregatorId ? { aggregator_id: aggregatorId } : {},
    });
    if (!created.ok) throw new Error('fake createUser failed');
    return created.value.id;
  }

  it('finds a linked account through its recorded login', async () => {
    const idp = new IdpAdminFake();
    _setIdpAdmin(idp);
    const store = new IdentityStoreFake();
    store.seed([buildIdentity({ userId: 'a1', subject: 'kc-a1' })]);
    _setIdentityStore(store);
    const res = await defaultTokenRolesDeps().idpUserOf('a1', buildAdminActor({ userId: 'a1' }));
    expect(res).toEqual({ ok: true, value: 'kc-a1' });
  });

  it('falls back to the aggregator_id attribute for an unlinked coordinator', async () => {
    const idp = new IdpAdminFake();
    _setIdpAdmin(idp);
    _setIdentityStore(new IdentityStoreFake());
    const id = await kcUser(idp, 'c9');
    const res = await defaultTokenRolesDeps().idpUserOf('c9', coordinator({ userId: 'c9' }));
    expect(res).toEqual({ ok: true, value: id });
  });

  it('does not search by attribute for an unlinked admin', async () => {
    _setIdpAdmin(new IdpAdminFake());
    _setIdentityStore(new IdentityStoreFake());
    const res = await defaultTokenRolesDeps().idpUserOf('a9', buildAdminActor({ userId: 'a9' }));
    expect(res).toEqual({ ok: true, value: null });
  });

  it('writes the roles attribute, retrying a transient failure once', async () => {
    const idp = new IdpAdminFake();
    _setIdpAdmin(idp);
    const id = await kcUser(idp, 'c1');
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'blip' });
    expect(await defaultTokenRolesDeps().writeRoles(id, ['coordinator'])).toEqual({ ok: true });
    const found = await idp.findByAttribute('roles', 'coordinator');
    expect(found.ok && found.value?.id).toBe(id);
  });

  it('does not retry a missing Keycloak user', async () => {
    _setIdpAdmin(new IdpAdminFake());
    const res = await defaultTokenRolesDeps().writeRoles('nobody', ['coordinator']);
    expect(res).toMatchObject({ ok: false, error: { code: 'USER_NOT_FOUND' } });
  });
});

describe('requestTokenRolesSync', () => {
  it('starts nothing with RBAC off', () => {
    _setRbacRuntime(null);
    expect(() => requestTokenRolesSync(['c1', null, 'c1'], 'test')).not.toThrow();
  });
});
