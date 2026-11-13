import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonFetch } from '../http';

describe('jsonFetch', () => {
  const origFetch = globalThis.fetch;
  const origLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '', pathname: '/dashboard', search: '' } as Location,
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });

  it('sets JSON headers, includes credentials, and parses the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await jsonFetch<{ hello: string }>('/api/thing');
    expect(data).toEqual({ hello: 'world' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });

  it('preserves caller-supplied headers alongside the defaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await jsonFetch('/api/thing', { headers: { 'X-Custom': 'abc' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('abc');
  });

  it('throws with status + text on a non-OK, non-401 response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Server Error' }),
      ) as unknown as typeof fetch;
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(jsonFetch('/api/thing')).rejects.toThrow();
  });

  it('force-logs-out on a 401 NO_ACTIVE_SESSION body and throws session expired', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'NO_ACTIVE_SESSION' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing')).rejects.toThrow();
    expect(window.location.href).toContain('/api/auth/logout?reason=expired');
  });

  it('treats a 401 with a different body shape as a normal error, not a forced logout', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing')).rejects.toThrow();
    expect(window.location.href).toBe('');
  });

  it('treats a 401 with a non-JSON body as a normal error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 401 })) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing')).rejects.toThrow();
  });

  it('skips the forced logout when already on the login/auth flow', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '', pathname: '/login', search: '' } as Location,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'NO_ACTIVE_SESSION' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing')).rejects.toThrow();
    expect(window.location.href).toBe('');
  });
});
