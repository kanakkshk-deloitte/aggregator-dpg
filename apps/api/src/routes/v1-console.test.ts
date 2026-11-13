// Console routes /v1/user/* and /v1/org/* (user & org Phase 5): who may do
// what, reach (out of reach → 404), and the decision / edit flows.

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { CAPABILITIES, indexRoles, permissionDefinitions } from '@aggregator-dpg/rbac';
import { AuthorizerFake, buildRole } from '@aggregator-dpg/rbac/testing';
import { _setRbacRuntime, refreshRbacCatalogue } from '../services/authz/runtime.js';
import { shippedRoles, testRbacRuntime } from '../services/authz/testing.js';
import { getRoleStore, type InMemoryRoleStore } from '../services/role-store/index.js';
import { getRbacCatalogue, type InMemoryRbacCatalogue } from '../services/rbac-catalogue/index.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { _setRedis } from '../services/redis/index.js';
import { TEST_TOKEN_ROLES_OFF_KEY } from '../services/authz/edge-test-hook.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import type { Organisation } from '../services/organisation-store/index.js';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setConsoleWriteRateChecker } from '../services/console-rate.js';
import {
  RegistrationInvitesStoreFake,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import { _setInviteIpRateChecker } from '../services/invite-mint-rate.js';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

/** A store `err` result (the aggregator / org fakes use `{ ok, ... }`). */
// A forced store failure for any store method. The concrete error unions differ
// per store (StoreError / OrgStoreError / search results), so the static type is
// widened to `never` (assignable to every result slot); the runtime object still
// carries `{ ok: false, error: { code, message } }` the handlers read.
const storeErr = (code = 'DB_UNAVAILABLE') =>
  ({ ok: false, error: { code, message: 'forced' } }) as unknown as never;
/** A base64url cursor from an arbitrary payload (for the malformed-cursor paths). */
const cursorOf = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

const ROOT = '00000000-0000-4000-8000-000000000001';
const DEFAULT = buildDefaultOrg().id;
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ORG_P = '00000000-0000-4000-8000-00000000000c';

const NA = '00000000-0000-4000-8000-0000000000a0';
const OWNER_A = '00000000-0000-4000-8000-0000000000aa';
const OWNER_B = '00000000-0000-4000-8000-0000000000ab';
const OWNER_P = '00000000-0000-4000-8000-0000000000ac';

const STATE = { key: 'state', name: 'State' };
const DISTRICT = { key: 'district', name: 'District' };
const BLOCK = { key: 'block', name: 'Block' };
const TALUK = { key: 'taluk', name: 'Taluk' };

const C1 = '00000000-0000-4000-8000-0000000000c1'; // ORG_A, pending
const C2 = '00000000-0000-4000-8000-0000000000c2'; // ORG_B, pending
const C3 = '00000000-0000-4000-8000-0000000000c3'; // ORG_A, active

/** Token → claims the fake verifier returns. */
const TOKENS: Record<string, Record<string, unknown>> = {
  na: { sub: 'sub-na', preferred_username: 'na@net.org' },
  a: { sub: 'sub-a', preferred_username: 'a@a.org' },
  b: { sub: 'sub-b', preferred_username: 'b@b.org' },
  p: { sub: 'sub-p', preferred_username: 'p@p.org' },
  coord: { sub: 'sub-c3', preferred_username: 'c3@x.org', aggregator_id: C3 },
  unlinked: { sub: 'sub-nobody', preferred_username: 'nobody@x.org' },
  // A login whose aggregator_id claim names a coordinator whose recorded login it is not.
  forged: { sub: 'sub-nobody', preferred_username: 'nobody@x.org', aggregator_id: C3 },
  svc: { sub: 'sub-svc', preferred_username: 'service-account-aggregator-bff' },
};

const auth = (who: keyof typeof TOKENS) => ({ authorization: `Bearer ${who}` });

describe('console routes /v1/user, /v1/org', () => {
  let app: FastifyInstance;
  let coordinators: UserStoreFake;
  let orgs: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  function coordinator(
    id: string,
    orgId: string,
    status: 'pending' | 'active' | 'inactive' | 'retired',
    n: number,
  ) {
    return buildCoordinator({
      id,
      orgSlug: `coord-${n}`,
      name: `Coordinator ${n}`,
      parentOrgId: orgId,
      isDefaultOrg: false,
      status,
      contact: { name: `C${n}`, phone: `+91900000010${n}`, email: `c${n}@x.org` },
      contactPhone: `+91900000010${n}`,
      contactEmail: `c${n}@x.org`,
      createdAt: new Date(`2026-02-0${n}T00:00:00Z`),
    });
  }

  /** Pins the tree limits: depth 3 unless overridden. */
  function useHierarchy(hierarchy: { max_depth?: number; max_children?: number } = {}): void {
    const base = buildBlueDotConfig();
    _setNetworkConfig(
      buildBlueDotConfig({
        aggregator: {
          ...base.aggregator,
          organisation: { hierarchy: { max_depth: 3, max_total_orgs: 50, ...hierarchy } },
        },
      }),
    );
  }

  /** Sets the root's "known as" list. */
  async function setRootList(list: KnownAsValues): Promise<void> {
    const r = await orgs.findRoot();
    if (!r.ok || !r.value) throw new Error('seed');
    orgs.seedKnownAsValues(r.value.id, list);
  }

  /** Re-seeds an org with some fields changed, and the "known as" list it defines when given. */
  async function setOrg(
    id: string,
    fields: Partial<Organisation> & { knownAsValues?: KnownAsValues },
  ): Promise<void> {
    const r = await orgs.findById(id);
    if (!r.ok || !r.value) throw new Error('seed');
    const { knownAsValues, ...rest } = fields;
    orgs.seed([{ ...r.value, ...rest }]);
    if (knownAsValues) orgs.seedKnownAsValues(id, knownAsValues);
  }

  const savedCustomRoles = config.RBAC_CUSTOM_ROLES_ENABLED;
  beforeEach(async () => {
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    // The role-authoring routes and the full user-roles read assume the
    // CUSTOM-ROLES capability is on; the off behaviour is covered on its own.
    config.RBAC_CUSTOM_ROLES_ENABLED = true;

    coordinators = new UserStoreFake();
    orgs = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    orgs.seedRoot(
      buildOrganisation({
        id: ROOT,
        slug: 'network',
        displayName: 'The Network',
        status: 'active',
        ownerUserId: NA,
        ownerEmail: 'na@net.org',
        depth: 0,
      }),
    );
    orgs.seed([
      { ...buildDefaultOrg(), parentId: ROOT, ownerUserId: NA, ownerEmail: 'na@net.org' },
      buildOrganisation({
        id: ORG_A,
        parentId: ROOT,
        slug: 'org-a',
        displayName: 'Alpha',
        status: 'active',
        ownerUserId: OWNER_A,
        ownerEmail: 'a@a.org',
        ownerKcSub: 'sub-a',
      }),
      buildOrganisation({
        id: ORG_B,
        parentId: ROOT,
        slug: 'org-b',
        displayName: 'Beta',
        status: 'active',
        ownerUserId: OWNER_B,
        ownerEmail: 'b@b.org',
      }),
      buildOrganisation({
        id: ORG_P,
        parentId: ROOT,
        slug: 'org-p',
        displayName: 'Pending Org',
        status: 'pending',
        ownerUserId: OWNER_P,
        ownerEmail: 'p@p.org',
      }),
    ]);
    coordinators.seed([
      coordinator(C1, ORG_A, 'pending', 1),
      coordinator(C2, ORG_B, 'pending', 2),
      coordinator(C3, ORG_A, 'active', 3),
    ]);
    for (const [id, n] of [
      [C1, 1],
      [C2, 2],
    ] as const) {
      await idp.createUser({
        email: `c${n}@x.org`,
        enabled: false,
        attributes: { [KC_ATTR.AGGREGATOR_ID]: id },
      });
    }

    const identities = getIdentityStore();
    for (const [user, sub] of [
      [NA, 'sub-na'],
      [OWNER_A, 'sub-a'],
      [OWNER_B, 'sub-b'],
      [OWNER_P, 'sub-p'],
      [C1, 'sub-c1'],
      [C3, 'sub-c3'],
    ] as const) {
      await identities.link(user, 'keycloak', sub);
    }

    _setUserStore(coordinators);
    _setOrganisationStore(orgs);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(new SignalStackWriterFake());
    _setRegistrationInvitesStore(new RegistrationInvitesStoreFake());
    _setConsoleWriteRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setInviteIpRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setAccessTokenVerifier(async (token) => {
      const claims = TOKENS[token];
      if (!claims) throw new Error('invalid token');
      return { azp: 'aggregator-portal', ...claims };
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
    _setRegistrationInvitesStore(null);
    _setConsoleWriteRateChecker(null);
    _setInviteIpRateChecker(null);
    _setAccessTokenVerifier(null);
    config.RBAC_CUSTOM_ROLES_ENABLED = savedCustomRoles;
  });

  const get = (url: string, who: keyof typeof TOKENS) =>
    app.inject({ method: 'GET', url, headers: auth(who) });
  const post = (url: string, who: keyof typeof TOKENS, payload: object) =>
    app.inject({ method: 'POST', url, headers: auth(who), payload });
  const patch = (url: string, who: keyof typeof TOKENS, payload: object) =>
    app.inject({ method: 'PATCH', url, headers: auth(who), payload });

  describe('the guard', () => {
    it('401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/user/read/me' });
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ['svc', 403, 'FORBIDDEN'],
      ['unlinked', 403, 'USER_NOT_PROVISIONED'],
      ['p', 403, 'NOT_ORG_ADMIN'],
      ['forged', 403, 'USER_NOT_PROVISIONED'],
    ] as const)('%s → %i %s', async (who, status, code) => {
      const res = await get('/v1/user/read/me', who);
      expect(res.statusCode).toBe(status);
      expect((res.json() as { error: { code: string } }).error.code).toBe(code);
    });

    it('refuses a pending coordinator with NOT_APPROVED', async () => {
      TOKENS.c1 = { sub: 'sub-c1', aggregator_id: C1 };
      const res = await get('/v1/user/read/me', 'c1' as keyof typeof TOKENS);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_APPROVED');
      delete TOKENS.c1;
    });

    it('refuses a coordinator on an admin route with 403', async () => {
      const res = await get(`/v1/user/read/${C1}`, 'coord');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /v1/user/read/me', () => {
    it('describes the network admin: root + Default, flagged', async () => {
      const res = await get('/v1/user/read/me', 'na');
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        kind: string;
        is_network_admin: boolean;
        orgs: Array<{ id: string; org_type: string; role: string }>;
        user: { contact: { email: string } };
      };
      expect(body.kind).toBe('admin');
      expect(body.is_network_admin).toBe(true);
      expect(body.orgs.map((o) => o.id).sort()).toEqual([ROOT, DEFAULT].sort());
      expect(body.user.contact.email).toBe('na@net.org');
    });

    it('describes an owner: its org only, not the network admin', async () => {
      const body = (await get('/v1/user/read/me', 'a')).json() as {
        is_network_admin: boolean;
        orgs: Array<{ id: string; role: string }>;
      };
      expect(body.is_network_admin).toBe(false);
      expect(body.orgs).toEqual([expect.objectContaining({ id: ORG_A, role: 'owner' })]);
    });

    it('describes an approved coordinator as a member of its org', async () => {
      const body = (await get('/v1/user/read/me', 'coord')).json() as {
        kind: string;
        orgs: Array<{ id: string; role: string }>;
        user: { contact: { email: string } };
      };
      expect(body.kind).toBe('coordinator');
      expect(body.orgs).toEqual([expect.objectContaining({ id: ORG_A, role: 'member' })]);
      expect(body.user.contact.email).toBe('c3@x.org');
    });
  });

  describe('reach', () => {
    it.each([
      ['a', C1, 200],
      ['a', C2, 404],
      // The network admin does not see the coordinators of the orgs under it.
      ['na', C2, 404],
      ['b', C1, 404],
    ] as const)('%s reads coordinator %s → %i', async (who, id, status) => {
      expect((await get(`/v1/user/read/${id}`, who)).statusCode).toBe(status);
    });

    it.each([
      ['a', ORG_A, 200],
      ['a', ORG_B, 404],
      ['a', ROOT, 404],
      ['na', ROOT, 200],
      ['na', ORG_B, 200],
    ] as const)('%s reads org %s → %i', async (who, id, status) => {
      expect((await get(`/v1/org/read/${id}`, who)).statusCode).toBe(status);
    });

    it('reads the root as the network facilitator, with owner and counts', async () => {
      const body = (await get(`/v1/org/read/${ORG_A}`, 'a')).json() as {
        org: { org_type: string };
        coordinator_count: number;
        pending_count: number;
        owner: { id: string };
      };
      expect(body.org.org_type).toBe('aggregator');
      expect(body.coordinator_count).toBe(2);
      expect(body.pending_count).toBe(1);
      expect(body.owner.id).toBe(OWNER_A);
      const root = (await get(`/v1/org/read/${ROOT}`, 'na')).json() as {
        org: { org_type: string };
      };
      expect(root.org.org_type).toBe('network_facilitator');
    });

    it("returns known_as with its name from the parent's list; depth 0 for the root; Aggregator for a stale key", async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_A, { parentId: ROOT, knownAs: 'state', knownAsValues: [BLOCK] });
      type Read = {
        org: { known_as: string | null; known_as_name: string | null; depth: number };
        child_count: number;
      };
      const a = (await get(`/v1/org/read/${ORG_A}`, 'a')).json() as Read;
      expect(a.org).toMatchObject({ known_as: 'state', known_as_name: 'State', depth: 1 });
      expect(a.child_count).toBe(0);
      const root = (await get(`/v1/org/read/${ROOT}`, 'na')).json() as Read;
      expect(root.org).toMatchObject({ known_as: null, known_as_name: null, depth: 0 });
      await setOrg(ORG_A, { knownAs: 'retired_key' });
      const stale = (await get(`/v1/org/read/${ORG_A}`, 'a')).json() as Read;
      expect(stale.org).toMatchObject({ known_as: 'retired_key', known_as_name: 'Aggregator' });
    });

    it('leaves out known_as_values and parent without fields, and reads nothing for them', async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_A, { parentId: ROOT, knownAsValues: [BLOCK] });
      const lists = vi.spyOn(orgs, 'knownAsValues');
      for (const url of [`/v1/org/read/${ORG_A}`, `/v1/org/read/${ORG_A}?fields=`]) {
        const res = await get(url, 'na');
        expect(res.statusCode).toBe(200);
        const body = res.json() as Record<string, unknown> & { org: Record<string, unknown> };
        expect(body).not.toHaveProperty('known_as_values');
        expect(body.org).not.toHaveProperty('known_as_values');
        expect(body.org).not.toHaveProperty('parent');
      }
      expect(lists).not.toHaveBeenCalled();
    });

    it('adds only the fields that are requested', async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_A, { parentId: ROOT, parentName: 'The Network', knownAsValues: [BLOCK] });
      type Body = Record<string, unknown> & { org: Record<string, unknown> };
      const both = (
        await get(`/v1/org/read/${ORG_A}?fields=known_as_values,parent.known_as_values`, 'na')
      ).json() as Body;
      expect(both.org['known_as_values']).toEqual([BLOCK]);
      expect(both.org['parent']).toEqual({
        id: ROOT,
        name: 'The Network',
        known_as_values: [STATE],
      });
      expect(both).not.toHaveProperty('known_as_values');
      expect(both).not.toHaveProperty('parent');
      const values = (
        await get(`/v1/org/read/${ORG_A}?fields=known_as_values`, 'na')
      ).json() as Body;
      expect(values.org['known_as_values']).toEqual([BLOCK]);
      expect(values.org).not.toHaveProperty('parent');
      const lists = vi.spyOn(orgs, 'knownAsValues');
      const parent = (
        await get(`/v1/org/read/${ORG_A}?fields=parent.known_as_values`, 'na')
      ).json() as Body;
      expect(parent.org['parent']).toMatchObject({ known_as_values: [STATE] });
      expect(parent.org).not.toHaveProperty('known_as_values');
      // Only the parent's list is read.
      expect(lists.mock.calls).toEqual([[ROOT]]);
    });

    it.each([
      'children',
      'known_as_values,',
      'known_as_values,owner',
      'known_as_options',
      'known_as_values,known_as_options',
      'parent',
      'parent.name',
    ])('refuses fields=%s (400 SCHEMA_VALIDATION)', async (fields) => {
      const res = await get(`/v1/org/read/${ORG_A}?fields=${fields}`, 'a');
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('returns the parent block only to the owner of the parent', async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_A, { parentId: ROOT, parentName: 'The Network', knownAsValues: [] });
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      type Read = { org: { parent?: unknown } };
      const read = async (id: string, who: keyof typeof TOKENS) =>
        ((await get(`/v1/org/read/${id}?fields=parent.known_as_values`, who)).json() as Read).org
          .parent;
      // The network admin owns the root, the parent of Alpha.
      expect(await read(ORG_A, 'na')).toEqual({
        id: ROOT,
        name: 'The Network',
        known_as_values: [STATE],
      });
      // Alpha's own owner does not pick its value.
      expect(await read(ORG_A, 'a')).toBeNull();
      // Alpha's owner picks Beta's; Alpha has no list, so the list is empty.
      expect(await read(ORG_B, 'a')).toEqual({ id: ORG_A, name: 'Alpha', known_as_values: [] });
      expect(await read(ORG_B, 'b')).toBeNull();
      // Beta is two levels below the network now, so the network admin does not see it.
      expect((await get(`/v1/org/read/${ORG_B}`, 'na')).statusCode).toBe(404);
      expect(await read(ROOT, 'na')).toBeNull();
      expect(await read(DEFAULT, 'na')).toBeNull();
      // A rejected org is not changed.
      await setOrg(ORG_B, { status: 'inactive' });
      expect(await read(ORG_B, 'a')).toBeNull();
    });

    it('answers 503 when the parent list cannot be read', async () => {
      useHierarchy();
      await setOrg(ORG_A, { parentId: ROOT, parentName: 'The Network' });
      vi.spyOn(orgs, 'knownAsValues').mockResolvedValueOnce(storeErr());
      expect(
        (await get(`/v1/org/read/${ORG_A}?fields=parent.known_as_values`, 'na')).statusCode,
      ).toBe(503);
    });

    it('reads known_as_values as null at max_depth and for the Default org', async () => {
      useHierarchy({ max_depth: 2 });
      await setOrg(ORG_A, { knownAsValues: [BLOCK] });
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      type Read = { org: { known_as_values: unknown } };
      const values = async (id: string, who: keyof typeof TOKENS) =>
        ((await get(`/v1/org/read/${id}?fields=known_as_values`, who)).json() as Read).org
          .known_as_values;
      expect(await values(ORG_A, 'a')).toEqual([BLOCK]);
      expect(await values(ORG_B, 'b')).toBeNull();
      expect(await values(DEFAULT, 'na')).toBeNull();
      expect(await values(ROOT, 'na')).toEqual([]);
    });

    it('answers 503 when a requested list cannot be read', async () => {
      useHierarchy();
      vi.spyOn(orgs, 'knownAsValues').mockResolvedValueOnce(storeErr());
      expect((await get(`/v1/org/read/${ORG_A}?fields=known_as_values`, 'a')).statusCode).toBe(503);
    });
  });

  describe('POST /v1/user/search', () => {
    const ids = (res: { json: () => unknown }) =>
      (res.json() as { users: Array<{ id: string }> }).users.map((u) => u.id).sort();

    it('scopes an owner to its org, and the network admin to the orgs it owns', async () => {
      expect(ids(await post('/v1/user/search', 'a', {}))).toEqual([C1, C3].sort());
      // The network admin owns the root and the Default org; neither has a coordinator here.
      expect(ids(await post('/v1/user/search', 'na', {}))).toEqual([]);
    });

    it('answers an out-of-reach org_id with an empty page', async () => {
      const res = await post('/v1/user/search', 'a', { filter: { org_id: ORG_B } });
      expect(res.statusCode).toBe(200);
      expect(ids(res)).toEqual([]);
    });

    it('pages with an opaque cursor', async () => {
      const first = (await post('/v1/user/search', 'a', { limit: 1 })).json() as {
        users: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(first.users.map((u) => u.id)).toEqual([C3]);
      expect(first.next_cursor).not.toBeNull();
      const second = (
        await post('/v1/user/search', 'a', { limit: 1, cursor: first.next_cursor })
      ).json() as { users: Array<{ id: string }>; next_cursor: string | null };
      expect(second.users.map((u) => u.id)).toEqual([C1]);
      expect(second.next_cursor).toBeNull();
    });

    it('refuses a malformed cursor with 400', async () => {
      const res = await post('/v1/user/search', 'na', { cursor: 'not-a-cursor' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/user/decision/:id', () => {
    it('lets the owner approve its coordinator, then answers ALREADY_DECIDED', async () => {
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: C1, status: 'active' });
      const row = await coordinators.findById(C1);
      expect(row.ok && row.value?.status).toBe('active');
      expect(row.ok && row.value?.updatedBy).toBe(OWNER_A);

      const again = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'reject' });
      expect(again.statusCode).toBe(409);
      const err = (again.json() as { error: { code: string; fields: Record<string, unknown> } })
        .error;
      expect(err.code).toBe('ALREADY_DECIDED');
      expect(err.fields).toMatchObject({ status: 'active', decided_by: 'console' });
    });

    it("answers 404 for another org's coordinator", async () => {
      const res = await post(`/v1/user/decision/${C2}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(404);
      const row = await coordinators.findById(C2);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it("does not let the network admin decide another org's coordinator (404)", async () => {
      const res = await post(`/v1/user/decision/${C2}`, 'na', {
        decision: 'reject',
        reason: 'incomplete',
      });
      expect(res.statusCode).toBe(404);
      const row = await coordinators.findById(C2);
      expect(row.ok && row.value?.status).toBe('pending');
      expect(mailer.outbox.find((m) => m.to === 'b@b.org')).toBeUndefined();
    });

    it('answers 429 when the console write budget is spent', async () => {
      _setConsoleWriteRateChecker(async () => ({ allowed: false, retryAfterSeconds: 30 }));
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
    });
  });

  describe('PATCH /v1/user/metadata/update/:id', () => {
    it('sets the served domains', async () => {
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { serves: string[] }).serves).toEqual(['seeker']);
    });

    it('refuses a domain the network does not have', async () => {
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['pilot'] });
      expect(res.statusCode).toBe(400);
    });

    it('answers 404 out of reach', async () => {
      const res = await patch(`/v1/user/metadata/update/${C2}`, 'a', { serves: [] });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /v1/user/create (invite)', () => {
    it('invites into the owner’s org', async () => {
      const res = await post('/v1/user/create', 'a', {
        org_id: ORG_A,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { sent: number }).sent).toBe(1);
    });

    it('answers 404 for an org out of reach', async () => {
      const res = await post('/v1/user/create', 'a', {
        org_id: ORG_B,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses the Default org, even for the network admin (R8)', async () => {
      const res = await post('/v1/user/create', 'na', {
        org_id: DEFAULT,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /v1/org/search', () => {
    const ids = (res: { json: () => unknown }) =>
      (res.json() as { orgs: Array<{ id: string }> }).orgs.map((o) => o.id).sort();

    it('scopes an owner to its org; the network admin sees every aggregator org', async () => {
      expect(ids(await post('/v1/org/search', 'a', {}))).toEqual([ORG_A]);
      expect(ids(await post('/v1/org/search', 'na', {}))).toEqual(
        [DEFAULT, ORG_A, ORG_B, ORG_P].sort(),
      );
    });

    it('filters by status', async () => {
      expect(ids(await post('/v1/org/search', 'na', { filter: { status: 'pending' } }))).toEqual([
        ORG_P,
      ]);
    });

    it("returns each org's known_as name from its parent's list", async () => {
      await setRootList([STATE]);
      await setOrg(ORG_B, { parentId: ROOT, knownAs: 'state' });
      const res = await post('/v1/org/search', 'na', { filter: { name_prefix: 'Beta' } });
      const body = res.json() as { orgs: Array<{ id: string; known_as_name: string | null }> };
      expect(body.orgs.map((o) => [o.id, o.known_as_name])).toEqual([[ORG_B, 'State']]);
    });

    it('refuses a known_as filter (400)', async () => {
      const res = await post('/v1/org/search', 'na', { filter: { known_as: 'state' } });
      expect(res.statusCode).toBe(400);
    });

    describe('descendants_of and parent_id', () => {
      // ROOT → Alpha (ORG_A) → Beta (ORG_B) → Pending Org (ORG_P).
      beforeEach(async () => {
        for (const [id, parentId, parentName] of [
          [ORG_A, ROOT, 'The Network'],
          [ORG_B, ORG_A, 'Alpha'],
          [ORG_P, ORG_B, 'Beta'],
        ] as const) {
          const r = await orgs.findById(id);
          if (!r.ok || !r.value) throw new Error('seed');
          orgs.seed([{ ...r.value, parentId, parentName }]);
        }
      });
      const below = (token: string, id: string) =>
        post('/v1/org/search', token, { filter: { descendants_of: id } });
      const children = (token: string, id: string) =>
        post('/v1/org/search', token, { filter: { parent_id: id } });

      it('lists only the direct children below an owned org, never deeper', async () => {
        const res = await below('a', ORG_A);
        expect(res.statusCode).toBe(200);
        const body = res.json() as { orgs: Array<{ id: string; parent_name: string | null }> };
        expect(body.orgs.map((o) => [o.id, o.parent_name])).toEqual([[ORG_B, 'Alpha']]);
      });

      it('lists only the orgs below a lower org', async () => {
        expect(ids(await below('b', ORG_B))).toEqual([ORG_P]);
      });

      it('answers an empty page below an org out of reach', async () => {
        expect(ids(await below('b', ORG_A))).toEqual([]);
      });

      it('gives the network admin nothing below a top-level org', async () => {
        expect(ids(await below('na', ORG_A))).toEqual([]);
      });

      it('narrows with the other filters', async () => {
        const res = await post('/v1/org/search', 'b', {
          filter: { descendants_of: ORG_B, status: 'pending' },
        });
        expect(ids(res)).toEqual([ORG_P]);
      });

      it('lists the direct children of an owned org with parent_id', async () => {
        expect(ids(await children('a', ORG_A))).toEqual([ORG_B]);
        expect(ids(await children('b', ORG_B))).toEqual([ORG_P]);
        const top = ids(await children('na', ROOT));
        expect(top).toContain(ORG_A);
        expect(top).not.toContain(ORG_B);
      });

      it('never returns a grandchild, whatever filter is sent', async () => {
        // A child's children, an edited filter and no filter all stop at one level.
        expect(ids(await children('a', ORG_B))).toEqual([]);
        expect(ids(await children('a', ORG_P))).toEqual([]);
        expect(ids(await post('/v1/org/search', 'a', {}))).not.toContain(ORG_P);
        expect(ids(await post('/v1/org/search', 'na', {}))).not.toContain(ORG_B);
        expect((await get(`/v1/org/read/${ORG_P}`, 'a')).statusCode).toBe(404);
        expect((await get(`/v1/org/read/${ORG_B}`, 'na')).statusCode).toBe(404);
      });

      it('refuses descendants_of and parent_id together (400)', async () => {
        const res = await post('/v1/org/search', 'a', {
          filter: { descendants_of: ORG_A, parent_id: ORG_A },
        });
        expect(res.statusCode).toBe(400);
      });

      it('lets an owner read its direct children, but not edit them', async () => {
        expect(ids(await post('/v1/org/search', 'a', {}))).toEqual([ORG_A, ORG_B].sort());
        expect((await get(`/v1/org/read/${ORG_B}`, 'a')).statusCode).toBe(200);
        const edit = await patch(`/v1/org/metadata/update/${ORG_B}`, 'a', { legal_name: null });
        expect(edit.statusCode).toBe(403);
      });

      it('refuses a descendants_of that is not a uuid (400)', async () => {
        const res = await post('/v1/org/search', 'a', { filter: { descendants_of: 'alpha' } });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  describe('PATCH /v1/org/metadata/update/:id', () => {
    /** The org's stored profile, read straight from the store. */
    async function storedProfile(): Promise<Record<string, unknown>> {
      const found = await orgs.findById(ORG_A);
      if (!found.ok || !found.value) throw new Error('org missing');
      return found.value.profile;
    }

    it('lets the owner edit the fixed fields', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        legal_name: 'Alpha Pvt Ltd',
        description: '  Skilled trade jobs for rural seekers.  ',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        legal_name: 'Alpha Pvt Ltd',
        description: 'Skilled trade jobs for rural seekers.',
      });
    });

    it('lets the owner rename, keeping the slug', async () => {
      const before = await orgs.findById(ORG_A);
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { name: 'Alpha Two' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { name: string; slug: string };
      expect(body.name).toBe('Alpha Two');
      expect(body.slug).toBe(before.ok ? before.value?.slug : undefined);
    });

    it('refuses the network admin a rename of another owner’s org (403), with no email', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'na', { name: 'Alpha Two' });
      expect(res.statusCode).toBe(403);
      const after = await orgs.findById(ORG_A);
      expect(after.ok ? after.value?.displayName : undefined).not.toBe('Alpha Two');
      expect(mailer.outbox.find((m) => m.to === 'a@a.org')).toBeUndefined();
    });

    it('answers ORG_NAME_TAKEN for a duplicate name', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { name: 'beta' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_NAME_TAKEN');
    });

    it('never edits the Default org', async () => {
      const res = await patch(`/v1/org/metadata/update/${DEFAULT}`, 'na', {
        profile: { website: 'https://x.example.org' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses an empty body and an empty profile', async () => {
      expect((await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {})).statusCode).toBe(400);
      expect(
        (await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { profile: {} })).statusCode,
      ).toBe(400);
    });

    it('stores an empty description as none', async () => {
      await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { description: 'x' });
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { description: '   ' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ description: null });
    });

    it('sets the schema fields in profile and reads them back', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: {
          website: 'https://alpha.example.org',
          gst_number: ' 29abcde1234f1zw ',
          domains: ['seeker'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { profile: unknown }).profile).toMatchObject({
        website: 'https://alpha.example.org',
        gst_number: '29ABCDE1234F1ZW',
        domains: ['seeker'],
      });
      const read = (await get(`/v1/org/read/${ORG_A}`, 'a')).json() as {
        org: { profile: Record<string, unknown>; profile_ref: string | null };
      };
      expect(read.org.profile['gst_number']).toBe('29ABCDE1234F1ZW');
    });

    it('merges profile: keeps keys not sent, removes a key sent as null', async () => {
      await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { website: 'https://alpha.example.org', gst_number: '27AAPFU0939F1ZV' },
      });
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { website: null, domains: ['provider'] },
      });
      expect(res.statusCode).toBe(200);
      const profile = await storedProfile();
      expect(profile['website']).toBeUndefined();
      expect(profile['gst_number']).toBe('27AAPFU0939F1ZV');
      expect(profile['domains']).toEqual(['provider']);
    });

    it.each(['https://example.org', 'https://www.example.org/about?x=1'])(
      'accepts the website %s',
      async (website) => {
        const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { profile: { website } });
        expect(res.statusCode).toBe(200);
        expect((await storedProfile())['website']).toBe(website);
      },
    );

    it.each([
      'example.org',
      'www.example.org',
      'http://example.org',
      'https://localhost',
      'not a url',
    ])('refuses the website %s with the schema message, saving nothing', async (website) => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { profile: { website } });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: { code: string; fields: unknown } }).error;
      expect(error.code).toBe('SCHEMA_VALIDATION');
      expect(error.fields).toEqual({
        field_errors: { website: 'Please enter a website starting with https://' },
      });
      expect((await storedProfile())['website']).toBeUndefined();
    });

    it.each([
      ['a wrong check character', '29ABCDE1234F1Z5'],
      ['14 characters', '29ABCDE1234F1Z'],
      ['free text', 'hello'],
    ])('refuses a GSTIN with %s, saving nothing', async (_label, gst) => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { gst_number: gst },
      });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: { fields: unknown } }).error;
      expect(error.fields).toEqual({ field_errors: { gst_number: 'Please enter a valid GSTIN.' } });
      expect((await storedProfile())['gst_number']).toBeUndefined();
    });

    it('refuses a domain the network does not have, and duplicate domains', async () => {
      const unknown = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { domains: ['seeker', 'astronaut'] },
      });
      expect(unknown.statusCode).toBe(400);
      expect(
        Object.keys(
          (unknown.json() as { error: { fields: { field_errors: object } } }).error.fields
            .field_errors,
        ),
      ).toEqual(['domains']);
      const dup = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { domains: ['seeker', 'seeker'] },
      });
      expect(dup.statusCode).toBe(400);
    });

    it('refuses a field the schema does not mark editable', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { organisation_type: 'ngo' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { fields: unknown } }).error.fields).toEqual({
        field_errors: { organisation_type: 'is not an editable field' },
      });
    });

    it('names every bad field in one 400 and saves none of the body', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        name: 'Not Saved',
        profile: { website: 'http://example.org', gst_number: 'hello', domains: ['astronaut'] },
      });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: { fields: { field_errors: object } } }).error;
      expect(Object.keys(error.fields.field_errors).sort()).toEqual([
        'domains',
        'gst_number',
        'website',
      ]);
      const after = await orgs.findById(ORG_A);
      expect(after.ok && after.value?.displayName).not.toBe('Not Saved');
    });

    it('does not re-check a stored value when another field changes', async () => {
      await orgs.update(ORG_A, { profileMerge: { website: 'http://legacy.example.org' } });
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        profile: { gst_number: '27AAPFU0939F1ZV' },
      });
      expect(res.statusCode).toBe(200);
      expect((await storedProfile())['website']).toBe('http://legacy.example.org');
    });

    it('refuses an over-long description (400)', async () => {
      const long = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        description: 'x'.repeat(1001),
      });
      expect(long.statusCode).toBe(400);
    });

    it.each([
      ['name', { name: 'Alpha Two' }],
      ['locations', { locations: [] }],
      ['legal name', { legal_name: 'Alpha Pvt Ltd' }],
      ['description', { description: 'x' }],
      ['a schema field', { profile: { website: 'https://x.example.org' } }],
    ])("refuses the network admin's edit of another owner's %s (403)", async (_label, body) => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'na', body);
      expect(res.statusCode).toBe(403);
    });

    it('lets the owner change fixed and schema fields in one save', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        name: 'Alpha Two',
        legal_name: 'Alpha Pvt Ltd',
        description: 'About Alpha.',
        profile: {
          website: 'https://alpha.example.org',
          gst_number: '27AAPFU0939F1ZV',
          domains: ['provider', 'seeker'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Alpha Two',
        legal_name: 'Alpha Pvt Ltd',
        description: 'About Alpha.',
        profile: {
          website: 'https://alpha.example.org',
          gst_number: '27AAPFU0939F1ZV',
          domains: ['provider', 'seeker'],
        },
      });
    });

    it('refuses known_as, which has its own route (400)', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { known_as: 'state' });
      expect(res.statusCode).toBe(400);
    });

    it('refuses parent_id (400)', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { parent_id: ORG_B });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/org/known-as/update/:id', () => {
    // ROOT (State, District*) → Alpha (Block, Taluk) → Beta.
    beforeEach(async () => {
      useHierarchy();
      await setRootList([STATE, { ...DISTRICT, default: true }]);
      await setOrg(ORG_A, {
        parentId: ROOT,
        parentName: 'The Network',
        knownAsValues: [BLOCK, TALUK],
      });
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
    });
    const setKnownAs = (who: keyof typeof TOKENS, body: object, id = ORG_B) =>
      patch(`/v1/org/known-as/update/${id}`, who, body);
    const errorOf = (res: { json: () => unknown }) =>
      (res.json() as { error: { code: string; fields?: Record<string, unknown> } }).error;

    it("lets the parent's owner set a child's value and tells the child's owner", async () => {
      const res = await setKnownAs('a', { known_as: 'taluk' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_B, known_as: 'taluk', known_as_name: 'Taluk' });
      expect(res.json()).not.toHaveProperty('known_as_values');
      const notice = mailer.outbox.find((m) => m.to === 'b@b.org');
      expect(notice?.html).toContain('The owner of <strong>Alpha</strong> changed what');
      expect(notice?.html).not.toContain('Taluk');
      const stored = await orgs.findById(ORG_B);
      expect(stored.ok && stored.value?.updatedBy).toBe(OWNER_A);
    });

    it("lets the network admin set a top-level org's value from the network's list", async () => {
      const res = await setKnownAs('na', { known_as: 'state' }, ORG_A);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ known_as: 'state', known_as_name: 'State' });
      const notice = mailer.outbox.find((m) => m.to === 'a@a.org');
      expect(notice?.html).toContain(
        'network administrator made this change to <strong>Alpha</strong>: changed what the organisation is known as.',
      );
      expect(notice?.html).not.toContain('The owner of');
      expect(notice?.html).not.toContain('State');
    });

    it('answers 404 to the network admin on a depth-2 org, which it cannot see', async () => {
      expect((await setKnownAs('na', { known_as: 'taluk' })).statusCode).toBe(404);
    });

    it("refuses the org's own owner (403)", async () => {
      expect((await setKnownAs('b', { known_as: 'taluk' })).statusCode).toBe(403);
    });

    it('answers 404 for an org the caller cannot see', async () => {
      // Beta's owner sees Beta and the orgs below it, not Alpha.
      expect((await setKnownAs('b', { known_as: 'state' }, ORG_A)).statusCode).toBe(404);
      const unknown = '00000000-0000-4000-8000-0000000000ff';
      expect((await setKnownAs('na', { known_as: 'state' }, unknown)).statusCode).toBe(404);
    });

    it("refuses a key that is not in the parent's list (400 fields.known_as)", async () => {
      const res = await setKnownAs('a', { known_as: 'state' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'SCHEMA_VALIDATION',
        fields: { known_as: 'invalid' },
      });
      const stored = await orgs.findById(ORG_B);
      expect(stored.ok && stored.value?.knownAs).toBe('aggregator');
    });

    it('allows only aggregator when the parent list is empty', async () => {
      await setOrg(ORG_A, { knownAsValues: [] });
      expect((await setKnownAs('a', { known_as: 'block' })).statusCode).toBe(400);
      expect((await setKnownAs('a', { known_as: 'aggregator' })).statusCode).toBe(200);
    });

    it('refuses a malformed key (400)', async () => {
      expect((await setKnownAs('a', { known_as: 'Bad-Key' })).statusCode).toBe(400);
    });

    it('sends no email when the caller also owns the child', async () => {
      await setOrg(ORG_P, {
        parentId: ORG_A,
        parentName: 'Alpha',
        depth: 2,
        ownerUserId: OWNER_A,
        ownerEmail: 'a@a.org',
      });
      const res = await setKnownAs('a', { known_as: 'block' }, ORG_P);
      expect(res.statusCode).toBe(200);
      expect(mailer.outbox).toHaveLength(0);
    });

    it.each([
      ['the network', ROOT],
      ['the Default org', DEFAULT],
    ])('refuses %s (409)', async (_label, id) => {
      expect((await setKnownAs('na', { known_as: 'state' }, id)).statusCode).toBe(409);
    });

    it('answers 200 with no write and no email when the key is the current one', async () => {
      await setOrg(ORG_B, { knownAs: 'taluk' });
      const write = vi.spyOn(orgs, 'setKnownAs');
      const res = await setKnownAs('a', { known_as: 'taluk' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_B, known_as: 'taluk', known_as_name: 'Taluk' });
      expect(write).not.toHaveBeenCalled();
      expect(mailer.outbox).toHaveLength(0);
    });

    it('refuses a rejected org (409)', async () => {
      await setOrg(ORG_B, { status: 'inactive' });
      expect((await setKnownAs('a', { known_as: 'block' })).statusCode).toBe(409);
    });

    it('answers 409 moved when the org moved after the check', async () => {
      vi.spyOn(orgs, 'setKnownAs').mockResolvedValueOnce(storeErr('ORG_MOVED'));
      const res = await setKnownAs('a', { known_as: 'block' });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'CONFLICT', fields: { reason: 'moved' } });
    });

    it('answers 503 when the store fails', async () => {
      vi.spyOn(orgs, 'setKnownAs').mockResolvedValueOnce(storeErr());
      expect((await setKnownAs('a', { known_as: 'block' })).statusCode).toBe(503);
    });
  });

  describe('PATCH /v1/org/known-as/update/:id with known_as_values', () => {
    // ROOT → Alpha (Block, Taluk) → Beta (block), Pending Org (taluk).
    beforeEach(async () => {
      useHierarchy();
      await setOrg(ORG_A, {
        parentId: ROOT,
        parentName: 'The Network',
        knownAsValues: [BLOCK, TALUK],
      });
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha', depth: 2, knownAs: 'block' });
      await setOrg(ORG_P, { parentId: ORG_A, parentName: 'Alpha', depth: 2, knownAs: 'taluk' });
    });
    const setList = (who: keyof typeof TOKENS, values: object[], id = ORG_A) =>
      patch(`/v1/org/known-as/update/${id}`, who, { known_as_values: values });
    const errorOf = (res: { json: () => unknown }) =>
      (res.json() as { error: { code: string; fields?: Record<string, unknown> } }).error;
    const knownAsOf = async (id: string) => {
      const r = await orgs.findById(id);
      return r.ok ? [r.value?.knownAs, r.value?.knownAsName] : null;
    };

    it('makes keys for new entries and keeps the keys sent back', async () => {
      const res = await setList('a', [
        { key: 'block', name: 'Block' },
        { name: 'जिला' },
        { name: 'Block!' },
      ]);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { known_as_values: unknown }).known_as_values).toEqual([
        BLOCK,
        { key: 'jila', name: 'जिला' },
        { key: 'block_2', name: 'Block!' },
      ]);
    });

    it('resets children whose value left the list to the new default, and sends no email', async () => {
      const res = await setList('a', [BLOCK, { name: 'Ward', default: true }]);
      expect(res.statusCode).toBe(200);
      expect(await knownAsOf(ORG_B)).toEqual(['block', 'Block']);
      expect(await knownAsOf(ORG_P)).toEqual(['ward', 'Ward']);
      expect(res.json()).toMatchObject({ reset_count: 1 });
      expect(mailer.outbox).toHaveLength(0);
    });

    it('resets to aggregator when the list has no default', async () => {
      expect((await setList('a', [])).statusCode).toBe(200);
      expect(await knownAsOf(ORG_B)).toEqual(['aggregator', 'Aggregator']);
      expect(await knownAsOf(ORG_P)).toEqual(['aggregator', 'Aggregator']);
    });

    it('renames an entry: children keep the key and read the new name', async () => {
      expect((await setList('a', [{ key: 'block', name: 'Mandal' }, TALUK])).statusCode).toBe(200);
      expect(await knownAsOf(ORG_B)).toEqual(['block', 'Mandal']);
    });

    it('refuses a key that is not saved (400 unknown_key) and writes nothing', async () => {
      const res = await setList('a', [{ name: 'New' }, { key: 'made_up', name: 'X' }]);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'SCHEMA_VALIDATION',
        fields: { known_as_values: 'unknown_key', index: 1 },
      });
      const a = await orgs.knownAsValues(ORG_A);
      expect(a.ok && a.value).toEqual([BLOCK, TALUK]);
    });

    it('gives a re-added name a new key and resets the children of the removed entry', async () => {
      const res = await setList('a', [BLOCK, { name: 'Taluk' }]);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { known_as_values: unknown }).known_as_values).toEqual([
        BLOCK,
        { key: 'taluk_2', name: 'Taluk' },
      ]);
      expect(await knownAsOf(ORG_P)).toEqual(['aggregator', 'Aggregator']);
      expect(await knownAsOf(ORG_B)).toEqual(['block', 'Block']);
    });

    it.each([
      ['a duplicate key', [BLOCK, { key: 'block', name: 'Again' }]],
      ['a duplicate name', [BLOCK, { name: ' block ' }]],
      [
        'two defaults',
        [
          { name: 'A', default: true },
          { name: 'B', default: true },
        ],
      ],
      ['too many entries', Array.from({ length: 21 }, (_, i) => ({ name: `V${i}` }))],
      ['a malformed key', [{ key: 'Bad-Key', name: 'Bad' }]],
      ['an empty name', [{ name: '   ' }]],
      ['default: false', [{ name: 'A', default: false }]],
    ])('refuses %s (400)', async (_label, values) => {
      expect((await setList('a', values)).statusCode).toBe(400);
    });

    it("lets the network admin write the network's list", async () => {
      const res = await setList('na', [{ name: 'State', default: true }], ROOT);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        org_type: 'network_facilitator',
        known_as_values: [{ key: 'state', name: 'State', default: true }],
      });
      // Alpha's aggregator value is kept.
      expect(await knownAsOf(ORG_A)).toEqual(['aggregator', 'Aggregator']);
      const h = (await get('/v1/org/hierarchy?fields=known_as_values', 'na')).json() as {
        network: { known_as_values: unknown };
      };
      expect(h.network.known_as_values).toEqual([{ key: 'state', name: 'State', default: true }]);
    });

    it('refuses the network admin on an org it does not own (403)', async () => {
      expect((await setList('na', [])).statusCode).toBe(403);
    });

    it('refuses an owner on an org below its own (403) and out of reach (404)', async () => {
      expect((await setList('a', [], ORG_B)).statusCode).toBe(403);
      expect((await setList('b', [], ORG_A)).statusCode).toBe(404);
      expect((await setList('a', [], ROOT)).statusCode).toBe(404);
    });

    it('refuses the Default org (409)', async () => {
      expect((await setList('na', [], DEFAULT)).statusCode).toBe(409);
    });

    it('answers 503 when the store fails', async () => {
      vi.spyOn(orgs, 'setKnownAsValues').mockResolvedValueOnce(storeErr());
      expect((await setList('a', [])).statusCode).toBe(503);
    });

    it.each([
      ['both fields', { known_as: 'block', known_as_values: [] }],
      ['neither field', {}],
      ['the list under another name', { values: [] }],
    ])('refuses a body with %s (400)', async (_label, body) => {
      const res = await patch(`/v1/org/known-as/update/${ORG_A}`, 'a', body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('SCHEMA_VALIDATION');
    });
  });

  describe('PATCH /v1/org/parent/update/:id', () => {
    // Beta is a State under the network; Alpha is an Aggregator under the network.
    beforeEach(async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_B, { knownAs: 'state', parentId: ROOT, parentName: 'The Network' });
      await setOrg(ORG_A, { parentId: ROOT, parentName: 'The Network' });
    });
    const move = (who: keyof typeof TOKENS, body: object, id = ORG_A) =>
      patch(`/v1/org/parent/update/${id}`, who, body);
    const errorOf = (res: { json: () => unknown }) =>
      (res.json() as { error: { code: string; fields?: Record<string, unknown> } }).error;

    it('moves the org under a new parent and tells the owner', async () => {
      const res = await move('na', { parent_id: ORG_B });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: ORG_A,
        parent_id: ORG_B,
        parent_name: 'Beta',
        depth: 2,
      });
      const notice = mailer.outbox.find((m) => m.to === 'a@a.org');
      expect(notice?.html).toContain('moved it under Beta');
    });

    it('keeps a key the new parent has and takes the default for one it lacks', async () => {
      await setOrg(ORG_B, { knownAsValues: [BLOCK, { ...TALUK, default: true }] });
      await setOrg(ORG_A, { knownAs: 'block' });
      const kept = await move('na', { parent_id: ORG_B });
      expect(kept.json()).toMatchObject({ known_as: 'block', known_as_name: 'Block', depth: 2 });
      await setOrg(ORG_P, { status: 'active', parentId: ROOT, knownAs: 'state' });
      const reset = await move('na', { parent_id: ORG_B }, ORG_P);
      expect(reset.json()).toMatchObject({ known_as: 'taluk', known_as_name: 'Taluk' });
    });

    it('does not tell the owner when nothing moved', async () => {
      const res = await move('na', { parent_id: ROOT });
      expect(res.statusCode).toBe(200);
      expect(mailer.outbox.find((m) => m.to === 'a@a.org')).toBeUndefined();
    });

    it('refuses known_as in the body (400)', async () => {
      const res = await move('na', { parent_id: ORG_B, known_as: 'state' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('SCHEMA_VALIDATION');
    });

    it('answers 404 for an unknown org', async () => {
      const res = await move('na', { parent_id: ORG_B }, '00000000-0000-4000-8000-0000000000ff');
      expect(res.statusCode).toBe(404);
    });

    it('refuses the Default org with CONFLICT not_movable', async () => {
      const res = await move('na', { parent_id: ORG_B }, DEFAULT);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'CONFLICT', fields: { reason: 'not_movable' } });
    });

    it('answers CONFLICT busy when the org row is locked', async () => {
      vi.spyOn(orgs, 'move').mockResolvedValueOnce(storeErr('ORG_BUSY'));
      const res = await move('na', { parent_id: ORG_B });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'CONFLICT', fields: { reason: 'busy' } });
    });

    it.each([
      ['a pending org', ORG_P],
      ['the Default org', DEFAULT],
    ])('refuses %s as parent (400 parent_id invalid)', async (_c, parentId) => {
      const res = await move('na', { parent_id: parentId });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'SCHEMA_VALIDATION',
        fields: { parent_id: 'invalid' },
      });
    });

    it('refuses an org or a new parent the network admin cannot see (404)', async () => {
      await setOrg(ORG_B, {
        knownAs: 'aggregator',
        parentId: ORG_A,
        parentName: 'Alpha',
        depth: 2,
      });
      // Beta is two levels down now: neither moved nor used as a parent.
      expect((await move('na', { parent_id: ORG_B })).statusCode).toBe(404);
      expect((await move('na', { parent_id: ROOT }, ORG_B)).statusCode).toBe(404);
      const after = await orgs.findById(ORG_A);
      expect(after.ok && after.value?.parentId).toBe(ROOT);
    });

    it('refuses a full parent with ORG_CHILD_LIMIT', async () => {
      useHierarchy({ max_children: 1 });
      await setOrg(ORG_P, { parentId: ORG_B, depth: 2 });
      const res = await move('na', { parent_id: ORG_B });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('ORG_CHILD_LIMIT');
    });

    it('refuses a parent at max_depth with ORG_DEPTH_LIMIT', async () => {
      useHierarchy({ max_depth: 1 });
      const res = await move('na', { parent_id: ORG_B });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('ORG_DEPTH_LIMIT');
    });

    it('is the network admin’s only (403 for an owner)', async () => {
      expect((await move('a', { parent_id: ORG_B })).statusCode).toBe(403);
    });

    it('answers 503 when the store fails', async () => {
      vi.spyOn(orgs, 'move').mockResolvedValueOnce(storeErr());
      expect((await move('na', { parent_id: ORG_B })).statusCode).toBe(503);
    });
  });

  describe('GET /v1/org/parent/options/:id', () => {
    beforeEach(async () => {
      useHierarchy();
      await setRootList([STATE]);
      await setOrg(ORG_B, { knownAs: 'state', parentId: ROOT, parentName: 'The Network' });
      await setOrg(ORG_A, { parentId: ROOT, parentName: 'The Network' });
    });

    it('lists each candidate parent with the result a move would give', async () => {
      const res = await get(`/v1/org/parent/options/${ORG_A}`, 'na');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        subtree_size: 1,
        options: [
          { id: ROOT, name: 'The Network', depth: 0, known_as_name: null, ok: true, reason: null },
          { id: ORG_B, name: 'Beta', depth: 1, known_as_name: 'State', ok: true, reason: null },
          {
            id: DEFAULT,
            name: 'Default',
            depth: 1,
            known_as_name: 'Aggregator',
            ok: false,
            reason: 'INVALID_PARENT',
          },
          {
            id: ORG_P,
            name: 'Pending Org',
            depth: 1,
            known_as_name: 'Aggregator',
            ok: false,
            reason: 'INVALID_PARENT',
          },
        ],
      });
    });

    it('answers 404 for an unknown org', async () => {
      const res = await get('/v1/org/parent/options/00000000-0000-4000-8000-0000000000ff', 'na');
      expect(res.statusCode).toBe(404);
    });

    it('offers only parents within view, and answers 404 for an org out of view', async () => {
      await setOrg(ORG_P, { parentId: ORG_B, parentName: 'Beta', depth: 2 });
      const res = await get(`/v1/org/parent/options/${ORG_A}`, 'na');
      const ids = (res.json() as { options: Array<{ id: string }> }).options.map((o) => o.id);
      expect(ids).not.toContain(ORG_P);
      expect(ids).toContain(ORG_B);
      expect((await get(`/v1/org/parent/options/${ORG_P}`, 'na')).statusCode).toBe(404);
    });

    it('is the network admin’s only (403 for an owner)', async () => {
      expect((await get(`/v1/org/parent/options/${ORG_A}`, 'a')).statusCode).toBe(403);
    });

    it('answers 503 when the store fails', async () => {
      vi.spyOn(orgs, 'parentOptions').mockResolvedValueOnce(storeErr());
      expect((await get(`/v1/org/parent/options/${ORG_A}`, 'na')).statusCode).toBe(503);
    });
  });

  describe('child_count', () => {
    beforeEach(async () => {
      await setOrg(ORG_P, { parentId: ORG_A, depth: 2 });
    });

    it('reads the pending and active direct children of an owned org', async () => {
      const res = await get(`/v1/org/read/${ORG_A}`, 'a');
      expect((res.json() as { child_count: number }).child_count).toBe(1);
    });

    it('reports zero counts for an org the caller only views', async () => {
      const res = await get(`/v1/org/read/${ORG_A}`, 'na');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ coordinator_count: 0, pending_count: 0, child_count: 0 });
    });

    it('fills child_count on each search row and never includes known_as_values', async () => {
      await setOrg(ORG_A, { knownAsValues: [BLOCK] });
      const res = await post('/v1/org/search', 'a', {});
      type Row = { id: string; child_count: number; coordinator_count: number };
      const rows = (res.json() as { orgs: Row[] }).orgs;
      for (const row of rows) expect(row).not.toHaveProperty('known_as_values');
      expect(Object.fromEntries(rows.map((o) => [o.id, o.child_count]))).toEqual({
        [ORG_A]: 1,
        [ORG_P]: 0,
      });
      // The network admin only views Alpha, so its counts are zero.
      const na = (await post('/v1/org/search', 'na', {})).json() as { orgs: Row[] };
      const alpha = na.orgs.find((o) => o.id === ORG_A);
      expect(alpha).toMatchObject({ child_count: 0, coordinator_count: 0 });
    });

    it('answers 503 when the child counts cannot be read', async () => {
      vi.spyOn(orgs, 'childCounts').mockResolvedValueOnce(storeErr());
      expect((await get(`/v1/org/read/${ORG_A}`, 'na')).statusCode).toBe(503);
      vi.spyOn(orgs, 'childCounts').mockResolvedValueOnce(storeErr());
      expect((await post('/v1/org/search', 'na', {})).statusCode).toBe(503);
    });
  });

  describe('GET /v1/org/hierarchy', () => {
    beforeEach(() => {
      useHierarchy({ max_children: 10 });
    });

    it('shows the network, the limits and the org total; the list only on request', async () => {
      await setRootList([{ ...STATE, default: true }]);
      const lists = vi.spyOn(orgs, 'knownAsValues');
      const res = await get('/v1/org/hierarchy', 'na');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        network: { id: ROOT, name: 'The Network' },
        limits: { max_depth: 3, max_children: 10, max_total_orgs: 50 },
        total_orgs: 3,
      });
      expect(lists).not.toHaveBeenCalled();
      const withList = await get('/v1/org/hierarchy?fields=known_as_values', 'na');
      expect(withList.json()).toMatchObject({
        network: {
          id: ROOT,
          name: 'The Network',
          known_as_values: [{ ...STATE, default: true }],
        },
      });
    });

    it.each(['known_as_options', 'parent.known_as_values', 'everything'])(
      'refuses fields=%s (400 SCHEMA_VALIDATION)',
      async (fields) => {
        const res = await get(`/v1/org/hierarchy?fields=${fields}`, 'na');
        expect(res.statusCode).toBe(400);
        expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
      },
    );

    it('answers 503 when the requested list cannot be read', async () => {
      vi.spyOn(orgs, 'knownAsValues').mockResolvedValueOnce(storeErr());
      expect((await get('/v1/org/hierarchy?fields=known_as_values', 'na')).statusCode).toBe(503);
    });

    it('reports max_children as null when unset', async () => {
      useHierarchy();
      const res = await get('/v1/org/hierarchy', 'na');
      expect((res.json() as { limits: { max_children: unknown } }).limits.max_children).toBeNull();
    });

    it('is the network admin’s only (403 for an owner)', async () => {
      expect((await get('/v1/org/hierarchy', 'a')).statusCode).toBe(403);
    });

    it('answers 503 when the root cannot be read', async () => {
      vi.spyOn(orgs, 'findRoot').mockResolvedValue(storeErr());
      expect((await get('/v1/org/hierarchy', 'na')).statusCode).toBe(503);
    });

    it('answers 503 when the total cannot be read', async () => {
      vi.spyOn(orgs, 'countTotal').mockResolvedValueOnce(storeErr());
      expect((await get('/v1/org/hierarchy', 'na')).statusCode).toBe(503);
    });
  });

  describe('owners read their direct child orgs, read-only', () => {
    // Beta sits under Alpha: Alpha's owner (a) views Beta, but not its coordinator C2.
    beforeEach(async () => {
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha' });
    });
    type Users = { users: Array<{ id: string; contact: { email: string } }> };
    const emailOf = (res: { json: () => unknown }, id: string) =>
      (res.json() as Users).users.find((u) => u.id === id)?.contact.email;

    it('lists its own orgs and their direct children, never the one above', async () => {
      const ids = (res: { json: () => unknown }) =>
        (res.json() as { orgs: Array<{ id: string }> }).orgs.map((o) => o.id).sort();
      expect(ids(await post('/v1/org/search', 'a', {}))).toEqual([ORG_A, ORG_B].sort());
      expect(ids(await post('/v1/org/search', 'b', {}))).toEqual([ORG_B]);
    });

    it('reads an org below with its owner contact masked, but not an org above', async () => {
      const res = await get(`/v1/org/read/${ORG_B}`, 'a');
      expect(res.statusCode).toBe(200);
      const owner = (res.json() as { owner: { contact: { email: string } } }).owner;
      expect(owner.contact.email).not.toBe('b@b.org');
      expect((await get(`/v1/org/read/${ORG_A}`, 'b')).statusCode).toBe(404);
    });

    it('cannot edit a child org (403)', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_B}`, 'a', { legal_name: null });
      expect(res.statusCode).toBe(403);
    });

    it("lists only its own coordinators, never a child org's", async () => {
      const res = await post('/v1/user/search', 'a', {});
      const ids = (res.json() as Users).users.map((u) => u.id).sort();
      expect(ids).toEqual([C1, C3].sort());
      expect(emailOf(res, C1)).toBe('c1@x.org');
    });

    it('answers an empty page for the coordinators of a child org', async () => {
      const res = await post('/v1/user/search', 'a', { filter: { org_id: ORG_B } });
      expect((res.json() as Users).users).toEqual([]);
    });

    it("neither reads nor decides a child org's coordinator (404)", async () => {
      expect((await get(`/v1/user/read/${C2}`, 'a')).statusCode).toBe(404);
      const decide = await post(`/v1/user/decision/${C2}`, 'a', { decision: 'approve' });
      expect(decide.statusCode).toBe(404);
    });

    it('sees nothing of a sibling org', async () => {
      await setOrg(ORG_B, { parentId: ROOT, parentName: 'The Network' });
      expect((await get(`/v1/org/read/${ORG_B}`, 'a')).statusCode).toBe(404);
      const res = await post('/v1/user/search', 'a', { filter: { org_id: ORG_B } });
      expect((res.json() as Users).users).toEqual([]);
    });
  });

  describe('POST /v1/org/decision/:id and access repair', () => {
    it("is the parent's owner's only, for decisions and repair", async () => {
      // Pending Org and Alpha sit under the network, so only the network admin acts on them.
      expect(
        (await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' })).statusCode,
      ).toBe(404);
      expect((await post(`/v1/org/access/repair/${ORG_A}`, 'a', {})).statusCode).toBe(404);
    });

    it("lets a parent org's owner repair its direct child, and nobody else", async () => {
      await setOrg(ORG_B, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      await idp.createUser({ email: 'b@b.org', enabled: false, attributes: {} });
      expect((await post(`/v1/org/access/repair/${ORG_B}`, 'na', {})).statusCode).toBe(404);
      expect((await post(`/v1/org/access/repair/${ORG_B}`, 'b', {})).statusCode).toBe(404);
      const res = await post(`/v1/org/access/repair/${ORG_B}`, 'a', {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_B });
    });

    it("shows the pending child's owner contact unmasked to the parent owner who decides it", async () => {
      await setOrg(ORG_P, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      type Read = { owner: { contact: { email: string } } };
      const pending = (await get(`/v1/org/read/${ORG_P}`, 'a')).json() as Read;
      expect(pending.owner.contact.email).toBe('p@p.org');
      await setOrg(ORG_P, { status: 'active' });
      const active = (await get(`/v1/org/read/${ORG_P}`, 'a')).json() as Read;
      expect(active.owner.contact.email).not.toBe('p@p.org');
    });

    it("lets a parent org's owner decide its direct child, and nobody else", async () => {
      await setOrg(ORG_P, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      // The network admin does not see an org two levels down.
      expect(
        (await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'approve' })).statusCode,
      ).toBe(404);
      expect(
        (await post(`/v1/org/decision/${ORG_P}`, 'b', { decision: 'approve' })).statusCode,
      ).toBe(404);
      const res = await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_P, status: 'active' });
    });

    it('refuses a rejection without a reason (400) and leaves the org pending', async () => {
      const res = await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'reject' });
      expect(res.statusCode).toBe(400);
      const row = await orgs.findById(ORG_P);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('approves a pending org, then answers ALREADY_DECIDED', async () => {
      const res = await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_P, status: 'active', owner_access: 'no_login' });
      const again = await post(`/v1/org/decision/${ORG_P}`, 'na', {
        decision: 'reject',
        reason: 'duplicate',
      });
      expect(again.statusCode).toBe(409);
      expect(
        (again.json() as { error: { fields: { decided_by: string } } }).error.fields.decided_by,
      ).toBe('console');
    });

    it("repairs an active org's owner access", async () => {
      await idp.createUser({ email: 'a@a.org', enabled: false, attributes: {} });
      const res = await post(`/v1/org/access/repair/${ORG_A}`, 'na', {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_A });
    });

    it('rejects a pending org (inactive, owner_access none) and notes the reason', async () => {
      const res = await post(`/v1/org/decision/${ORG_P}`, 'na', {
        decision: 'reject',
        reason: 'duplicate',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_P, status: 'inactive', owner_access: 'none' });
    });

    it('answers 404 when the org to decide does not exist', async () => {
      const res = await post(`/v1/org/decision/${ORG_X}`, 'na', { decision: 'approve' });
      expect(res.statusCode).toBe(404);
    });

    it('answers 503 when the decision store is unavailable', async () => {
      orgs.findById = async () => storeErr();
      const res = await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'approve' });
      expect(res.statusCode).toBe(503);
    });

    it('refuses access repair on a non-active org (409)', async () => {
      const res = await post(`/v1/org/access/repair/${ORG_P}`, 'na', {});
      expect(res.statusCode).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  // Branch coverage: the DB-unavailable / not-found / decision-failure / rate-
  // limit paths the happy-path tests above don't reach. console-shared.ts is
  // covered through the /v1/user and /v1/org routes that call it.
  // ---------------------------------------------------------------------------

  const ORG_X = '00000000-0000-4000-8000-00000000000f'; // never seeded
  const C4 = '00000000-0000-4000-8000-0000000000c4'; // ORG_A, active, null contact
  const C5 = '00000000-0000-4000-8000-0000000000c5'; // ORG_A, pending
  const C6 = '00000000-0000-4000-8000-0000000000c6'; // ORG_A, rejected, null contact
  const C7 = '00000000-0000-4000-8000-0000000000c7'; // DEFAULT, pending

  describe('v1-user: store failures and not-found', () => {
    it('503 when loading the target coordinator fails (coordinatorInReach)', async () => {
      const orig = coordinators.findById.bind(coordinators);
      coordinators.findById = async (id: string) => (id === C1 ? storeErr() : orig(id));
      const res = await get(`/v1/user/read/${C1}`, 'na');
      expect(res.statusCode).toBe(503);
    });

    it('404 when inviting into an org that does not exist (loadOrg)', async () => {
      const res = await post('/v1/user/create', 'na', {
        org_id: ORG_X,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(404);
    });

    it('503 when loading the invite org fails (loadOrg)', async () => {
      orgs.findById = async () => storeErr();
      const res = await post('/v1/user/create', 'na', {
        org_id: DEFAULT,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(503);
    });

    it('503 when the coordinator search store fails', async () => {
      coordinators.search = async () => storeErr();
      const res = await post('/v1/user/search', 'na', {});
      expect(res.statusCode).toBe(503);
    });

    it('applies the status and served-domain filters', async () => {
      const res = await post('/v1/user/search', 'na', {
        filter: { status: 'active', serves: 'seeker' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('400 on a cursor whose created-at is not a date (decodeUserCursor)', async () => {
      const res = await post('/v1/user/search', 'na', {
        cursor: cursorOf({ c: 'not-a-date', i: 'x' }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('v1-user: read/me store and provisioning edges', () => {
    it('503 when the coordinator self-row lookup fails in read/me', async () => {
      let n = 0;
      const orig = coordinators.findById.bind(coordinators);
      coordinators.findById = async (id: string) => {
        if (id === C3) {
          n += 1;
          if (n >= 2) return storeErr();
        }
        return orig(id);
      };
      const res = await get('/v1/user/read/me', 'coord');
      expect(res.statusCode).toBe(503);
    });

    it('403 USER_NOT_PROVISIONED when the coordinator self-row has gone in read/me', async () => {
      let n = 0;
      const orig = coordinators.findById.bind(coordinators);
      coordinators.findById = async (id: string) => {
        if (id === C3) {
          n += 1;
          if (n >= 2) return { ok: true, value: null };
        }
        return orig(id);
      };
      const res = await get('/v1/user/read/me', 'coord');
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('USER_NOT_PROVISIONED');
    });

    it('fills null name and phone for a coordinator whose contact is sparse', async () => {
      coordinators.seed([
        {
          ...coordinator(C4, ORG_A, 'active', 4),
          contact: { email: 'c4@x.org' } as unknown as ReturnType<typeof coordinator>['contact'],
        },
      ]);
      await getIdentityStore().link(C4, 'keycloak', 'sub-c4');
      TOKENS.coord4 = { sub: 'sub-c4', preferred_username: 'c4@x.org', aggregator_id: C4 };
      const res = await get('/v1/user/read/me', 'coord4' as keyof typeof TOKENS);
      expect(res.statusCode).toBe(200);
      expect(
        (res.json() as { user: { contact: { name: null; phone: null } } }).user.contact,
      ).toMatchObject({
        name: null,
        phone: null,
      });
      delete TOKENS.coord4;
    });

    it('503 when resolving an owned org fails in read/me', async () => {
      orgs.findById = async () => storeErr();
      const res = await get('/v1/user/read/me', 'a');
      expect(res.statusCode).toBe(503);
    });

    it('403 USER_NOT_PROVISIONED when an admin resolves to no visible org in read/me', async () => {
      orgs.findById = async () => ({ ok: true, value: null });
      const res = await get('/v1/user/read/me', 'a');
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('USER_NOT_PROVISIONED');
    });
  });

  describe('v1-user: too-many-recipients', () => {
    it('400 when a request carries more than the per-request recipient cap', async () => {
      const recipients = Array.from({ length: 11 }, (_, i) => ({ email: `r${i}@x.org` }));
      const res = await post('/v1/user/create', 'a', { org_id: ORG_A, recipients });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('v1-user: metadata update signalstack and store edges', () => {
    it('updates with no signalstack writer configured', async () => {
      _setSignalStackWriter(null);
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(200);
    });

    it('updates an active coordinator to all domains when serves is empty', async () => {
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: [] });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { serves: string[] }).serves).toEqual([]);
    });

    it('502 when the signalstack push fails for an active coordinator', async () => {
      const ss = new SignalStackWriterFake();
      ss.upsertAggregator = async () => err(new UpstreamError('down', { code: 'SS_DOWN' }));
      _setSignalStackWriter(ss);
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'SIGNALSTACK_PUSH_FAILED',
      );
    });

    it('503 when the metadata store update fails', async () => {
      coordinators.update = async () => storeErr();
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(503);
    });

    it('502 when a coordinator is approved mid-update and the re-push fails', async () => {
      coordinators.seed([coordinator(C5, ORG_A, 'pending', 5)]);
      const ss = new SignalStackWriterFake();
      ss.upsertAggregator = async () => err(new UpstreamError('down', { code: 'SS_DOWN' }));
      _setSignalStackWriter(ss);
      coordinators.update = async () => ({
        ok: true,
        value: { ...coordinator(C5, ORG_A, 'active', 5), serves: ['seeker'] },
      });
      const res = await patch(`/v1/user/metadata/update/${C5}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'SIGNALSTACK_PUSH_FAILED',
      );
    });
  });

  describe('v1-user: decision-failure outcomes (console-shared throwDecisionFailure)', () => {
    it('409 TARGET_ORG_INACTIVE when the coordinator org is no longer active', async () => {
      // The owner still holds Alpha when the request starts; it is no longer active by the decision.
      const active = await orgs.findById(ORG_A);
      if (!active.ok || !active.value) throw new Error('seed');
      vi.spyOn(orgs, 'listOwnedBy').mockResolvedValue({ ok: true, value: [active.value] });
      orgs.seed([
        buildOrganisation({
          id: ORG_A,
          slug: 'org-a',
          displayName: 'Alpha',
          status: 'pending',
          ownerUserId: OWNER_A,
          ownerEmail: 'a@a.org',
          ownerKcSub: 'sub-a',
        }),
      ]);
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
    });

    it('502 SIGNALSTACK_PUSH_FAILED when the approval push fails', async () => {
      const ss = new SignalStackWriterFake();
      ss.upsertAggregator = async () => err(new UpstreamError('down', { code: 'SS_DOWN' }));
      _setSignalStackWriter(ss);
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(502);
    });

    it('503 IDP_UNAVAILABLE when enabling the Keycloak user fails on approval', async () => {
      idp.enableUser = async () => ({
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
      });
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(503);
    });

    it('503 DB_UNAVAILABLE when the approval compare-and-set fails', async () => {
      coordinators.approveFromPending = async () => storeErr();
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(503);
    });

    it('404 NOT_FOUND when the identity record is missing at decision time', async () => {
      idp.findByAttribute = async () => ({ ok: true, value: null });
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('console-shared notice and wire mapping edges', () => {
    it('still succeeds when the owner-notice email fails to send', async () => {
      mailer.send = async () => ({
        ok: false,
        error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
      });
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'reject', reason: 'x' });
      expect(res.statusCode).toBe(200);
    });

    it('skips the owner notice when the network admin acts in an org it owns', async () => {
      coordinators.seed([coordinator(C7, DEFAULT, 'pending', 7)]);
      await idp.createUser({
        email: 'c7@x.org',
        enabled: false,
        attributes: { [KC_ATTR.AGGREGATOR_ID]: C7 },
      });
      const res = await post(`/v1/user/decision/${C7}`, 'na', { decision: 'reject' });
      expect(res.statusCode).toBe(200);
      // The Default org's owner is the network admin; no self-notice is sent.
      expect(mailer.outbox.find((m) => m.to === 'na@net.org')).toBeUndefined();
    });

    it('maps a rejected coordinator with a sparse contact onto the wire', async () => {
      coordinators.seed([
        {
          ...coordinator(C6, ORG_A, 'inactive', 6),
          contact: { email: 'c6@x.org' } as unknown as ReturnType<typeof coordinator>['contact'],
          rejectedAt: new Date('2026-03-01T00:00:00Z'),
        },
      ]);
      const res = await get(`/v1/user/read/${C6}`, 'a');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { contact: { name: null; phone: null }; rejected_at: string };
      expect(body.contact).toMatchObject({ name: null, phone: null });
      expect(body.rejected_at).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('v1-org: store failures, counts and paging', () => {
    it('503 when loading an org fails (orgInReach)', async () => {
      orgs.findById = async () => storeErr();
      const res = await get(`/v1/org/read/${ORG_A}`, 'a');
      expect(res.statusCode).toBe(503);
    });

    it('503 when the root lookup fails for a network-admin read of an unknown id', async () => {
      let n = 0;
      const origRoot = orgs.findRoot.bind(orgs);
      orgs.findRoot = async () => {
        n += 1;
        return n >= 2 ? storeErr() : origRoot();
      };
      const res = await get(`/v1/org/read/${ORG_X}`, 'na');
      expect(res.statusCode).toBe(503);
    });

    it('503 when the coordinator count lookup fails on org read', async () => {
      coordinators.countByOrg = async () => storeErr();
      const res = await get(`/v1/org/read/${ORG_A}`, 'na');
      expect(res.statusCode).toBe(503);
    });

    it('reports zero counts when the count map omits the org', async () => {
      coordinators.countByOrg = async () => ({ ok: true, value: {} });
      const res = await get(`/v1/org/read/${ORG_A}`, 'na');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ coordinator_count: 0, pending_count: 0 });
    });

    it('filters org search by name prefix', async () => {
      const res = await post('/v1/org/search', 'na', { filter: { name_prefix: 'Alpha' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { orgs: Array<{ id: string }> }).orgs.map((o) => o.id)).toEqual([
        ORG_A,
      ]);
    });

    it('pages org search with an opaque cursor', async () => {
      const first = (await post('/v1/org/search', 'na', { limit: 2 })).json() as {
        orgs: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(first.next_cursor).not.toBeNull();
      const second = await post('/v1/org/search', 'na', { limit: 2, cursor: first.next_cursor });
      expect(second.statusCode).toBe(200);
    });

    it('400 on a malformed org search cursor', async () => {
      const res = await post('/v1/org/search', 'na', { cursor: 'not-a-cursor' });
      expect(res.statusCode).toBe(400);
    });

    it('503 when the org search store fails', async () => {
      orgs.search = async () => storeErr();
      const res = await post('/v1/org/search', 'na', {});
      expect(res.statusCode).toBe(503);
    });

    it('503 when the count lookup fails during org search', async () => {
      coordinators.countByOrg = async () => storeErr();
      const res = await post('/v1/org/search', 'na', {});
      expect(res.statusCode).toBe(503);
    });

    it('reports zero counts in search when the count map omits an org', async () => {
      coordinators.countByOrg = async () => ({ ok: true, value: {} });
      const res = await post('/v1/org/search', 'na', {});
      expect(res.statusCode).toBe(200);
      const orgsOut = (res.json() as { orgs: Array<{ coordinator_count: number }> }).orgs;
      expect(orgsOut.every((o) => o.coordinator_count === 0)).toBe(true);
    });
  });

  describe('v1-org: metadata update edges', () => {
    it('updates locations', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        locations: [{ geo: { type: 'Point', coordinates: [77.59, 12.97] } }],
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { locations: unknown[] }).locations).toHaveLength(1);
    });

    it('404 when the org update reports the row is gone', async () => {
      orgs.update = async () => storeErr('NOT_FOUND');
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        legal_name: 'X Ltd',
      });
      expect(res.statusCode).toBe(404);
    });

    it('503 when the org update store fails', async () => {
      orgs.update = async () => storeErr('DB_UNAVAILABLE');
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        legal_name: 'X Ltd',
      });
      expect(res.statusCode).toBe(503);
    });
  });
  // RBAC on top of Phase 5's checks: the capability each console route
  // declares (route-access snapshot), decided per request.
  describe('with RBAC enforced', () => {
    beforeEach(async () => {
      _setRbacRuntime(await testRbacRuntime('enforce'));
    });
    afterEach(() => _setRbacRuntime(null));

    const permissionOf = (res: { json(): unknown }) =>
      (res.json() as { error: { fields?: { permission?: string } } }).error.fields?.permission;

    it('lets an aggregator owner approve its coordinator (org.manage)', async () => {
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
    });

    // Route permission, decided at the edge: policy/rbac/edge_test.rego (test_real_table_*).

    it('lets the network admin repair access', async () => {
      await idp.createUser({ email: 'a@a.org', enabled: false, attributes: {} });
      expect((await post(`/v1/org/access/repair/${ORG_A}`, 'na', {})).statusCode).toBe(200);
    });

    it('lets an owner decide its child org with orgs.onboard in the parent', async () => {
      await setOrg(ORG_P, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      const res = await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
    });

    it('refuses the decision when the parent org does not grant orgs.onboard', async () => {
      await setOrg(ORG_P, { parentId: ORG_A, parentName: 'Alpha', depth: 2 });
      _setRbacRuntime({
        ...(await testRbacRuntime('enforce')),
        roles: indexRoles(
          (await shippedRoles()).map((r) =>
            r.key === 'org_admin'
              ? { ...r, permissions: r.permissions.filter((c) => c !== 'orgs.onboard') }
              : r,
          ),
        ),
      });
      const res = await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' });
      expect([403, 404]).toContain(res.statusCode);
      const row = await orgs.findById(ORG_P);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('lets a signed-in coordinator read itself', async () => {
      expect((await get('/v1/user/read/me', 'coord')).statusCode).toBe(200);
    });

    it('lists the caller capabilities on read/me', async () => {
      const me = (await get('/v1/user/read/me', 'a')).json() as { capabilities: string[] };
      expect(me.capabilities).toContain('org.manage');
      expect(me.capabilities).toContain('contact.unmask');
      expect(me.capabilities).not.toContain('network.administer');
      expect(me.capabilities).not.toContain('profiles.view_pii');
      const na = (await get('/v1/user/read/me', 'na')).json() as { capabilities: string[] };
      expect(na.capabilities).toContain('network.administer');
    });

    it('lists the caller permissions per organisation on read/me', async () => {
      const me = (await get('/v1/user/read/me', 'a')).json() as {
        orgs: Array<{ id: string; capabilities: string[] }>;
      };
      const a = me.orgs.find((o) => o.id === ORG_A);
      expect(a?.capabilities).toContain('org.manage');
      // Every owner invites and decides the orgs directly under it.
      expect(a?.capabilities).toContain('orgs.onboard');
    });

    it('returns null capabilities when RBAC is off', async () => {
      _setRbacRuntime(null);
      const me = (await get('/v1/user/read/me', 'a')).json() as { capabilities: unknown };
      expect(me.capabilities).toBeNull();
    });

    it('masks contacts for a role without contact.unmask', async () => {
      const roles = (await shippedRoles()).map((r) =>
        r.key === 'org_admin'
          ? { ...r, permissions: r.permissions.filter((c) => c !== 'contact.unmask') }
          : r,
      );
      _setRbacRuntime({
        mode: 'enforce',
        roles: indexRoles(roles),
        authorizer: new AuthorizerFake(),
      });
      const one = (await get(`/v1/user/read/${C1}`, 'a')).json() as {
        contact: { email: string; phone: string | null };
      };
      expect(one.contact.email).toMatch(/^.\*\*\*@/);
      const list = (await post('/v1/user/search', 'a', { filter: {} })).json() as {
        users: Array<{ contact: { email: string } }>;
      };
      expect(list.users.length).toBeGreaterThan(0);
      for (const u of list.users) expect(u.contact.email).toMatch(/^.\*\*\*@/);
    });

    it("unmasks a search row only where the caller holds contact.unmask in that row's org", async () => {
      // OWNER_A owns ORG_A and ORG_B, and holds contact.unmask in ORG_A only.
      orgs.seed([
        buildOrganisation({
          id: ORG_B,
          slug: 'org-b',
          displayName: 'Beta',
          status: 'active',
          ownerUserId: OWNER_A,
          ownerEmail: 'a@a.org',
        }),
      ]);
      const shipped = await shippedRoles();
      const roles = shipped.map((r) =>
        r.key === 'org_admin'
          ? { ...r, permissions: r.permissions.filter((c) => c !== 'contact.unmask') }
          : r,
      );
      const pii = shipped.find((r) => r.key === 'pii_access')!;
      roles.push({
        ...pii,
        key: 'contact_viewer',
        isBuiltin: false,
        accountType: 'admin',
        maxDays: null,
        permissions: ['contact.unmask'],
      });
      _setRbacRuntime({
        mode: 'enforce',
        roles: indexRoles(roles),
        authorizer: new AuthorizerFake(),
      });
      (getRoleStore() as InMemoryRoleStore).seed([
        { userId: OWNER_A, roleKey: 'contact_viewer', orgId: ORG_A },
      ]);

      const list = (await post('/v1/user/search', 'a', { filter: {} })).json() as {
        users: Array<{ id: string; contact: { email: string } }>;
      };
      const email = Object.fromEntries(list.users.map((u) => [u.id, u.contact.email]));
      expect(email[C1]).toBe('c1@x.org');
      expect(email[C3]).toBe('c3@x.org');
      expect(email[C2]).toMatch(/^.\*\*\*@/);
    });

    describe('IAM writes in log mode', () => {
      it('refuses an assignment without the role’s assigned_by permission', async () => {
        const roles = (await shippedRoles()).map((r) =>
          r.key === 'org_admin'
            ? { ...r, permissions: r.permissions.filter((c) => c !== 'org.manage') }
            : r,
        );
        _setRbacRuntime({
          mode: 'log',
          roles: indexRoles(roles),
          authorizer: new AuthorizerFake(),
        });
        const body = { role_key: 'pii_access', org_id: ORG_A };
        expect((await post(`/v1/user/role/assign/${C3}`, 'a', body)).statusCode).toBe(403);
        expect((await post(`/v1/user/role/revoke/${C3}`, 'a', body)).statusCode).toBe(403);
      });

      // Route permission, decided at the edge: policy/rbac/edge_test.rego (test_real_table_*).
    });

    describe('roles API', () => {
      const reasonOf = (res: { json(): unknown }) =>
        (res.json() as { error: { fields?: { reason?: string } } }).error.fields?.reason;
      const assign = (who: keyof typeof TOKENS, id: string, body: object) =>
        post(`/v1/user/role/assign/${id}`, who, body);

      describe('token roles claim (RBAC edge)', () => {
        const C4 = '00000000-0000-4000-8000-0000000000c4';
        /** The `roles` attribute on C4's Keycloak user. */
        const kcRolesOfC4 = async () => {
          const kc = await idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, C4);
          const user = kc.ok
            ? (kc.value as { attributes?: Record<string, string[]> } | null)
            : null;
          return user?.attributes?.['roles'];
        };

        beforeEach(async () => {
          // This describe checks the real sync: turn the setup's no-op off.
          delete (globalThis as Record<string, unknown>)[TEST_TOKEN_ROLES_OFF_KEY];
          // The sync's per-user lock; no Redis in unit tests.
          _setRedis({ set: async () => 'OK', eval: async () => 1, sadd: async () => 1 } as never);
          // An active coordinator with a Keycloak user but no recorded login,
          // found through its aggregator_id attribute.
          coordinators.seed([coordinator(C4, ORG_A, 'active', 4)]);
          await idp.createUser({ email: 'c4@x.org', attributes: { [KC_ATTR.AGGREGATOR_ID]: C4 } });
        });
        afterEach(() => {
          _setRedis(null);
        });

        it("writes the coordinator's role keys to Keycloak after an assignment", async () => {
          const res = await assign('a', C4, { role_key: 'data_export', org_id: ORG_A });
          expect(res.statusCode).toBe(200);
          await vi.waitFor(async () =>
            expect(await kcRolesOfC4()).toEqual(['coordinator', 'data_export']),
          );
          const revoked = await post(`/v1/user/role/revoke/${C4}`, 'a', {
            role_key: 'data_export',
            org_id: ORG_A,
          });
          expect(revoked.statusCode).toBe(200);
          await vi.waitFor(async () => expect(await kcRolesOfC4()).toEqual(['coordinator']));
        });
      });

      it('lists every role to an admin, and refuses a coordinator', async () => {
        const res = await get('/v1/roles', 'a');
        expect(res.statusCode).toBe(200);
        const keys = (res.json() as { roles: Array<{ key: string }> }).roles.map((r) => r.key);
        expect(keys).toEqual([
          'coordinator',
          'data_export',
          'network_admin',
          'org_admin',
          'org_onboarder',
          'pii_access',
        ]);
        expect((res.json() as { permissions: unknown[] }).permissions).toHaveLength(15);
        expect((await get('/v1/roles', 'coord')).statusCode).toBe(403);
      });

      it("shows a coordinator's base role and what its owner may assign", async () => {
        const res = (await get(`/v1/user/roles/${C3}`, 'a')).json() as {
          base: Array<{ role_key: string; org_id: string }>;
          assignable: Array<{ role_key: string; org_id: string }>;
        };
        expect(res.base).toEqual([{ role_key: 'coordinator', org_id: ORG_A }]);
        expect(res.assignable.map((r) => r.role_key).sort()).toEqual(['data_export', 'pii_access']);
      });

      it('assigns PII Access for 90 days, takes effect, then revokes it', async () => {
        const res = await assign('a', C3, { role_key: 'pii_access', org_id: ORG_A });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { live: boolean; expires_at: string };
        expect(body.live).toBe(true);
        const days = (Date.parse(body.expires_at) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(89.9);
        expect(days).toBeLessThanOrEqual(90);

        const me = (await get('/v1/user/read/me', 'coord')).json() as { capabilities: string[] };
        expect(me.capabilities).toContain('profiles.view_pii');

        const off = await post(`/v1/user/role/revoke/${C3}`, 'a', {
          role_key: 'pii_access',
          org_id: ORG_A,
        });
        expect(off.json()).toEqual({ revoked: true });
        const after = (await get('/v1/user/read/me', 'coord')).json() as { capabilities: string[] };
        expect(after.capabilities).not.toContain('profiles.view_pii');
        const audit = (getRoleStore() as InMemoryRoleStore).audit.map((e) => e.event);
        expect(audit).toEqual(['role.assign', 'role.revoke']);
      });

      it("answers 404 for another org's coordinator", async () => {
        const res = await assign('a', C2, { role_key: 'data_export', org_id: ORG_B });
        expect(res.statusCode).toBe(404);
      });

      it('refuses an unknown role, a base role and a validity beyond the maximum', async () => {
        expect((await assign('a', C3, { role_key: 'nope', org_id: ORG_A })).statusCode).toBe(400);
        const base = await assign('a', C3, { role_key: 'coordinator', org_id: ORG_A });
        expect([base.statusCode, reasonOf(base)]).toEqual([409, 'base_role']);
        const long = await assign('a', C3, { role_key: 'pii_access', org_id: ORG_A, days: 91 });
        expect([long.statusCode, reasonOf(long)]).toEqual([409, 'days_exceed_max']);
      });

      it('refuses an organisation the user is not part of', async () => {
        const res = await assign('a', C3, { role_key: 'data_export', org_id: ORG_B });
        expect([res.statusCode, reasonOf(res)]).toEqual([409, 'not_member']);
      });

      it('refuses the wrong account type and assigning to yourself', async () => {
        // Org Onboarder is admin-only; the network admin may assign it (network.administer).
        coordinators.seed([coordinator(C7, DEFAULT, 'active', 7)]);
        const type = await assign('na', C7, { role_key: 'org_onboarder', org_id: DEFAULT });
        expect([type.statusCode, reasonOf(type)]).toEqual([409, 'account_type']);
        const self = await assign('na', NA, { role_key: 'org_onboarder', org_id: DEFAULT });
        expect([self.statusCode, reasonOf(self)]).toEqual([409, 'self']);
      });

      it('lets only the network admin assign Org Onboarder, and not to the owner of another org', async () => {
        const byOwner = await assign('a', OWNER_A, { role_key: 'org_onboarder', org_id: ORG_A });
        expect(byOwner.statusCode).toBe(403);
        expect(permissionOf(byOwner)).toBe('network.administer');

        // The network admin does not reach the users of the orgs under it.
        const res = await assign('na', OWNER_A, { role_key: 'org_onboarder', org_id: ORG_A });
        expect(res.statusCode).toBe(404);
      });

      it('revokes a coordinator’s additional roles when it is rejected', async () => {
        expect((await assign('a', C1, { role_key: 'data_export', org_id: ORG_A })).statusCode).toBe(
          200,
        );
        const decided = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'reject' });
        expect(decided.statusCode).toBe(200);
        const store = getRoleStore() as InMemoryRoleStore;
        expect(store.assignments.filter((r) => r.userId === C1 && r.revokedAt === null)).toEqual(
          [],
        );
        expect(store.audit.map((e) => e.event)).toContain('role.revoke_on_leave');
      });

      // #873: the coordinator list shows who holds which additional role.
      const rolesById = async (who: keyof typeof TOKENS) => {
        const res = await post('/v1/user/search', who, {});
        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string; roles: string[] | null }> };
        return Object.fromEntries(body.users.map((u) => [u.id, u.roles]));
      };

      it('lists each coordinator’s live roles in its organisation on search, sorted', async () => {
        expect((await assign('a', C3, { role_key: 'pii_access', org_id: ORG_A })).statusCode).toBe(
          200,
        );
        expect((await assign('a', C3, { role_key: 'data_export', org_id: ORG_A })).statusCode).toBe(
          200,
        );
        const roles = await rolesById('a');
        expect(roles[C3]).toEqual(['data_export', 'pii_access']);
        expect(roles[C1]).toEqual([]);
      });

      it('drops a revoked role from search, and ignores a role held in another organisation', async () => {
        expect((await assign('a', C3, { role_key: 'data_export', org_id: ORG_A })).statusCode).toBe(
          200,
        );
        (getRoleStore() as InMemoryRoleStore).seed([
          { userId: C3, roleKey: 'pii_access', orgId: ORG_B },
        ]);
        expect(
          (
            await post(`/v1/user/role/revoke/${C3}`, 'a', {
              role_key: 'data_export',
              org_id: ORG_A,
            })
          ).statusCode,
        ).toBe(200);
        expect((await rolesById('a'))[C3]).toEqual([]);
      });

      it('answers 503 on search when the role store fails', async () => {
        (getRoleStore() as InMemoryRoleStore).failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
        expect((await post('/v1/user/search', 'a', {})).statusCode).toBe(503);
      });

      it('returns null roles on search when access control is off', async () => {
        _setRbacRuntime(null);
        const roles = await rolesById('a');
        expect(Object.values(roles).length).toBeGreaterThan(0);
        for (const r of Object.values(roles)) expect(r).toBeNull();
      });

      it('answers 503 when access control is off', async () => {
        _setRbacRuntime(null);
        expect((await get('/v1/roles', 'a')).statusCode).toBe(503);
        const res = await assign('a', C3, { role_key: 'pii_access', org_id: ORG_A });
        expect(res.statusCode).toBe(503);
      });
    });

    // #873: org.manage is the org admin's; the network admin approves and
    // edits organisations but manages coordinators only in orgs it owns.
    describe('org.manage stays with the org admin', () => {
      const searchIds = async (who: keyof typeof TOKENS) => {
        const res = await post('/v1/user/search', who, {});
        expect(res.statusCode).toBe(200);
        return (res.json() as { users: Array<{ id: string }> }).users
          .map((u) => u.id)
          .sort((x, y) => x.localeCompare(y));
      };
      const C9 = '00000000-0000-4000-8000-0000000000c9';

      it('lets the network admin view and change only its own org’s coordinators', async () => {
        coordinators.seed([coordinator(C9, DEFAULT, 'pending', 9)]);
        await idp.createUser({
          email: 'c9@x.org',
          enabled: false,
          attributes: { [KC_ATTR.AGGREGATOR_ID]: C9 },
        });
        expect(await searchIds('na')).toEqual([C9]);
        expect((await get(`/v1/user/read/${C3}`, 'na')).statusCode).toBe(404);
        // Its own (Default) org: the network admin still decides.
        expect(
          (await post(`/v1/user/decision/${C9}`, 'na', { decision: 'reject' })).statusCode,
        ).toBe(200);
        expect(
          (await post(`/v1/user/decision/${C1}`, 'na', { decision: 'approve' })).statusCode,
        ).toBe(404);
        expect(
          (await patch(`/v1/user/metadata/update/${C3}`, 'na', { serves: [] })).statusCode,
        ).toBe(404);
        const invite = await post('/v1/user/create', 'na', {
          org_id: ORG_A,
          recipients: [{ email: 'new@x.org' }],
        });
        expect(invite.statusCode).toBe(404);
      });

      it('limits an owner’s view to its own coordinators', async () => {
        coordinators.seed([coordinator(C9, DEFAULT, 'pending', 9)]);
        expect(await searchIds('b')).toEqual([C2]);
        expect((await get(`/v1/user/read/${C3}`, 'b')).statusCode).toBe(404);
      });

      it('refuses the network admin Data Export or PII Access in another org', async () => {
        const res = await post(`/v1/user/role/assign/${C3}`, 'na', {
          role_key: 'pii_access',
          org_id: ORG_A,
        });
        // Another org's coordinator is out of the network admin's reach.
        expect(res.statusCode).toBe(404);
      });

      it('keeps the owner managing its own coordinators', async () => {
        expect(await searchIds('a')).toEqual([C1, C3]);
        expect((await get(`/v1/user/read/${C3}`, 'a')).statusCode).toBe(200);
        expect((await get(`/v1/user/read/${C2}`, 'a')).statusCode).toBe(404);
      });

      it('keeps the organisation pages for both: network admin via orgs.onboard, owner via org.manage', async () => {
        const naOrgs = (await post('/v1/org/search', 'na', {})).json() as {
          orgs: Array<{ id: string }>;
        };
        expect(naOrgs.orgs.map((o) => o.id)).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
        expect((await get(`/v1/org/read/${ORG_A}`, 'na')).statusCode).toBe(200);
        expect((await get(`/v1/org/read/${ORG_A}`, 'a')).statusCode).toBe(200);
        expect((await get(`/v1/org/read/${ORG_B}`, 'a')).statusCode).toBe(404);
      });

      // Route permission, decided at the edge: policy/rbac/edge_test.rego (test_real_table_*).

      it('only logs the narrower scope in log mode', async () => {
        // Org Admin without org.manage would narrow the owner to nothing; log mode keeps its reach.
        _setRbacRuntime({
          ...(await testRbacRuntime('log')),
          roles: indexRoles(
            (await shippedRoles()).map((r) => ({
              ...r,
              permissions: r.permissions.filter((c) => c !== 'org.manage'),
            })),
          ),
        });
        expect(await searchIds('a')).toEqual([C1, C3]);
      });

      it('keeps the network admin to its own orgs even when Network Admin holds org.manage', async () => {
        _setRbacRuntime({
          ...(await testRbacRuntime('enforce')),
          roles: indexRoles(
            (await shippedRoles()).map((r) =>
              r.key === 'network_admin'
                ? { ...r, permissions: [...r.permissions, 'org.manage' as const] }
                : r,
            ),
          ),
        });
        expect(await searchIds('na')).toEqual([]);
        expect((await get(`/v1/user/read/${C3}`, 'na')).statusCode).toBe(404);
      });
    });

    // #871: the network admin's read-only view of the roles and permissions.
    describe('catalogue view /v1/rbac/*', () => {
      type Row = { key: string } & Record<string, unknown>;
      const rolesOf = async (who: keyof typeof TOKENS) =>
        ((await get('/v1/rbac/roles', who)).json() as { roles: Row[] }).roles;
      const permissionsOf = async (who: keyof typeof TOKENS) =>
        ((await get('/v1/rbac/permissions', who)).json() as { permissions: Row[] }).permissions;

      beforeEach(async () => {
        const cat = getRbacCatalogue() as InMemoryRbacCatalogue;
        cat.setRoles(await shippedRoles());
        cat.setPermissions(
          permissionDefinitions(CAPABILITIES).map((p) => ({ ...p, deprecated: false })),
        );
      });

      it('lists every enforced role with who holds it, where, and how it is given', async () => {
        const roles = await rolesOf('na');
        expect(roles.map((r) => r.key)).toEqual([
          'coordinator',
          'data_export',
          'network_admin',
          'org_admin',
          'org_onboarder',
          'pii_access',
        ]);
        expect(roles.find((r) => r.key === 'network_admin')).toMatchObject({
          name: 'Network Admin',
          is_builtin: true,
          held_by: 'org_owners',
          held_in: ['network_facilitator'],
          granted: { via: 'membership', membership: 'root_owner' },
          max_days: null,
        });
        expect(roles.find((r) => r.key === 'pii_access')).toEqual({
          key: 'pii_access',
          name: 'PII Access',
          description: 'Sees and exports decrypted profile details.',
          is_builtin: true,
          held_by: 'coordinators',
          held_in: ['aggregator'],
          granted: { via: 'assignment', assigned_by: 'org.manage' },
          max_days: 90,
          permissions: ['profiles.view_pii'],
        });
      });

      it('lists every permission, and "granted by roles" matches the roles table', async () => {
        const roles = await rolesOf('na');
        const permissions = await permissionsOf('na');
        expect(permissions.map((p) => p.key)).toEqual(
          [...CAPABILITIES].sort((a, b) => a.localeCompare(b)),
        );
        for (const p of permissions) {
          const granting = roles
            .filter((r) => (r.permissions as string[]).includes(p.key))
            .map((r) => r.key);
          expect(p.granted_by_roles, p.key).toEqual(granting);
        }
        expect(permissions.find((p) => p.key === 'profiles.view_pii')).toEqual({
          key: 'profiles.view_pii',
          description: 'See and export decrypted details',
          resource: 'profiles',
          action: 'view_pii',
          personal_data: true,
          retired: false,
          granted_by_roles: ['pii_access'],
        });
        expect(permissions.find((p) => p.key === 'profiles.view')).toMatchObject({
          personal_data: false,
        });
      });

      it('keeps a permission the code retired, flagged', async () => {
        // A retired permission is one still stored (a migration marked it
        // deprecated), no longer in the code's catalogue; the view flags it.
        const cat = getRbacCatalogue() as InMemoryRbacCatalogue;
        cat.setPermissions(
          permissionDefinitions(CAPABILITIES).map((p) => ({
            ...p,
            deprecated: p.key === 'agreement.manage',
          })),
        );
        const retired = (await permissionsOf('na')).find((p) => p.key === 'agreement.manage');
        expect(retired).toMatchObject({ retired: true, granted_by_roles: ['network_admin'] });
      });

      it('shows a role change after the catalogue refresh, with no restart', async () => {
        const store = getRbacCatalogue() as InMemoryRbacCatalogue;
        const revision = await store.revision();
        _setRbacRuntime({
          ...(await testRbacRuntime('enforce')),
          catalogueRevision: revision.ok ? revision.value : '',
        });
        store.setRoles([
          ...store.storedRoles(),
          buildRole({ key: 'verifier', name: 'Verifier', permissions: ['profiles.verify'] }),
        ]);
        expect((await rolesOf('na')).map((r) => r.key)).not.toContain('verifier');
        expect(await refreshRbacCatalogue()).toBe('reloaded');
        expect((await rolesOf('na')).find((r) => r.key === 'verifier')).toMatchObject({
          is_builtin: false,
          permissions: ['profiles.verify'],
        });
        expect(
          (await permissionsOf('na')).find((p) => p.key === 'profiles.verify')?.granted_by_roles,
        ).toContain('verifier');
      });

      // Route permission, decided at the edge: policy/rbac/edge_test.rego (test_real_table_*).

      it('answers 404 to an owner when access is only logged', async () => {
        _setRbacRuntime(await testRbacRuntime('log'));
        for (const url of ['/v1/rbac/roles', '/v1/rbac/permissions']) {
          expect((await get(url, 'a')).statusCode).toBe(404);
          expect((await get(url, 'na')).statusCode).toBe(200);
        }
      });

      it('answers 503 when access control is off, or the catalogue cannot be read', async () => {
        const store = getRbacCatalogue() as InMemoryRbacCatalogue;
        store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
        expect((await get('/v1/rbac/permissions', 'na')).statusCode).toBe(503);
        store.failWith(null);
        _setRbacRuntime(null);
        expect((await get('/v1/rbac/roles', 'na')).statusCode).toBe(503);
        expect((await get('/v1/rbac/permissions', 'na')).statusCode).toBe(503);
      });

      it('accepts no writes', async () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
          for (const url of ['/v1/rbac/roles', '/v1/rbac/permissions']) {
            const res = await app.inject({ method, url, headers: auth('na'), payload: {} });
            expect(res.statusCode, `${method} ${url}`).toBe(404);
          }
        }
      });
    });

    describe('custom roles (R6)', () => {
      const verifier = {
        key: 'verifier',
        name: 'Verifier',
        account_type: 'coordinator',
        assignable_org_types: ['aggregator'],
        assigned_by: 'org.manage',
        permissions: ['profiles.verify'],
      };
      const codeOf = (res: { json(): unknown }) =>
        (res.json() as { error: { code: string } }).error.code;

      beforeEach(async () => {
        // The catalogue as the API leaves it at start: permissions and built-in
        // roles seeded by migration (modelled here on the in-memory fake).
        const cat = getRbacCatalogue() as InMemoryRbacCatalogue;
        cat.setRoles(await shippedRoles());
        cat.setPermissions(
          permissionDefinitions(CAPABILITIES).map((p) => ({ ...p, deprecated: false })),
        );
      });

      it('lets the network admin create a role that owners can then assign', async () => {
        const created = await post('/v1/roles/create', 'na', verifier);
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({
          key: 'verifier',
          is_builtin: false,
          base_for: null,
        });
        const keys = (
          (await get('/v1/roles', 'a')).json() as { roles: Array<{ key: string }> }
        ).roles.map((r) => r.key);
        expect(keys).toContain('verifier');
        const assigned = await post(`/v1/user/role/assign/${C3}`, 'a', {
          role_key: 'verifier',
          org_id: ORG_A,
        });
        expect(assigned.statusCode).toBe(200);
        const me = (await get('/v1/user/read/me', 'coord')).json() as { capabilities: string[] };
        expect(me.capabilities).toContain('profiles.verify');
      });

      // Route permission, decided at the edge: policy/rbac/edge_test.rego (test_real_table_*).

      it('refuses an unknown permission, personal data through the root and a taken key', async () => {
        const unknown = await post('/v1/roles/create', 'na', {
          ...verifier,
          permissions: ['profiles.teleport'],
        });
        expect([unknown.statusCode, codeOf(unknown)]).toEqual([400, 'ROLE_INVALID']);
        const root = await post('/v1/roles/create', 'na', {
          ...verifier,
          key: 'root_pii',
          account_type: 'admin',
          assigned_by: 'network.administer',
          assignable_org_types: ['network_facilitator'],
          permissions: ['profiles.view_pii'],
        });
        expect([root.statusCode, codeOf(root)]).toEqual([400, 'ROLE_INVALID']);
        const taken = await post('/v1/roles/create', 'na', { ...verifier, key: 'coordinator' });
        expect([taken.statusCode, codeOf(taken)]).toEqual([409, 'ROLE_EXISTS']);
      });

      it('changes a custom role and refuses changing a built-in one', async () => {
        await post('/v1/roles/create', 'na', verifier);
        const changed = await patch('/v1/roles/update/verifier', 'na', {
          permissions: ['profiles.verify', 'profiles.view'],
        });
        expect(changed.statusCode).toBe(200);
        expect(changed.json()).toMatchObject({ permissions: ['profiles.verify', 'profiles.view'] });
        const builtin = await patch('/v1/roles/update/pii_access', 'na', { max_days: 365 });
        expect([builtin.statusCode, codeOf(builtin)]).toEqual([409, 'ROLE_BUILTIN']);
      });

      it('deletes an unused custom role and refuses a used, built-in or unknown one', async () => {
        await post('/v1/roles/create', 'na', verifier);
        (getRbacCatalogue() as InMemoryRbacCatalogue).liveAssignments.add('verifier');
        const used = await post('/v1/roles/delete/verifier', 'na', {});
        expect([used.statusCode, codeOf(used)]).toEqual([409, 'ROLE_IN_USE']);
        (getRbacCatalogue() as InMemoryRbacCatalogue).liveAssignments.clear();
        expect((await post('/v1/roles/delete/verifier', 'na', {})).json()).toEqual({
          deleted: true,
        });
        const builtin = await post('/v1/roles/delete/coordinator', 'na', {});
        expect([builtin.statusCode, codeOf(builtin)]).toEqual([409, 'ROLE_BUILTIN']);
        expect((await post('/v1/roles/delete/nope', 'na', {})).statusCode).toBe(404);
      });
    });

    it('shows contacts plain to a role with contact.unmask', async () => {
      const one = (await get(`/v1/user/read/${C1}`, 'a')).json() as { contact: { email: string } };
      expect(one.contact.email).toBe('c1@x.org');
    });
  });
});
