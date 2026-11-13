/**
 * BFF route test: PATCH /api/links/[id].
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { PATCH } from '@/app/api/links/[id]/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH /api/links/[id]', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the patch body to the encoded id path', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { id: 'l 1', label: 'Updated' }));
    const req = new Request('http://localhost/api/links/l 1', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Updated' }),
    });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'l 1' }) });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/links/l%201', {
      method: 'PATCH',
      body: { label: 'Updated' },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/links/l1', {
      method: 'PATCH',
      body: 'not json',
    });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'l1' }) });
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('passes through a 409 when the link is not editable', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(409, { error: { code: 'LINK_NOT_DRAFT' } }));
    const req = new Request('http://localhost/api/links/l1', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'l1' }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('LINK_NOT_DRAFT');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/links/l1', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'l1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/links/l1', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'l1' }) });
    expect(res.status).toBe(503);
  });
});
