/**
 * Unit tests for the Keycloak admin REST adapter.
 *
 * The adapter's `fetchImpl` constructor option is overridden with a
 * `vi.fn()` queue of canned `Response` objects — the same seam
 * `keycloak.integration.test.ts` documents for live runs, applied here with
 * a fake instead of a real Keycloak — so no network call is ever made.
 * Covers every public method's success path, the documented error-code
 * mappings (404/409/other HTTP status → typed `IdpError`), and the
 * transport-failure (`fetchImpl` throws) → `IDP_UNAVAILABLE` path required
 * by error-handling.md.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeycloakIdpAdmin } from './keycloak.js';

const BASE_URL = 'http://kc.local';
const REALM = 'aggregator';

function tokenResponse(expiresIn = 300): Response {
  return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: expiresIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function makeAdmin(fetchImpl: typeof fetch): KeycloakIdpAdmin {
  return new KeycloakIdpAdmin({
    baseUrl: BASE_URL,
    realm: REALM,
    clientId: 'aggregator-api',
    clientSecret: 'client-secret-value',
    fetchImpl,
  });
}

describe('KeycloakIdpAdmin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  describe('token handling', () => {
    it('fetches a token via client_credentials and reuses it across calls', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      await admin.findByEmail('a@b.com');
      await admin.findByEmail('c@d.com');
      // 1 token fetch + 2 lookups = 3 total; token is cached, not refetched.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const tokenCall = fetchMock.mock.calls[0]?.[0] as string;
      expect(tokenCall).toBe(`${BASE_URL}/realms/${REALM}/protocol/openid-connect/token`);
      const body = fetchMock.mock.calls[0]?.[1]?.body as string;
      expect(body).toContain('grant_type=client_credentials');
      expect(body).toContain('client_id=aggregator-api');
    });

    it('returns AUTH_FAILED when the token endpoint responds non-2xx', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(401));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByEmail('a@b.com');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('AUTH_FAILED');
    });

    it('returns IDP_UNAVAILABLE when the token fetch throws (transport failure)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'a@b.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('IDP_UNAVAILABLE');
        expect(r.error.message).toContain('ECONNREFUSED');
      }
    });
  });

  describe('createUser', () => {
    it('creates a user and re-reads the full representation', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/users/u-1` }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ id: 'u-1', username: 'a@b.com', email: 'a@b.com', enabled: true }),
        );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({
        email: 'a@b.com',
        phone: '+919876543210',
        firstName: 'A',
        lastName: 'B',
        attributes: { org_id: 'org-1', tags: ['x', 'y'] },
        requiredActions: ['UPDATE_PASSWORD'],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.id).toBe('u-1');
        expect(r.value.email).toBe('a@b.com');
      }
      const createBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(createBody.attributes).toEqual({
        phoneNumber: ['+919876543210'],
        org_id: ['org-1'],
        tags: ['x', 'y'],
      });
      expect(createBody.requiredActions).toEqual(['UPDATE_PASSWORD']);
    });

    it('defaults username to email and enabled to true when unset', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/users/u-2` }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'u-2', username: 'x@y.com', email: 'x@y.com' }));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      await admin.createUser({ email: 'x@y.com' });
      const createBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(createBody.username).toBe('x@y.com');
      expect(createBody.enabled).toBe(true);
      expect(createBody.attributes).toEqual({});
    });

    it('returns USER_EXISTS on a 409 conflict', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(409));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'dup@b.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_EXISTS');
    });

    it('returns INVALID_NAME when Keycloak refuses a character in the name', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          textResponse(
            '{"field":"lastName","errorMessage":"error-person-name-invalid-character","params":["lastName"]}',
            400,
          ),
        );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'a@x.test', lastName: '(Ops)' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_NAME');
    });

    it('returns BAD_REQUEST with truncated body text on an unexpected status', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(textResponse('field "email" is invalid', 400));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'bad' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('BAD_REQUEST');
        expect(r.error.message).toContain('field "email" is invalid');
      }
    });

    it('returns IDP_UNAVAILABLE when the 201 response has no Location header', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(201));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'a@b.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('IDP_UNAVAILABLE');
        expect(r.error.message).toContain('Location');
      }
    });

    it('propagates a transport failure from the create POST', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('timeout'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'a@b.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('returns IDP_UNAVAILABLE when the post-create readUser fails', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/users/u-1` }),
        )
        .mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createUser({ email: 'a@b.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });
  });

  describe('findByEmail', () => {
    it('returns null when no user matches', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse([]));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByEmail('nope@x.com');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
      const url = fetchMock.mock.calls[1]?.[0] as string;
      expect(url).toContain('email=nope%40x.com');
      expect(url).toContain('exact=true');
      expect(url).toContain('max=1');
    });

    it('returns the matching user, falling back to the query email when unset', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([{ id: 'u-1', username: 'a' }]));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByEmail('a@b.com');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value?.email).toBe('a@b.com');
    });

    it('returns IDP_UNAVAILABLE on a non-ok HTTP response', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByEmail('a@b.com');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByEmail('a@b.com');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });
  });

  describe('findById', () => {
    it('returns the user representation', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'u-1', username: 'a', email: 'a@b.com' }));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findById('u-1');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value?.id).toBe('u-1');
    });

    it('returns null on 404', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findById('missing');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
    });

    it('returns IDP_UNAVAILABLE on other non-ok status', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(503));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findById('u-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('boom'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findById('u-1');
      expect(r.ok).toBe(false);
    });
  });

  describe('findByAttribute', () => {
    it('returns the exact match when the attribute value is present', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        jsonResponse([
          { id: 'u-1', username: 'a', attributes: { aggregator_id: ['agg-1'] } },
          { id: 'u-2', username: 'b', attributes: { aggregator_id: ['agg-2'] } },
        ]),
      );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByAttribute('aggregator_id', 'agg-2');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value?.id).toBe('u-2');
      const url = fetchMock.mock.calls[1]?.[0] as string;
      expect(url).toContain('q=aggregator_id%3Aagg-2');
    });

    it('returns null when Keycloak returns partial matches but none exact', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          jsonResponse([{ id: 'u-1', username: 'a', attributes: { aggregator_id: ['agg-99'] } }]),
        );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByAttribute('aggregator_id', 'agg-2');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeNull();
    });

    it('returns IDP_UNAVAILABLE on a non-ok HTTP response', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findByAttribute('aggregator_id', 'agg-2');
      expect(r.ok).toBe(false);
    });
  });

  describe('enableUser / disableUser', () => {
    it('enableUser sets enabled=true', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.enableUser('u-1');
      expect(r.ok).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(body).toEqual({ enabled: true });
    });

    it('disableUser sets enabled=false', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.disableUser('u-1');
      expect(r.ok).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(body).toEqual({ enabled: false });
    });

    it('returns USER_NOT_FOUND on 404', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.enableUser('missing');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns IDP_UNAVAILABLE on an unexpected status', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.enableUser('u-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('x'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.disableUser('u-1');
      expect(r.ok).toBe(false);
    });
  });

  describe('deleteUser', () => {
    it('deletes successfully on 204', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteUser('u-1');
      expect(r.ok).toBe(true);
    });

    it('returns USER_NOT_FOUND on 404', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteUser('missing');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns IDP_UNAVAILABLE on an unexpected status', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteUser('u-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteUser('u-1');
      expect(r.ok).toBe(false);
    });
  });

  describe('setAttributes / setUserDecision', () => {
    it('merges attributes onto the existing user, preserving unrelated keys', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'u-1',
            username: 'a',
            email: 'a@b.com',
            enabled: true,
            firstName: 'A',
            attributes: { org_id: ['org-1'], keep: ['me'] },
          }),
        )
        .mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.setAttributes('u-1', {
        org_id: 'org-2',
        removed: null,
        list: ['a', 'b'],
      });
      expect(r.ok).toBe(true);
      const putBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
      expect(putBody.attributes).toEqual({ keep: ['me'], org_id: ['org-2'], list: ['a', 'b'] });
      expect(putBody.firstName).toBe('A');
      expect(putBody.id).toBe('u-1');
    });

    it('propagates a failure reading the current user', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.setAttributes('u-1', { a: '1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('returns USER_NOT_FOUND when the write PUT 404s', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'u-1', username: 'a', email: 'a@b.com' }))
        .mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.setAttributes('u-1', { a: '1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns IDP_UNAVAILABLE when the write PUT fails with another status', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'u-1', username: 'a', email: 'a@b.com' }))
        .mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.setAttributes('u-1', { a: '1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('setUserDecision writes only the decision_made attribute', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'u-1', username: 'a', email: 'a@b.com' }))
        .mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.setUserDecision('u-1', 'approved');
      expect(r.ok).toBe(true);
      const putBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
      expect(putBody.attributes.decision_made).toEqual(['approved']);
    });
  });

  describe('createGroup', () => {
    it('creates a group and persists attributes via a follow-up PUT', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/groups/g-1` }),
        )
        .mockResolvedValueOnce(emptyResponse(200));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-acme', { org_id: 'org-1', region: ['east', 'west'] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.id).toBe('g-1');
      const putBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
      expect(putBody.attributes).toEqual({ org_id: ['org-1'], region: ['east', 'west'] });
    });

    it('skips the attribute follow-up PUT when no attributes are given', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/groups/g-2` }),
        );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-acme');
      expect(r.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns BAD_REQUEST on a 409 create conflict', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(textResponse('group exists', 409));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('dup');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('BAD_REQUEST');
    });

    it('returns IDP_UNAVAILABLE on a non-409 create failure', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(textResponse('server error', 500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-x');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('returns IDP_UNAVAILABLE when the 201 create response has no Location', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(201));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-x');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('Location');
    });

    it('returns IDP_UNAVAILABLE when the follow-up attribute PUT fails', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/groups/g-3` }),
        )
        .mockResolvedValueOnce(textResponse('write failed', 500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-x', { a: '1' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('IDP_UNAVAILABLE');
        expect(r.error.message).toContain('write failed');
      }
    });

    it('propagates a transport failure on the follow-up attribute PUT', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          emptyResponse(201, { location: `${BASE_URL}/admin/realms/${REALM}/groups/g-4` }),
        )
        .mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-x', { a: '1' });
      expect(r.ok).toBe(false);
    });

    it('propagates a transport failure on the initial create POST', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.createGroup('org-x');
      expect(r.ok).toBe(false);
    });
  });

  describe('deleteGroup', () => {
    it('deletes successfully', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteGroup('g-1');
      expect(r.ok).toBe(true);
    });

    it('treats a 404 as idempotent success', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteGroup('gone');
      expect(r.ok).toBe(true);
    });

    it('returns IDP_UNAVAILABLE on a non-404 failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteGroup('g-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.deleteGroup('g-1');
      expect(r.ok).toBe(false);
    });
  });

  describe('addUserToGroup', () => {
    it('adds the user successfully', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.addUserToGroup('u-1', 'g-1');
      expect(r.ok).toBe(true);
    });

    it('returns USER_NOT_FOUND on 404', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.addUserToGroup('u-1', 'g-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns IDP_UNAVAILABLE on other failures', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.addUserToGroup('u-1', 'g-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.addUserToGroup('u-1', 'g-1');
      expect(r.ok).toBe(false);
    });
  });

  describe('assignRealmRole', () => {
    it('resolves the role then maps it onto the user', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'role-1', name: 'org_owner' }))
        .mockResolvedValueOnce(emptyResponse(204));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(true);
      const mapBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
      expect(mapBody).toEqual([{ id: 'role-1', name: 'org_owner' }]);
    });

    it('returns BAD_REQUEST when the role does not exist (404)', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'no_such_role');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('BAD_REQUEST');
    });

    it('returns IDP_UNAVAILABLE on a non-404 role lookup failure', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure on the role lookup', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(false);
    });

    it('returns USER_NOT_FOUND when the role-mapping POST 404s', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'role-1', name: 'org_owner' }))
        .mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns IDP_UNAVAILABLE when the role-mapping POST fails otherwise', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'role-1', name: 'org_owner' }))
        .mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('propagates a transport failure on the role-mapping POST', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ id: 'role-1', name: 'org_owner' }))
        .mockRejectedValueOnce(new Error('down'));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.assignRealmRole('u-1', 'org_owner');
      expect(r.ok).toBe(false);
    });
  });

  describe('constructor fetchImpl default', () => {
    it('falls back to globalThis.fetch when no fetchImpl override is given', () => {
      const admin = new KeycloakIdpAdmin({
        baseUrl: BASE_URL,
        realm: REALM,
        clientId: 'aggregator-api',
        clientSecret: 'secret',
      });
      expect(admin).toBeInstanceOf(KeycloakIdpAdmin);
    });
  });

  describe('findGroupByName / removeUserFromGroup (0028 root mirror)', () => {
    it('returns the exact-name group with its attributes', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
        jsonResponse([
          { id: 'g-other', name: 'org-network-2', attributes: {} },
          { id: 'g-1', name: 'org-network', attributes: { org_id: ['org-1'] } },
        ]),
      );
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findGroupByName('org-network');
      expect(r).toEqual({ ok: true, value: { id: 'g-1', attributes: { org_id: ['org-1'] } } });
      const url = String(fetchMock.mock.calls[1]?.[0]);
      expect(url).toContain('search=org-network');
      expect(url).toContain('exact=true');
    });

    it('returns null when no group has that exact name', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse([]));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      expect(await admin.findGroupByName('org-x')).toEqual({ ok: true, value: null });
    });

    it('maps a failed lookup to IDP_UNAVAILABLE', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.findGroupByName('org-x');
      expect(r.ok || r.error.code).toBe('IDP_UNAVAILABLE');
    });

    it('removes a membership, treating an already-gone one as success', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(emptyResponse(404));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      expect((await admin.removeUserFromGroup('u-1', 'g-1')).ok).toBe(true);
      expect((await admin.removeUserFromGroup('u-1', 'g-1')).ok).toBe(true);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    });

    it('maps another removal failure to IDP_UNAVAILABLE', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse(500));
      const admin = makeAdmin(fetchMock as unknown as typeof fetch);
      const r = await admin.removeUserFromGroup('u-1', 'g-1');
      expect(r.ok || r.error.code).toBe('IDP_UNAVAILABLE');
    });
  });
});
