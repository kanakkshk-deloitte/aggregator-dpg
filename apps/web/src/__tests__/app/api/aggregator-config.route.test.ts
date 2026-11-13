/**
 * BFF route test: GET /api/aggregator-config.
 *
 * Unauthenticated, operator-public proxy — no session/service-token
 * involved. Asserts JSON/non-JSON passthrough and the 503 mapping when the
 * upstream fetch fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/aggregator-config/route';

describe('GET /api/aggregator-config', () => {
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

  it('forwards the JSON config verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ brand: { name: 'Blue Dots' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await GET(new Request('http://localhost/api/aggregator-config') as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brand?: { name?: string } };
    expect(body.brand?.name).toBe('Blue Dots');
  });

  it('passes through a non-JSON upstream response as text', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('plain text', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ) as unknown as typeof fetch;

    const res = await GET(new Request('http://localhost/api/aggregator-config') as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain text');
  });

  it('passes an upstream error status through verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'CONFIG_MISSING' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await GET(new Request('http://localhost/api/aggregator-config') as never);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIG_MISSING');
  });

  it('returns a 503 envelope when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const res = await GET(new Request('http://localhost/api/aggregator-config') as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.error).toBe('ServiceUnavailable');
    expect(body.code).toBe('AGGREGATOR_CONFIG_UPSTREAM_FAILED');
  });
});
