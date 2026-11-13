/**
 * BFF route test: GET/PATCH /api/aggregator/profile/me.
 *
 * Authenticated proxy over `callApi` — the session/token plumbing is
 * `callApi`'s job (covered by its own unit tests), so here we mock
 * `callApi` directly and assert: passthrough shape, the `no active
 * session` → 401 mapping, and the generic-throw → 503 mapping. Also
 * covers PATCH's own bad-JSON guard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET, PATCH } from '@/app/api/aggregator/profile/me/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/aggregator/profile/me', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the upstream profile payload', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { aggregator_id: 'a1', name: 'Jane' }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name?: string };
    expect(body.name).toBe('Jane');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/aggregators/profile/me', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NO_ACTIVE_SESSION');
  });

  it('returns 503 when the upstream call fails for another reason', async () => {
    mockCallApi.mockRejectedValue(new Error('ECONNRESET'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PROFILE_UPSTREAM_FAILED');
  });
});

describe('PATCH /api/aggregator/profile/me', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the partial-update body and upstream response', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { updated: true }));
    const req = new Request('http://localhost/api/aggregator/profile/me', {
      method: 'PATCH',
      body: JSON.stringify({ phone: '+911234567890' }),
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/aggregators/profile/me', {
      method: 'PATCH',
      body: { phone: '+911234567890' },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/aggregator/profile/me', {
      method: 'PATCH',
      body: 'not json',
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/aggregator/profile/me', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/aggregator/profile/me', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(503);
  });
});
