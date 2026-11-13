import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const getServiceAccessTokenMock = vi.fn();
vi.mock('@/lib/service-token', () => ({ getServiceAccessToken: getServiceAccessTokenMock }));

const { proxyServiceRequest } = await import('@/lib/bff-service-proxy');

describe('proxyServiceRequest', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    getServiceAccessTokenMock.mockReset();
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('forwards a GET and passes the JSON body + status through', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const req = new NextRequest('http://localhost/api/orgs');
    const res = await proxyServiceRequest(req, {
      path: '/v1/orgs',
      method: 'GET',
      route: 'GET /api/orgs',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('forwards a non-JSON upstream body (e.g. text/csv) verbatim', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv' } }),
      ) as unknown as typeof fetch;

    const req = new NextRequest('http://localhost/api/aggregator/register');
    const res = await proxyServiceRequest(req, {
      path: '/v1/export',
      method: 'GET',
      route: 'GET /api/export',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    await expect(res.text()).resolves.toBe('a,b\n1,2');
  });

  it('defaults the content-type on a non-JSON body with no upstream header at all', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    // Build a Response whose headers genuinely omit content-type (the plain
    // string-body constructor form auto-sets `text/plain;charset=UTF-8`,
    // which would mask the `contentType || 'text/plain'` fallback below).
    const blank = new Response('', { status: 200 });
    blank.headers.delete('content-type');
    globalThis.fetch = vi.fn().mockResolvedValue(blank) as unknown as typeof fetch;

    const req = new NextRequest('http://localhost/api/aggregator/register');
    const res = await proxyServiceRequest(req, {
      path: '/v1/export',
      method: 'GET',
      route: 'GET /api/export',
    });
    expect(res.headers.get('content-type')).toBe('text/plain');
  });

  it('parses and forwards a JSON POST body', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const req = new NextRequest('http://localhost/api/aggregator/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'X' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await proxyServiceRequest(req, {
      path: '/v1/aggregators/register',
      method: 'POST',
      route: 'POST /api/aggregator/register',
      forwardJsonBody: true,
    });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ name: 'X' }));
  });

  it('returns 400 BAD_JSON when the POST body is not valid JSON', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    const req = new NextRequest('http://localhost/api/aggregator/register', {
      method: 'POST',
      body: 'not-json{{',
      headers: { 'content-type': 'application/json' },
    });
    const res = await proxyServiceRequest(req, {
      path: '/v1/aggregators/register',
      method: 'POST',
      route: 'POST /api/aggregator/register',
      forwardJsonBody: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_JSON');
  });

  it('returns 503 IDP_UNAVAILABLE when the service token fetch fails', async () => {
    getServiceAccessTokenMock.mockRejectedValue(new Error('token endpoint down'));
    const req = new NextRequest('http://localhost/api/orgs');
    const res = await proxyServiceRequest(req, {
      path: '/v1/orgs',
      method: 'GET',
      route: 'GET /api/orgs',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDP_UNAVAILABLE');
  });

  it('returns 503 UPSTREAM_UNAVAILABLE with a custom offlineNoun when fetch throws', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const req = new NextRequest('http://localhost/api/orgs');
    const res = await proxyServiceRequest(req, {
      path: '/v1/orgs',
      method: 'GET',
      route: 'GET /api/orgs',
      offlineNoun: 'org directory',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { detail: string; code: string } };
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.error.detail).toContain('org directory');
  });

  it('reuses an inbound x-request-id header for tracing continuity', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ) as unknown as typeof fetch;
    const req = new NextRequest('http://localhost/api/orgs', {
      headers: { 'x-request-id': 'req-fixed-1' },
    });
    const res = await proxyServiceRequest(req, {
      path: '/v1/orgs',
      method: 'GET',
      route: 'GET /api/orgs',
    });
    expect(res.headers.get('x-request-id')).toBe('req-fixed-1');
  });

  it('passes the cache option through to the upstream fetch when set', async () => {
    getServiceAccessTokenMock.mockResolvedValue('svc-tok');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const req = new NextRequest('http://localhost/api/orgs');
    await proxyServiceRequest(req, {
      path: '/v1/orgs',
      method: 'GET',
      route: 'GET /api/orgs',
      cache: 'no-store',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});
