// Stale-pending cleanup of orgs.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('cleanup-stale — org prune', () => {
  let app: FastifyInstance;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    _setUserStore(new UserStoreFake());
    orgStore = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    _setOrganisationStore(orgStore);
    _setIdpAdmin(idp);
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return {
          sub: '3f1c2b9e-0000-4000-8000-00000000b0ff',
          azp: 'aggregator-bff',
          preferred_username: 'service-account-aggregator-bff',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
  });

  it('prunes a stale pending org + its KC owner user and mirrored group', async () => {
    // A KC owner user + group the prune should remove.
    const owner = await idp.createUser({
      email: 'stale.owner@x.org',
      username: 'stale.owner@x.org',
      phone: '+911111111111',
      enabled: false,
    });
    if (!owner.ok) throw new Error('seed owner');
    const group = await idp.createGroup('org-stale', { org_id: 'o-stale' });
    if (!group.ok) throw new Error('seed group');

    orgStore.seed([
      buildOrganisation({
        id: 'o-stale',
        slug: 'stale',
        ownerEmail: 'stale.owner@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: group.value.id,
        status: 'pending',
        // Far past the TTL + grace cutoff.
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      // A fresh pending org (updated now) that must survive the cutoff.
      buildOrganisation({
        id: 'o-fresh',
        slug: 'fresh',
        ownerEmail: 'fresh@x.org',
        status: 'pending',
        updatedAt: new Date(),
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgsScanned: number; orgsPruned: number; orgsPrunedIds: string[] };
    expect(body.orgsPruned).toBe(1);
    expect(body.orgsPrunedIds).toEqual(['o-stale']);

    // Stale org gone, fresh one survives.
    const staleRow = await orgStore.findById('o-stale');
    expect(staleRow.ok && staleRow.value).toBeNull();
    const freshRow = await orgStore.findById('o-fresh');
    expect(freshRow.ok && freshRow.value !== null).toBe(true);
    // KC owner user + group removed.
    const ownerLookup = await idp.findByEmail('stale.owner@x.org');
    expect(ownerLookup.ok && ownerLookup.value).toBeNull();
    expect(idp.getGroup(group.value.id)).toBeUndefined();
  });

  it('keeps the owner KC user when the owner owns another org (0027, F11)', async () => {
    const owner = await idp.createUser({
      email: 'two.orgs@x.org',
      username: 'two.orgs@x.org',
      phone: '+912222222222',
      enabled: true,
    });
    if (!owner.ok) throw new Error('seed owner');
    const group = await idp.createGroup('org-stale2', { org_id: 'o-stale2' });
    if (!group.ok) throw new Error('seed group');
    // Same owner person: a stale pending org and a live, approved one.
    orgStore.seed([
      buildOrganisation({
        id: 'o-stale2',
        slug: 'stale2',
        ownerEmail: 'two.orgs@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: group.value.id,
        status: 'pending',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      buildOrganisation({
        id: 'o-live2',
        slug: 'live2',
        displayName: 'Live Two',
        ownerEmail: 'two.orgs@x.org',
        ownerKcSub: owner.value.id,
        status: 'active',
        updatedAt: new Date(),
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orgsPrunedIds: string[] }).orgsPrunedIds).toEqual(['o-stale2']);
    // The stale org and its group go; the owner's KC user stays for the live org.
    const kept = await idp.findById(owner.value.id);
    expect(kept.ok && kept.value?.id).toBe(owner.value.id);
    const live = await orgStore.findById('o-live2');
    expect(live.ok && live.value?.status).toBe('active');
  });

  it('prunes a stale pending org with no owner KC user on file (ownerKcSub unset)', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-no-owner',
        slug: 'no-owner',
        ownerEmail: 'never-signed-in@x.org',
        ownerKcSub: null,
        kcGroupId: null,
        status: 'pending',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgsPruned: number; orgsPrunedIds: string[] };
    expect(body.orgsPruned).toBe(1);
    expect(body.orgsPrunedIds).toEqual(['o-no-owner']);
    const row = await orgStore.findById('o-no-owner');
    expect(row.ok && row.value).toBeNull();
  });

  it('skips (does not prune) a stale org when the mirrored KC group delete fails', async () => {
    const owner = await idp.createUser({
      email: 'group-fail-owner@x.org',
      enabled: false,
    });
    if (!owner.ok) throw new Error('seed owner');
    const group = await idp.createGroup('org-group-fail', { org_id: 'o-group-fail' });
    if (!group.ok) throw new Error('seed group');
    idp.deleteGroup = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'group delete failed' },
    });

    orgStore.seed([
      buildOrganisation({
        id: 'o-group-fail',
        slug: 'group-fail',
        ownerEmail: 'group-fail-owner@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: group.value.id,
        status: 'pending',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgsPruned: number; orgsPrunedIds: string[] };
    expect(body.orgsPruned).toBe(0);
    expect(body.orgsPrunedIds).not.toContain('o-group-fail');
    const row = await orgStore.findById('o-group-fail');
    expect(row.ok && row.value).not.toBeNull();
  });

  it('503s when the org store listPending fails', async () => {
    orgStore.listPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'org list failed' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DB_UNAVAILABLE');
  });
});
