/**
 * BFF route test: POST /api/aggregator/register.
 *
 * Thin wrapper over `proxyServiceRequest` — asserts it is wired to the
 * correct upstream path/method with a service token, and that upstream
 * errors/outages pass through the shared proxy's envelope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/service-token', () => ({
  getServiceAccessToken: vi.fn(async () => 'svc-token'),
}));

import { POST } from '@/app/api/aggregator/register/route';
import { getServiceAccessToken } from '@/lib/service-token';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('POST /api/aggregator/register', () => {
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

  it('forwards the registration body to /v1/aggregator-registrations/create with a service token', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(JSON.stringify({ registration_id: 'r1', status: 'pending' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/aggregator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@x.com' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe('http://api.test/v1/aggregator-registrations/create');
    const init = calls[0]!.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.['Authorization']).toBe('Bearer svc-token');
    expect(JSON.parse(init.body ?? '{}')).toMatchObject({ name: 'Jane' });
  });

  it('passes an upstream validation error through verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED' } }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/aggregator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('returns 400 BAD_JSON on a malformed body', async () => {
    const req = new Request('http://localhost/api/aggregator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_JSON');
  });

  it('returns 503 when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/aggregator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('returns 503 when the service token cannot be obtained', async () => {
    vi.mocked(getServiceAccessToken).mockRejectedValueOnce(new Error('kc down'));
    const req = new Request('http://localhost/api/aggregator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('IDP_UNAVAILABLE');
  });
});
