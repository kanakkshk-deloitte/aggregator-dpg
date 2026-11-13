/**
 * Unit tests for the RBAC permission checks (`@aggregator-dpg/api`): modes,
 * deny paths, and the decision input built from a Phase 5 actor's base and
 * additional roles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import {
  checkCapability,
  decisionInput,
  listCapabilitiesForTargets,
  permissionsByOrg,
} from '../guard.js';
import { _setRbacRuntime } from '../runtime.js';
import { shippedRoleIndex } from '../testing.js';
import {
  ActorResolverFake,
  _setActorResolver,
  buildAdminActor,
  type Actor,
} from '../../auth/actor/index.js';

const roles = await shippedRoleIndex();
const COORDINATOR = ['campaigns.run', 'profiles.onboard', 'profiles.view'];

function req() {
  const log = { debug: vi.fn(), warn: vi.fn() };
  return { log: log as never, method: 'GET', routeOptions: { url: '/v1/x' }, spy: log };
}

const coordinator: Actor = {
  userId: 'u-coord',
  userType: 'coordinator',
  active: true,
  orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', isDefault: false }],
};

function setup(mode: 'log' | 'enforce', actor: Actor | null = coordinator) {
  const authorizer = new AuthorizerFake();
  _setRbacRuntime({ mode, roles, authorizer });
  const resolver = new ActorResolverFake();
  if (actor) resolver.seed('u-coord', actor);
  _setActorResolver(resolver);
  return { authorizer, resolver };
}

afterEach(() => {
  _setRbacRuntime(null);
  _setActorResolver(null);
});

describe('decisionInput', () => {
  it("gives a coordinator its base role's permissions", () => {
    const input = decisionInput(roles, coordinator, 'profiles.view', undefined, 42);
    expect(input).toMatchObject({ capability: 'profiles.view', org: null });
    expect(input.actor).toEqual({ userId: 'u-coord', active: true, permissions: COORDINATOR });
  });

  it('adds a live additional role in the target organisation', () => {
    const actor: Actor = {
      ...coordinator,
      roles: [{ roleKey: 'data_export', orgId: 'org-a', expiresAt: null }],
    };
    const target = { id: 'org-a', orgType: 'aggregator' as const, ancestorIds: [] };
    const input = decisionInput(roles, actor, 'profiles.export', target, 0);
    expect(input.org).toEqual({ id: 'org-a', orgType: 'aggregator' });
    expect(input.actor.permissions).toEqual([...COORDINATOR, 'profiles.export'].sort());
  });

  it('gives nothing in an organisation the actor is not part of', () => {
    const target = { id: 'org-b', orgType: 'aggregator' as const, ancestorIds: [] };
    expect(decisionInput(roles, coordinator, 'profiles.view', target, 0).actor.permissions).toEqual(
      [],
    );
  });
});

// Modes and failure handling of a handler-level check (the per-organisation
// checks the API keeps; route permissions are decided at the edge).
describe('checkCapability modes', () => {
  it('does nothing when RBAC is off', async () => {
    const r = req();
    expect(await checkCapability(r, coordinator, 'profiles.view')).toEqual({
      allowed: true,
      mode: 'off',
    });
    expect(r.spy.warn).not.toHaveBeenCalled();
  });

  it('allows what the role and the organisation set hold', async () => {
    setup('enforce');
    expect(await checkCapability(req(), coordinator, 'profiles.view')).toMatchObject({
      allowed: true,
      decision: { allow: true },
    });
  });

  it('denies in enforce mode and logs a failure', async () => {
    setup('enforce');
    const r = req();
    const out = await checkCapability(r, coordinator, 'profiles.view_pii');
    expect(out).toMatchObject({ allowed: false, decision: { reasons: ['not_held'] } });
    expect(r.spy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rbac.decide',
        status: 'failure',
        capability: 'profiles.view_pii',
      }),
    );
  });

  it('only logs a deny in log mode, unless strict', async () => {
    setup('log');
    const r = req();
    const out = await checkCapability(r, coordinator, 'profiles.view_pii');
    expect(out).toMatchObject({ allowed: true, decision: { allow: false } });
    expect(r.spy.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    const strict = await checkCapability(req(), coordinator, 'profiles.view_pii', { strict: true });
    expect(strict).toMatchObject({ allowed: false });
  });

  it('denies when the engine is unreachable', async () => {
    setup('enforce').authorizer.failWith();
    const out = await checkCapability(req(), coordinator, 'profiles.view');
    expect(out.decision).toEqual({ allow: false, reasons: ['engine_unavailable'] });
  });
});

describe('checkCapability', () => {
  it('honours an additional role until it expires', async () => {
    setup('enforce');
    const actor: Actor = {
      ...coordinator,
      roles: [{ roleKey: 'pii_access', orgId: 'org-a', expiresAt: 100 }],
    };
    expect((await checkCapability(req(), actor, 'profiles.view_pii', { now: 99 })).allowed).toBe(
      true,
    );
    expect((await checkCapability(req(), actor, 'profiles.view_pii', { now: 100 })).allowed).toBe(
      false,
    );
  });

  it('checks the target organisation for an owner of two', async () => {
    setup('enforce');
    const owner = buildAdminActor({
      orgs: [
        { id: 'A', orgType: 'aggregator', relation: 'owner', isDefault: false },
        { id: 'B', orgType: 'aggregator', relation: 'owner', isDefault: false },
      ],
      roles: [{ roleKey: 'org_onboarder', orgId: 'A', expiresAt: null }],
    });
    const at = (id: string) => ({
      target: { id, orgType: 'aggregator' as const, ancestorIds: [] },
    });
    expect((await checkCapability(req(), owner, 'profiles.verify', at('A'))).allowed).toBe(true);
    expect((await checkCapability(req(), owner, 'profiles.verify', at('B'))).allowed).toBe(false);
  });

  it('never allows personal data through the root', async () => {
    setup('enforce');
    const nf = buildAdminActor({
      orgs: [{ id: 'nf', orgType: 'network_facilitator', relation: 'owner', isDefault: false }],
    });
    const out = await checkCapability(req(), nf, 'profiles.view_pii', {
      target: { id: 'nf', orgType: 'network_facilitator', ancestorIds: [] },
    });
    expect(out.decision?.reasons).toEqual(['not_held', 'not_through_root']);
  });

  it('lets a network admin repair access but not an aggregator admin', async () => {
    setup('enforce');
    const nf = buildAdminActor({
      orgs: [{ id: 'nf', orgType: 'network_facilitator', relation: 'owner', isDefault: false }],
    });
    expect((await checkCapability(req(), nf, 'network.administer')).allowed).toBe(true);
    expect((await checkCapability(req(), buildAdminActor(), 'network.administer')).allowed).toBe(
      false,
    );
  });

  it('lets an aggregator admin manage its organisation', async () => {
    setup('enforce');
    expect((await checkCapability(req(), buildAdminActor(), 'org.manage')).allowed).toBe(true);
  });
});

describe('listCapabilitiesForTargets', () => {
  const owned = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `org-${i}`,
      orgType: 'aggregator' as const,
      relation: 'owner' as const,
      isDefault: false,
    }));

  it('asks once for organisations that pose the same question', async () => {
    const { authorizer } = setup('enforce', null);
    const actor = buildAdminActor({ orgs: owned(5) });
    const targets = actor.orgs.map((o) => ({ id: o.id, orgType: o.orgType, ancestorIds: [] }));

    const out = await listCapabilitiesForTargets(req(), actor, targets);

    // Same role in all five organisations ⇒ one engine call, five answers.
    expect(authorizer.listCalls).toHaveLength(1);
    expect(out?.size).toBe(5);
    expect(out?.get('org-0')).toEqual(out?.get('org-4'));
    expect(out?.get('org-0')).toContain('org.manage');
  });

  it('asks separately when the organisation type differs', async () => {
    const { authorizer } = setup('enforce', null);
    const actor = buildAdminActor({
      orgs: [
        { id: 'nf', orgType: 'network_facilitator', relation: 'owner', isDefault: false },
        { id: 'agg', orgType: 'aggregator', relation: 'owner', isDefault: false },
      ],
    });
    const targets = actor.orgs.map((o) => ({ id: o.id, orgType: o.orgType, ancestorIds: [] }));

    const out = await listCapabilitiesForTargets(req(), actor, targets);

    expect(authorizer.listCalls).toHaveLength(2);
    expect(out?.get('nf')).toContain('network.administer');
    expect(out?.get('agg')).not.toContain('network.administer');
  });

  it('returns null when RBAC is off', async () => {
    _setRbacRuntime(null);
    expect(await listCapabilitiesForTargets(req(), buildAdminActor(), [])).toBeNull();
  });
});

describe('permissionsByOrg', () => {
  it('asks once for organisations that pose the same question', async () => {
    const { authorizer } = setup('enforce', null);
    const orgs = Array.from({ length: 4 }, (_, i) => ({
      id: `org-${i}`,
      orgType: 'aggregator' as const,
      relation: 'owner' as const,
      isDefault: false,
    }));
    const actor = buildAdminActor({ orgs });

    const perms = await permissionsByOrg(req(), actor, null);

    // Same role in each organisation, so one engine call answers all four —
    // this runs on every coordinator read and search (#873 manage scope).
    expect(authorizer.listCalls).toHaveLength(1);
    expect(Object.keys(perms ?? {})).toHaveLength(4);
    expect(perms?.['org-0']).toContain('org.manage');
    expect(perms?.['org-0']).toEqual(perms?.['org-3']);
  });

  it('returns null when RBAC is off', async () => {
    _setRbacRuntime(null);
    expect(await permissionsByOrg(req(), buildAdminActor(), null)).toBeNull();
  });
});
