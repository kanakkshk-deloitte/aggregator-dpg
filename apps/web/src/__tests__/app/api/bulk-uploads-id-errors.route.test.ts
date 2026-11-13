/**
 * BFF route test: GET /api/bulk-uploads/[id]/errors.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/[id]/errors/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/bulk-uploads/[id]/errors', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the errors.csv download from the encoded id path', async () => {
    mockCallApi.mockResolvedValue(
      new Response('row,error\n2,invalid_email', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      }),
    );
    const res = await GET(new Request('http://localhost/api/bulk-uploads/u 1/errors') as never, {
      params: Promise.resolve({ id: 'u 1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('invalid_email');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/u%201/errors.csv', {
      method: 'GET',
    });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/u1/errors') as never, {
      params: Promise.resolve({ id: 'u1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new Request('http://localhost/api/bulk-uploads/u1/errors') as never, {
      params: Promise.resolve({ id: 'u1' }),
    });
    expect(res.status).toBe(503);
  });
});
