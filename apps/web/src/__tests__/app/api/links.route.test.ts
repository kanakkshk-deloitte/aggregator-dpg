/**
 * BFF route test: GET/POST /api/links.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET, POST } from '@/app/api/links/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/links', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the status/pagination query string', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { links: [] }));
    const res = await GET(new NextRequest('http://localhost/api/links?status=live&limit=10'));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/links?status=live&limit=10', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/links'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/links'));
    expect(res.status).toBe(503);
  });
});

describe('POST /api/links', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the create body to /v1/links/create', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(201, { id: 'l1', status: 'draft' }));
    const req = new Request('http://localhost/api/links', {
      method: 'POST',
      body: JSON.stringify({ label: 'Spring cohort' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/links/create', {
      method: 'POST',
      body: { label: 'Spring cohort' },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/links', { method: 'POST', body: 'not json' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/links', {
      method: 'POST',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/links', {
      method: 'POST',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });
});
