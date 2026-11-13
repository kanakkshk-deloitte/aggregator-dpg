/**
 * BFF route test: POST /api/links/[id]/deactivate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/links/[id]/deactivate/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/links/[id]/deactivate', () => {
  afterEach(() => vi.clearAllMocks());

  it('deactivates the link at the encoded id path', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { id: 'l 1', status: 'retired' }));
    const res = await POST(new Request('http://localhost/api/links/l 1/deactivate') as never, {
      params: Promise.resolve({ id: 'l 1' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/links/l%201/deactivate', { method: 'POST' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await POST(new Request('http://localhost/api/links/l1/deactivate') as never, {
      params: Promise.resolve({ id: 'l1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await POST(new Request('http://localhost/api/links/l1/deactivate') as never, {
      params: Promise.resolve({ id: 'l1' }),
    });
    expect(res.status).toBe(503);
  });
});
