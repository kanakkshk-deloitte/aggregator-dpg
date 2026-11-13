import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';

const aggregatorId = '22222222-2222-2222-2222-222222222222';

describe('aggregator profile routes', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    userStore.seed([buildCoordinator({ id: aggregatorId, orgSlug: 'trrain-zzzz' })]);
    _setUserStore(userStore);
    orgStore = new OrganisationStoreFake();
    _setOrganisationStore(orgStore);

    idp = new IdpAdminFake();
    await idp.createUser({
      email: 'asha@trrain.org',
      firstName: 'Asha',
      lastName: 'Rao',
      phone: '+919876543210',
      attributes: { aggregator_id: aggregatorId, association: 'TRRAIN' },
    });
    _setIdpAdmin(idp);
    // sub claim is populated lazily — use the KC user id created above so
    // findById resolves attributes including org name.
    const ashaUser = await idp.findByEmail('asha@trrain.org');
    const ashaId = ashaUser.ok && ashaUser.value ? ashaUser.value.id : 'kc-user-1';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good-token') {
        return {
          sub: ashaId,
          email: 'asha@trrain.org',
          email_verified: true,
          given_name: 'Asha',
          family_name: 'Rao',
          phone_number: '+919876543210',
          aggregator_id: aggregatorId,
        };
      }
      if (token === 'no-attribute') {
        return { sub: 'kc-user-2', email: 'x@y.z' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setAccessTokenVerifier(null);
    _setIdpAdmin(null);
  });

  it('GET returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregators/profile/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET returns 403 when token has no aggregator_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer no-attribute' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET returns the aggregator with identity from the token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.aggregator_id).toBe(aggregatorId);
    // The removed `aggregator_profile` keys must not reappear in the response.
    for (const k of [
      'contact_name',
      'personas',
      'services',
      'verified_certificate',
      'profile_completed_at',
      'is_complete',
    ]) {
      expect(body).not.toHaveProperty(k);
    }
    const id = body.identity as Record<string, unknown>;
    expect(id.first_name).toBe('Asha');
    expect(id.last_name).toBe('Rao');
    expect(id.email).toBe('asha@trrain.org');
    expect(id.phone).toBe('+919876543210');
    expect(id.email_verified).toBe(true);
    expect(id.active).toBe(true);
  });

  it('PATCH rejects an empty body — `aggregator` is required', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
  });

  it('PATCH rejects a `profile` key — the profile half of the body is gone', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { aggregator: { name: 'Still Valid' }, profile: { contact_name: 'Asha' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
  });

  it('GET returns 503 when the aggregator store fails', async () => {
    userStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET returns 404 when the aggregator row is missing', async () => {
    userStore.findById = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET falls back to JWT claims when the KC user lookup fails', async () => {
    idp.findById = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { identity: Record<string, unknown> };
    // JWT claims still populate identity even though the KC lookup failed.
    expect(body.identity.first_name).toBe('Asha');
  });

  it('GET falls back to JWT claims when the KC user lookup throws', async () => {
    idp.findById = async () => {
      throw new Error('kc unreachable');
    };
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { identity: Record<string, unknown> };
    expect(body.identity.first_name).toBe('Asha');
  });

  // ---------------------------------------------------------------------------
  // PATCH aggregator.contact branch
  // ---------------------------------------------------------------------------

  // Note: PATCH's own INVALID_PHONE branch (normalisePhone failing) is not
  // reachable via a real HTTP request — `BecknContactSchema`'s phone regex
  // (`^(\+?\d{10,15}|\d{10})$`) already enforces the same 10-15-digit window
  // that `normalisePhone` checks, at the Fastify schema-validation layer, so
  // any input that would fail `normalisePhone` is already rejected as 400
  // SCHEMA_VALIDATION before the handler body runs. Left uncovered.

  it('PATCH aborts with IDP_UNAVAILABLE (no DB write) when mirroring the phone to Keycloak fails', async () => {
    idp.setAttributes = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543211', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const stored = await userStore.findById(aggregatorId);
    if (stored.ok) expect(stored.value?.contact.phone).not.toBe('+919876543211');
  });

  it('PATCH 409 PHONE_EXISTS (before any Keycloak write) when an org owner holds the phone', async () => {
    orgStore.seed([
      buildOrganisation({
        ownerEmail: 'boss@else.org',
        ownerPhone: '+919876543299',
        status: 'active',
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = async () => {
      kcWrites++;
      return { ok: true, value: undefined };
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543299', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    expect(kcWrites).toBe(0);
  });

  it('PATCH 409 PHONE_EXISTS (before any Keycloak write) when another coordinator holds the phone', async () => {
    userStore.seed([
      buildCoordinator({
        id: '00000000-0000-0000-0000-00000000beef',
        orgSlug: 'other-coord',
        contact: { name: 'Other', phone: '+919876543288', email: 'other@x.org' },
      }),
    ]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543288', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
  });

  it('PATCH 409 USER_EXISTS (before any Keycloak write) when an org owner holds the email', async () => {
    orgStore.seed([
      buildOrganisation({
        ownerEmail: 'boss@else.org',
        ownerPhone: '+919876543277',
        status: 'active',
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = async () => {
      kcWrites++;
      return { ok: true, value: undefined };
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543210', email: 'Boss@Else.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    expect(kcWrites).toBe(0);
  });

  it('PATCH 409 CONFLICT before any Keycloak write when the contact is shared with an org owner', async () => {
    const shared = 'c'.repeat(64);
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-zzzz',
        contactId: shared,
        contact: { name: 'Both', phone: '+919876543201', email: 'both@trrain.org' },
      }),
    ]);
    orgStore.seed([
      buildOrganisation({
        contactId: shared,
        ownerEmail: 'both@trrain.org',
        ownerPhone: '+919876543201',
        status: 'active',
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = async () => {
      kcWrites++;
      return { ok: true, value: undefined };
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Both', phone: '+919876543202', email: 'both@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    expect(kcWrites).toBe(0);
  });

  it('PATCH restores the Keycloak phone when the database update fails', async () => {
    const phones: string[] = [];
    idp.setAttributes = async (_id, attrs) => {
      phones.push(String((attrs as Record<string, unknown>)['phoneNumber']));
      return { ok: true, value: undefined };
    };
    userStore.update = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543277', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect(phones).toHaveLength(2);
    expect(phones[0]).toBe('+919876543277');
    expect(phones[1]).not.toBe('+919876543277'); // put back to the previous phone
  });

  it('PATCH still reports the database failure when restoring Keycloak fails too', async () => {
    let kcCalls = 0;
    idp.setAttributes = () => {
      kcCalls++;
      return Promise.resolve(
        kcCalls === 1
          ? { ok: true, value: undefined }
          : { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'kc down' } },
      );
    };
    userStore.update = () =>
      Promise.resolve({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543266', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    expect(kcCalls).toBe(2);
  });

  it('PATCH 409 USER_EXISTS (before any Keycloak write) when another coordinator holds the email', async () => {
    userStore.seed([
      buildCoordinator({
        id: '00000000-0000-0000-0000-00000000cafe',
        orgSlug: 'other-coord-email',
        contact: { name: 'Other', phone: '+919876543255', email: 'taken@x.org' },
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = () => {
      kcWrites++;
      return Promise.resolve({ ok: true, value: undefined });
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543244', email: 'Taken@X.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    expect(kcWrites).toBe(0);
  });

  it('PATCH 503 DB_UNAVAILABLE (before any Keycloak write) when a contact pre-check lookup fails', async () => {
    orgStore.findByOwnerPhone = () =>
      Promise.resolve({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } });
    let kcWrites = 0;
    idp.setAttributes = () => {
      kcWrites++;
      return Promise.resolve({ ok: true, value: undefined });
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543233', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    expect(kcWrites).toBe(0);
  });

  it('PATCH refuses consent: read-only after registration (#836, 0029)', async () => {
    const before = await userStore.findById(aggregatorId);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          name: 'TRRAIN Renamed',
          consent: {
            value: false,
            given_at: '2020-01-15T10:00:00Z',
            valid_till: '2099-01-15T10:00:00Z',
          },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    const after = await userStore.findById(aggregatorId);
    expect(after.ok && after.value?.name).toBe(before.ok ? before.value?.name : undefined);
    expect(after.ok && after.value?.consent).toEqual(before.ok ? before.value?.consent : undefined);
  });

  it('PATCH updates the aggregator name successfully', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          name: 'TRRAIN Renamed',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe('TRRAIN Renamed');
    for (const k of [
      'contact_name',
      'personas',
      'services',
      'verified_certificate',
      'profile_completed_at',
      'is_complete',
    ]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it('PATCH accepts org details unchanged from what GET returned (an echoed contact)', async () => {
    const before = await userStore.findById(aggregatorId);
    if (!before.ok || !before.value) throw new Error('seed missing');
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          name: 'Echoed',
          url: before.value.url,
          locations: before.value.locations,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('Echoed');
  });

  it.each([
    [{ url: 'https://trrain.example.org' }, ['url']],
    [
      {
        locations: [
          {
            geo: { type: 'Point', coordinates: [77.6, 12.9] },
            address: { streetAddress: 'New st' },
          },
        ],
      },
      ['locations'],
    ],
    [
      {
        contact: {
          name: 'Asha Rao',
          phone: '+919876543210',
          email: 'asha@trrain.org',
          company: 'TRRAIN',
          gstNumber: 'G1',
        },
      },
      ['contact.company', 'contact.gstNumber'],
    ],
  ])(
    'PATCH of org details %j → 409 ORG_DETAILS_READ_ONLY before any write (0028)',
    async (aggregator, fields) => {
      const before = await userStore.findById(aggregatorId);
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/aggregators/profile/me',
        headers: { authorization: 'Bearer good-token' },
        payload: { aggregator: { name: 'Should Not Apply', ...aggregator } },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string; fields: { fields: string[] } } };
      expect(body.error.code).toBe('ORG_DETAILS_READ_ONLY');
      expect(body.error.fields.fields).toEqual(fields);
      const after = await userStore.findById(aggregatorId);
      expect(after.ok && after.value?.name).toBe(before.ok && before.value?.name);
    },
  );

  it.each([
    ['DUPLICATE_PHONE', 409, 'PHONE_EXISTS'],
    ['DUPLICATE_EMAIL', 409, 'USER_EXISTS'],
    ['CHECK_VIOLATION', 400, 'SCHEMA_VALIDATION'],
    ['DUPLICATE_SLUG', 503, 'DUPLICATE_SLUG'],
    ['DB_UNAVAILABLE', 503, 'DB_UNAVAILABLE'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
  ] as const)(
    'PATCH maps userStore.update error %s to %d %s',
    async (storeCode, status, errCode) => {
      userStore.update = async () => ({
        ok: false,
        error: { code: storeCode, message: 'store error' },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/aggregators/profile/me',
        headers: { authorization: 'Bearer good-token' },
        payload: { aggregator: { name: 'New Name' } },
      });
      expect(res.statusCode).toBe(status);
      expect((res.json() as { error: { code: string } }).error.code).toBe(errCode);
    },
  );

  it('PATCH returns 500 INTERNAL when the post-write read fails', async () => {
    // PATCH's only userStore.findById call is the post-write "echo the
    // merged view" read — nulling it out simulates the row vanishing between
    // the write and the re-read.
    userStore.findById = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { aggregator: { name: 'Post Write Fail' } },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });
});
