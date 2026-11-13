/**
 * BFF route test: POST /api/dashboard/export/profiles.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/dashboard/export/profiles/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('POST /api/dashboard/export/profiles', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the item_ids body and relays the CSV response', async () => {
    mockCallApi.mockResolvedValue(
      new Response('id,email\n1,a@x.com\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="profiles.csv"',
        },
      }),
    );
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: ['1', '2'], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="profiles.csv"');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      body: { item_ids: ['1', '2'], domain: 'seeker' },
    });
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx JSON error envelope as JSON', async () => {
    mockCallApi.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'TOO_MANY_IDS' } }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: [], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('TOO_MANY_IDS');
  });

  it('relays X-Export-Skipped-Count so the browser can report withheld rows', async () => {
    mockCallApi.mockResolvedValue(
      new Response('id,email\n1,a@x.com\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="profiles.csv"',
          'x-export-skipped-count': '2',
        },
      }),
    );
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: ['1', '2', '3'], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Export-Skipped-Count')).toBe('2');
  });

  it('omits X-Export-Skipped-Count when the API does not send one', async () => {
    mockCallApi.mockResolvedValue(
      new Response('id,email\n', {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      }),
    );
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: ['1'], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.headers.get('X-Export-Skipped-Count')).toBeNull();
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: ['1'], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/dashboard/export/profiles', {
      method: 'POST',
      body: JSON.stringify({ item_ids: ['1'], domain: 'seeker' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });
});
