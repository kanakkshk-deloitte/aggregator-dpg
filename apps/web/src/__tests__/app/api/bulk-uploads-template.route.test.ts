/**
 * BFF route test: GET /api/bulk-uploads/template.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/template/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/bulk-uploads/template', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the CSV template with content-type/disposition preserved', async () => {
    mockCallApi.mockResolvedValue(
      new Response('name,email\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="seeker_template.csv"',
        },
      }),
    );
    const res = await GET(
      new NextRequest(
        'http://localhost/api/bulk-uploads/template?participant_type=seeker',
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="seeker_template.csv"',
    );
    expect(await res.text()).toBe('name,email\n');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/template?participant_type=seeker', {
      method: 'GET',
    });
  });

  it('forwards a workbook byte-for-byte, without decoding it as UTF-8', async () => {
    // The one change in this route whose failure mode is silent corruption. An
    // XLSX is a ZIP, so its bytes are arbitrary — `await upstream.text()`
    // decodes them as UTF-8 and every byte outside the ASCII range becomes
    // U+FFFD, producing a download that opens as a broken file rather than an
    // error. Every other case here uses an ASCII body, so reverting
    // `.arrayBuffer()` would leave all of them green.
    const zipHeaderAndHighBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
    mockCallApi.mockResolvedValue(
      new Response(zipHeaderAndHighBytes, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': 'attachment; filename="seeker-template.xlsx"',
        },
      }),
    );
    const res = await GET(
      new NextRequest(
        'http://localhost/api/bulk-uploads/template?participant_type=seeker&format=xlsx',
      ) as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(zipHeaderAndHighBytes);
  });

  it('falls back to a default filename/content-type when upstream omits them', async () => {
    const upstream = new Response('name,email\n', { status: 200 });
    upstream.headers.delete('content-type');
    mockCallApi.mockResolvedValue(upstream);
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="template.csv"');
  });

  it('returns the upstream error body verbatim on a non-2xx response', async () => {
    mockCallApi.mockResolvedValue(new Response('bad participant_type', { status: 400 }));
    const res = await GET(
      new NextRequest('http://localhost/api/bulk-uploads/template?participant_type=bogus') as never,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('bad participant_type');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(503);
  });
});
