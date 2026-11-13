/**
 * BFF route test: POST /api/bulk-uploads/[id]/start.
 *
 * Unlike sibling routes, this handler swallows a bad-JSON body into `{}`
 * (`req.json().catch(() => ({}))`) rather than returning 400 — covered
 * explicitly below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/bulk-uploads/[id]/start/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/bulk-uploads/[id]/start', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the attestation body to the encoded id path', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { status: 'queued' }));
    const req = new Request('http://localhost/api/bulk-uploads/u 1/start', {
      method: 'POST',
      body: JSON.stringify({ attestation: true }),
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: 'u 1' }) });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/u%201/start', {
      method: 'POST',
      body: { attestation: true },
    });
  });

  it('defaults to an empty body when the request has no/invalid JSON', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { status: 'queued' }));
    const req = new Request('http://localhost/api/bulk-uploads/u1/start', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: 'u1' }) });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/u1/start', {
      method: 'POST',
      body: {},
    });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/bulk-uploads/u1/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: 'u1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/bulk-uploads/u1/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: 'u1' }) });
    expect(res.status).toBe(503);
  });
});
