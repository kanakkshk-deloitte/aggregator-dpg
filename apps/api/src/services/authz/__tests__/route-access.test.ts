/**
 * Unit tests for route access declarations (`@aggregator-dpg/api`, RBAC R1):
 * the boot check, the per-route enforcement, and the declared route table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest, RouteOptions } from 'fastify';
import { CAPABILITIES } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { buildApp } from '../../../app.js';
import { config } from '../../../config.js';
import {
  assertRouteDeclared,
  enforcedCapabilities,
  exportRouteTable,
  isServiceAccount,
  listDeclaredRoutes,
  recordRouteCaller,
  _resetDeclaredRoutes,
  type RouteAccess,
} from '../route-access.js';
import { _setRbacRuntime } from '../runtime.js';
import { shippedRoleIndex } from '../testing.js';
import { ActorResolverFake, _setActorResolver } from '../../auth/actor/index.js';
import { getIdentityStore } from '../../identity-store/index.js';

const roles = await shippedRoleIndex();

afterEach(() => {
  _setRbacRuntime(null);
  _setActorResolver(null);
});

function route(
  rbac?: RouteAccess,
  method: RouteOptions['method'] = 'GET',
  url = '/v1/x',
): RouteOptions {
  return {
    method,
    url,
    handler: async () => undefined,
    ...(rbac ? { config: { rbac } } : {}),
  } as RouteOptions;
}

function req(rbac: RouteAccess) {
  const warn = vi.fn();
  return {
    r: {
      routeOptions: { config: { rbac }, url: '/v1/x' },
      method: 'GET',
      log: { warn, debug: vi.fn() },
    } as unknown as FastifyRequest,
    warn,
  };
}

function setup(mode: 'log' | 'enforce', active = true) {
  _setRbacRuntime({ mode, roles, authorizer: new AuthorizerFake() });
  const resolver = new ActorResolverFake();
  resolver.seed('u1', {
    userId: 'u1',
    userType: 'coordinator',
    active,
    orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', isDefault: false }],
  });
  _setActorResolver(resolver);
}

describe('assertRouteDeclared', () => {
  it('accepts a declared route', () => {
    expect(() => assertRouteDeclared(route({ capability: 'profiles.view' }))).not.toThrow();
  });

  it('refuses a route without a declaration', () => {
    expect(() => assertRouteDeclared(route())).toThrow(/no config.rbac/);
  });

  it('refuses an unknown capability', () => {
    expect(() => assertRouteDeclared(route({ capability: 'nope' } as never))).toThrow(
      /unknown capability/,
    );
  });

  it('accepts an any-of declaration and refuses an empty or unknown one', () => {
    expect(() =>
      assertRouteDeclared(route({ anyCapability: ['org.manage', 'orgs.onboard'] })),
    ).not.toThrow();
    expect(() => assertRouteDeclared(route({ anyCapability: [] }))).toThrow(/empty anyCapability/);
    expect(() =>
      assertRouteDeclared(route({ anyCapability: ['org.manage', 'nope'] } as never)),
    ).toThrow(/unknown capability/);
  });

  it('skips HEAD and plugin routes', () => {
    expect(() => assertRouteDeclared(route(undefined, 'HEAD'))).not.toThrow();
    expect(() =>
      assertRouteDeclared(route(undefined, 'GET', '/api/reference/openapi.json')),
    ).not.toThrow();
  });
});

describe('isServiceAccount', () => {
  it('matches only service-account usernames', () => {
    expect(isServiceAccount('service-account-aggregator-bff')).toBe(true);
    expect(isServiceAccount('alice')).toBe(false);
    expect(isServiceAccount(undefined)).toBe(false);
  });
});

// Route permissions are decided at the edge (docs/rbac/rbac-edge-enforcement.md;
// policy/rbac/edge_test.rego); the API only records the caller's login here.
describe('recordRouteCaller', () => {
  const linked = async (userId: string) => {
    const r = await getIdentityStore().subjectOf(userId, 'keycloak');
    return r.ok ? r.value : 'store failed';
  };
  const caller = (aggregatorId?: string) => ({
    subject: `sub-${aggregatorId ?? 'none'}`,
    ...(aggregatorId ? { aggregatorId } : {}),
  });

  it("records a coordinator's login on a declared route", async () => {
    setup('enforce');
    await recordRouteCaller(req({ capability: 'profiles.view' }).r, caller('c-1'));
    expect(await linked('c-1')).toBe('sub-c-1');
  });

  it('never refuses, whatever the caller holds (the edge decided)', async () => {
    setup('enforce', false);
    for (const decl of [
      { capability: 'profiles.view_pii' },
      { anyCapability: ['org.manage', 'network.administer'] },
      { access: 'self' },
      { access: 'signed_in' },
    ] as RouteAccess[]) {
      const { r, warn } = req(decl);
      await expect(recordRouteCaller(r, caller('c-2'))).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('records nothing on service routes or without an aggregator_id', async () => {
    setup('enforce');
    await recordRouteCaller(req({ access: 'service' }).r, caller('c-3'));
    await recordRouteCaller(req({ capability: 'profiles.view' }).r, caller());
    expect(await linked('c-3')).toBeNull();
  });

  it('does nothing when RBAC is off', async () => {
    await recordRouteCaller(req({ capability: 'profiles.view' }).r, caller('c-4'));
    expect(await linked('c-4')).toBeNull();
  });
});

describe('exportRouteTable', () => {
  afterEach(() => _resetDeclaredRoutes());

  it('is empty before any route is registered', () => {
    _resetDeclaredRoutes();
    expect(exportRouteTable()).toEqual({
      version: 1,
      unchecked_prefixes: ['/api/reference', '/documentation'],
      routes: [],
    });
  });

  it('exports each declared route with its method, path template and declaration, sorted', () => {
    _resetDeclaredRoutes();
    assertRouteDeclared(route({ access: 'public' }, 'GET', '/v1/b'));
    assertRouteDeclared(route({ capability: 'org.manage', strict: true }, 'POST', '/v1/a/:id'));
    assertRouteDeclared(
      route({ anyCapability: ['org.manage', 'orgs.onboard'] }, ['GET', 'HEAD'], '/v1/a'),
    );
    expect(exportRouteTable().routes).toEqual([
      { method: 'GET', path: '/v1/a', access: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      { method: 'GET', path: '/v1/b', access: { access: 'public' } },
      { method: 'POST', path: '/v1/a/:id', access: { capability: 'org.manage', strict: true } },
    ]);
  });

  it('leaves plugin routes out (they carry no declaration)', () => {
    _resetDeclaredRoutes();
    assertRouteDeclared(route(undefined, 'GET', '/documentation/json'));
    expect(exportRouteTable().routes).toEqual([]);
  });
});

describe('declared route table', () => {
  // Building the app runs the boot check on every route; this snapshot makes
  // any change to a route's access visible in review (#805). Built with the
  // CUSTOM-ROLES flag on so the full surface — including the authoring routes
  // that are omitted when it is off — stays visible here; their conditional
  // registration is covered by the v1-console route tests.
  /** One label per declaration: its capability, any-of list, or access kind. */
  const routeAccessLabel = (d: RouteAccess): string => {
    if ('capability' in d) return `${d.capability}${d.strict ? ' (strict)' : ''}`;
    if ('anyCapability' in d) return d.anyCapability.join('|');
    return d.access;
  };

  it('declares every route of the app', async () => {
    const prev = config.RBAC_CUSTOM_ROLES_ENABLED;
    config.RBAC_CUSTOM_ROLES_ENABLED = true;
    _resetDeclaredRoutes();
    const app = await buildApp();
    await app.ready();
    await app.close();
    config.RBAC_CUSTOM_ROLES_ENABLED = prev;
    const table = Object.fromEntries(
      listDeclaredRoutes().map(([k, d]) => [k, routeAccessLabel(d)]),
    );
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(45);
    expect(table).toMatchSnapshot();
  });

  // The catalogue deliberately runs ahead of the routes. Pinning the set keeps
  // that visible: adding the missing route drops a capability from this list
  // and the console stops marking it "not enforced yet" on its own.
  it('names the capabilities nothing enforces yet', async () => {
    const prev = config.RBAC_CUSTOM_ROLES_ENABLED;
    config.RBAC_CUSTOM_ROLES_ENABLED = true;
    _resetDeclaredRoutes();
    const app = await buildApp();
    await app.ready();
    await app.close();
    config.RBAC_CUSTOM_ROLES_ENABLED = prev;

    const enforced = enforcedCapabilities();
    const reserved = CAPABILITIES.filter((c) => !enforced.has(c));

    expect([...reserved].sort()).toEqual([
      'agreement.manage',
      'orgs.block',
      'profiles.act_on_behalf',
      'profiles.move',
      'profiles.retire',
      'profiles.verify',
    ]);
    // Checked inside a handler, not declared on a route — still enforced.
    expect(enforced.has('contact.unmask')).toBe(true);
  });
});
