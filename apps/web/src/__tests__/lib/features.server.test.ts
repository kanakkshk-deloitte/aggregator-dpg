import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The logger writes through a transport worker that can exit under the dev
// server; a throwing `warn` must not escape the fail-safe path.
const warn = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { getAggregatorFeatures, customRolesEnabled } from '@/lib/features.server';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('features.server', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('reports custom roles on when the api flag is true', async () => {
    // A fresh Response per call: a body can be read once.
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () =>
        json({ features: { custom_roles: true } }),
      ) as unknown as typeof fetch;
    await expect(customRolesEnabled()).resolves.toBe(true);
    await expect(getAggregatorFeatures()).resolves.toEqual({ custom_roles: true });
  });

  it('reports custom roles off when the api flag is false', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(json({ features: { custom_roles: false } })) as unknown as typeof fetch;
    await expect(customRolesEnabled()).resolves.toBe(false);
  });

  it('fails safe to off when the features block is absent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(json({ brand: { short_name: 'Blue Dots' } })) as unknown as typeof fetch;
    await expect(customRolesEnabled()).resolves.toBe(false);
  });

  it('fails safe to off on a non-2xx response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(customRolesEnabled()).resolves.toBe(false);
  });

  it('fails safe to off when the fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(customRolesEnabled()).resolves.toBe(false);
  });

  it('still fails safe when the logger itself throws on the error path', async () => {
    warn.mockImplementation(() => {
      throw new Error('the worker has exited');
    });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(getAggregatorFeatures()).resolves.toEqual({ custom_roles: false });
    warn.mockReset();
  });

  it('still fails safe when the logger throws on a non-2xx response', async () => {
    warn.mockImplementation(() => {
      throw new Error('the worker has exited');
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(getAggregatorFeatures()).resolves.toEqual({ custom_roles: false });
    warn.mockReset();
  });
});
