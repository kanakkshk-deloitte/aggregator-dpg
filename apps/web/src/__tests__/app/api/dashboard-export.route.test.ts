/**
 * BFF route test: GET /api/dashboard/export.
 *
 * Exercises the CSV-vs-JSON-error branching: 2xx relays the CSV body with
 * content-type/disposition preserved; non-2xx is surfaced as JSON when the
 * upstream sends JSON, else as text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/dashboard/export/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/dashboard/export', () => {
  afterEach(() => vi.clearAllMocks());

  it('relays the CSV body with content-type/disposition on 2xx', async () => {
    mockCallApi.mockResolvedValue(
      new Response('id,name\n1,Jane\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="dashboard.csv"',
        },
      }),
    );
    const res = await GET(
      new NextRequest('http://localhost/api/dashboard/export?domain=seeker&status=at_risk'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="dashboard.csv"');
    expect(await res.text()).toBe('id,name\n1,Jane\n');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/dashboard/export?domain=seeker&status=at_risk', {
      method: 'GET',
      headers: { accept: 'text/csv' },
    });
  });

  it('surfaces a non-2xx JSON error envelope as JSON', async () => {
    mockCallApi.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'BAD_STATUS' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await GET(new NextRequest('http://localhost/api/dashboard/export'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_STATUS');
  });

  it('surfaces a non-2xx non-JSON error as text', async () => {
    mockCallApi.mockResolvedValue(new Response('server error', { status: 500 }));
    const res = await GET(new NextRequest('http://localhost/api/dashboard/export'));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('server error');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard/export'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard/export'));
    expect(res.status).toBe(503);
  });
});
