/**
 * BFF route test: GET /api/support/config.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/support/config/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/support/config', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the enabled flag', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { enabled: true }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled?: boolean };
    expect(body.enabled).toBe(true);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/support/config', { method: 'GET' });
  });

  it('reports disabled when SUPPORT_EMAIL is unset upstream', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { enabled: false }));
    const res = await GET();
    const body = (await res.json()) as { enabled?: boolean };
    expect(body.enabled).toBe(false);
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
