/**
 * Route test: GET /brand-icon.
 *
 * Verifies the dynamic favicon reads `brand.primary_color` from the
 * aggregator-config upstream, falls back to the default blue when the
 * upstream is unavailable/malformed, and always emits a cacheable SVG.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET } from '@/app/brand-icon/route';

describe('GET /brand-icon', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the SVG tinted with the upstream primary_color', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ brand: { primary_color: '#00FF00' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    const svg = await res.text();
    expect(svg).toContain('#00FF00');
  });

  it('falls back to the default primary colour when upstream is not ok', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('#2563EB');
  });

  it('falls back to the default primary colour when upstream throws', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('#2563EB');
  });

  it('falls back to the default when the brand payload has no primary_color', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('#2563EB');
  });
});
