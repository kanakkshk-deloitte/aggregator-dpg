/**
 * BFF route test: POST /api/support.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/support/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/support', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the support submission body', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { sent: true }));
    const req = new Request('http://localhost/api/support', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Jane',
        type: 'bug',
        details: 'Something broke',
        consent: true,
      }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/support', {
      method: 'POST',
      body: { name: 'Jane', type: 'bug', details: 'Something broke', consent: true },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/support', { method: 'POST', body: 'not json' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 502 verbatim when the API mailer send fails', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(502, { error: { code: 'SUPPORT_SEND_FAILED' } }));
    const req = new Request('http://localhost/api/support', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jane', type: 'bug', details: 'x', consent: true }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SUPPORT_SEND_FAILED');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/support', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jane', type: 'bug', details: 'x', consent: true }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/support', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jane', type: 'bug', details: 'x', consent: true }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });
});
