/**
 * BFF route test: POST /api/bulk-uploads.
 *
 * Authenticated proxy over `callApi` — mocks `callApi` directly and
 * asserts passthrough shape, bad-JSON guard, and the session/upstream
 * failure mappings.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/bulk-uploads/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/bulk-uploads', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the body and returns the presigned upload payload', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(201, { upload_id: 'u1', put_url: 'https://s3/x' }));
    const req = new Request('http://localhost/api/bulk-uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: 'seekers.csv', participant_type: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload_id?: string };
    expect(body.upload_id).toBe('u1');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads', {
      method: 'POST',
      body: { filename: 'seekers.csv', participant_type: 'seeker' },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/bulk-uploads', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/bulk-uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: 'x.csv' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/bulk-uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: 'x.csv' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });

  it('passes an upstream error status through verbatim', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_TYPE' } }));
    const req = new Request('http://localhost/api/bulk-uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: 'x.csv' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_TYPE');
  });
});
