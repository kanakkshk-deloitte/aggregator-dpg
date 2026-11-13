/**
 * BFF route test: POST /api/[org]/[slug]/submit.
 *
 * Anonymous participant submission proxy — no service token. Asserts body
 * forwarding, the request-id/xff/user-agent forwarding contract, the
 * payload-size cap, malformed-JSON handling, and the 503 upstream mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/[org]/[slug]/submit/route';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('POST /api/[org]/[slug]/submit', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
  });

  it('forwards the body and client signals to the upstream registration endpoint', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(JSON.stringify({ status: 'submitted' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/acme/winter25/submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-abc',
        'x-forwarded-for': '10.0.0.9',
        'user-agent': 'vitest',
      },
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('submitted');

    expect(calls[0]!.url).toBe('http://api.test/public/v1/aggregators/acme/registrations/winter25');
    const init = calls[0]!.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.['x-request-id']).toBe('req-abc');
    expect(init.headers?.['x-forwarded-for']).toBe('10.0.0.9');
    expect(init.headers?.['user-agent']).toBe('vitest');
    expect(JSON.parse(init.body ?? '{}')).toMatchObject({ name: 'Jane' });
    expect(res.headers.get('x-request-id')).toBe('req-abc');
  });

  it('treats an empty body as {}', async () => {
    const calls: { init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      calls.push({ init: init ?? null });
      return new Response(JSON.stringify({ status: 'submitted' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/acme/winter25/submit', { method: 'POST' });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(201);
    const init = calls[0]!.init as { body?: string };
    expect(init.body).toBe('{}');
  });

  it('returns 400 BAD_JSON on malformed body', async () => {
    const req = new Request('http://localhost/api/acme/winter25/submit', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_JSON');
  });

  it('returns 413 PAYLOAD_TOO_LARGE when the body exceeds the byte cap', async () => {
    const oversized = JSON.stringify({ blob: 'x'.repeat(32_100) });
    const req = new Request('http://localhost/api/acme/winter25/submit', {
      method: 'POST',
      body: oversized,
    });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 503 UPSTREAM_UNAVAILABLE when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/acme/winter25/submit', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('passes through a non-JSON upstream response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        }),
    ) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/acme/winter25/submit', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jane' }),
    });
    const res = await POST(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('rate limited');
  });
});
