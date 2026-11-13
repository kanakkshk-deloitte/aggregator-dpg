/**
 * BFF route test: GET /api/bulk-uploads/[id].
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/[id]/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/bulk-uploads/[id]', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the upload status keyed by (encoded) id', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { id: 'up 1', status: 'processing' }));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/up 1') as never, {
      params: Promise.resolve({ id: 'up 1' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/up%201', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/u1') as never, {
      params: Promise.resolve({ id: 'u1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/u1') as never, {
      params: Promise.resolve({ id: 'u1' }),
    });
    expect(res.status).toBe(503);
  });

  it('passes a 404 from upstream through verbatim', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/missing') as never, {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});
