/**
 * BFF route tests: GET /api/orgs, GET /api/orgs/parents and POST /api/org/register.
 *
 * Both attach a Keycloak service-account token and forward to the aggregator
 * API. We stub the service token and the upstream fetch, then assert the
 * forwarding shape + error passthrough.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/service-token', () => ({
  getServiceAccessToken: vi.fn(async () => 'svc-token'),
}));

import { GET } from '@/app/api/orgs/route';
import { POST } from '@/app/api/org/register/route';
import { GET as GET_PARENTS } from '@/app/api/orgs/parents/route';
import { getServiceAccessToken } from '@/lib/service-token';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('GET /api/orgs', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
    vi.mocked(getServiceAccessToken).mockResolvedValue('svc-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
    vi.clearAllMocks();
  });

  it('forwards the active-org list with a bearer service token', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(
        JSON.stringify({
          orgs: [{ id: 'o1', slug: 'enable-india-ab12', display_name: 'Enable India' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/orgs');
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgs: { id: string }[] };
    expect(body.orgs).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/orgs');
    const headers = (calls[0]!.init as { headers?: Record<string, string> }).headers ?? {};
    expect(headers['Authorization']).toBe('Bearer svc-token');
  });

  it('passes an upstream error status + envelope through verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'DB_UNAVAILABLE' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const res = await GET(new Request('http://localhost/api/orgs') as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('DB_UNAVAILABLE');
  });

  it('returns 503 when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await GET(new Request('http://localhost/api/orgs') as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('returns 503 when the service token cannot be obtained', async () => {
    vi.mocked(getServiceAccessToken).mockRejectedValueOnce(new Error('kc down'));
    const res = await GET(new Request('http://localhost/api/orgs') as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('IDP_UNAVAILABLE');
  });
});

describe('GET /api/orgs/parents', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
    vi.mocked(getServiceAccessToken).mockResolvedValue('svc-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
    vi.clearAllMocks();
  });

  it('forwards the parent list with a bearer service token, uncached', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(
        JSON.stringify({
          accepting: true,
          parents: [
            {
              id: 'r',
              name: 'Network',
              is_root: true,
              known_as_name: null,
              child_known_as_name: 'Aggregator',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const res = await GET_PARENTS(new Request('http://localhost/api/orgs/parents') as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepting: boolean; parents: { id: string }[] };
    expect(body.accepting).toBe(true);
    expect(body.parents.map((p) => p.id)).toEqual(['r']);
    expect(calls[0]!.url).toBe('http://api.test/v1/orgs/parents');
    const init = calls[0]!.init as { headers?: Record<string, string>; cache?: string };
    expect(init.headers?.['Authorization']).toBe('Bearer svc-token');
    expect(init.cache).toBe('no-store');
  });

  it('returns 503 when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await GET_PARENTS(new Request('http://localhost/api/orgs/parents') as never);
    expect(res.status).toBe(503);
  });
});

describe('POST /api/org/register', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
    vi.mocked(getServiceAccessToken).mockResolvedValue('svc-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
    vi.clearAllMocks();
  });

  it('forwards the body + service token to /v1/orgs/create', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(
        JSON.stringify({ org_id: 'o1', slug: 'enable-india-ab12', status: 'pending' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/org/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Enable India' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe('http://api.test/v1/orgs/create');
    const init = calls[0]!.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.['Authorization']).toBe('Bearer svc-token');
    expect(JSON.parse(init.body ?? '{}')).toMatchObject({ display_name: 'Enable India' });
  });

  it('passes ORG_SLUG_TAKEN through verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'ORG_SLUG_TAKEN' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const req = new Request('http://localhost/api/org/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Dup' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('ORG_SLUG_TAKEN');
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/org/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_JSON');
  });
});
