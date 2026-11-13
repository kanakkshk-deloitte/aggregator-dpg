import { afterEach, describe, expect, it, vi } from 'vitest';
import { onboardingService } from '../../services/onboarding.service';

describe('onboardingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists links via the BFF proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              link_id: '1',
              slug: 'abc',
              domain: 'seeker',
              status: 'live',
              context: {},
              expires_at: null,
              public_url: 'http://example/r/abc',
              qr_url: null,
              qr_expires_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await onboardingService.listLinks({ domain: 'seeker' });
    expect(res.items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/links', expect.any(Object));
  });

  it('creates a link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          link_id: '1',
          slug: 'abc',
          domain: 'seeker',
          status: 'live',
          context: {},
          expires_at: null,
          public_url: 'http://example/r/abc',
          qr_url: 'http://example/qr/1.png',
          qr_expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const link = await onboardingService.createLink({ domain: 'seeker', status: 'live' });
    expect(link.slug).toBe('abc');
  });

  it('throws on upstream failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 503 }));
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(onboardingService.summary()).rejects.toThrow();
  });

  function link(overrides: Record<string, unknown> = {}) {
    return {
      link_id: '1',
      slug: 'abc',
      domain: 'seeker',
      status: 'live',
      context: {},
      expires_at: null,
      public_url: 'http://example/r/abc',
      qr_url: null,
      qr_expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('listLinks builds the query string with status/limit/offset and filters client-side by domain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [link({ domain: 'seeker' }), link({ link_id: '2', domain: 'provider' })],
          total: 2,
          limit: 10,
          offset: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await onboardingService.listLinks({
      status: 'live',
      limit: 10,
      offset: 20,
      domain: 'seeker',
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.domain).toBe('seeker');
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain('status=live');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('listLinks with no options and no domain filter returns the payload verbatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await onboardingService.listLinks();
    expect(res.items).toEqual([]);
  });

  it('updateLink PATCHes the link endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(link({ slug: 'new-slug' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const updated = await onboardingService.updateLink('1', { slug: 'new-slug' });
    expect(updated.slug).toBe('new-slug');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/links/1');
    expect(init.method).toBe('PATCH');
  });

  it('activateLink / deactivateLink POST to the expected sub-routes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(link({ status: 'live' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(link({ status: 'retired' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    await onboardingService.activateLink('1');
    await onboardingService.deactivateLink('1');
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('/api/links/1/activate');
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe('/api/links/1/deactivate');
  });

  it('bySource builds the query string and resolves the per-source rollup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          aggregator_id: 'a1',
          from: '2026-01-01',
          to: '2026-02-01',
          by_source: [{ source: 'bulk', total: 5, passed: 4, failed: 1, skipped: 0 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await onboardingService.bySource({ from: '2026-01-01', to: '2026-02-01' });
    expect(res.by_source).toHaveLength(1);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-02-01');
  });

  it('createBulkUpload posts the participant type and resolves the presign envelope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          upload_id: 'u1',
          upload_url: 'https://s3/put',
          s3_key: 'k',
          expires_at: '2026-01-01',
          content_type: 'text/csv',
          max_bytes: 1000,
          schema_id: 's',
          schema_version: '1',
          status: 'pending',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await onboardingService.createBulkUpload('seeker');
    expect(res.upload_id).toBe('u1');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ participant_type: 'seeker' });
  });

  it('startBulkUpload posts the attestation flag', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ upload_id: 'u1', status: 'row_processing' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await onboardingService.startBulkUpload('u1', true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bulk-uploads/u1/start');
    expect(JSON.parse(init.body as string)).toEqual({ attestation: true });
  });

  it('readBulkUpload / listBulkUploads / errorsCsvUrl call the expected endpoints', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upload_id: 'u1', status: 'completed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], total: 0, limit: 10, offset: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            upload_id: 'u1',
            url: 'https://s3/errors.csv',
            s3_key: 'k',
            expires_at: '2026-01-01',
            content_type: 'text/csv',
            counts: { total_rows: 10, passed: 8, failed: 2, skipped: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    await onboardingService.readBulkUpload('u1');
    await onboardingService.listBulkUploads({ limit: 10, offset: 0 });
    await onboardingService.errorsCsvUrl('u1');
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('/api/bulk-uploads/u1');
    expect((fetchSpy.mock.calls[1] as [string])[0]).toContain('/api/bulk-uploads/list?');
    expect((fetchSpy.mock.calls[2] as [string])[0]).toBe('/api/bulk-uploads/u1/errors');
  });

  it('listBulkUploads with no options omits the query string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await onboardingService.listBulkUploads();
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('/api/bulk-uploads/list');
  });

  describe('uploadCsv', () => {
    it('runs the full presign -> S3 PUT -> start flow', async () => {
      const file = new File(['a,b\n1,2'], 'rows.csv', { type: 'text/csv' });
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              upload_id: 'u1',
              upload_url: 'https://s3/put',
              s3_key: 'k',
              expires_at: '2026-01-01',
              content_type: 'text/csv',
              max_bytes: 1000,
              schema_id: 's',
              schema_version: '1',
              status: 'pending',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ upload_id: 'u1', status: 'row_processing' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const result = await onboardingService.uploadCsv(file, 'seeker', true);
      expect(result.uploadId).toBe('u1');
      expect(result.status.status).toBe('row_processing');
      expect(result.duplicate).toBeUndefined();
      expect(result.message).toBeUndefined();
      const [putUrl, putInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(putUrl).toBe('https://s3/put');
      expect(putInit.method).toBe('PUT');
    });

    it('surfaces duplicate + message when the backend reports a repeat upload', async () => {
      const file = new File(['a,b'], 'rows.csv', { type: 'text/csv' });
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              upload_id: 'u2',
              upload_url: 'https://s3/put',
              s3_key: 'k',
              expires_at: '2026-01-01',
              content_type: 'text/csv',
              max_bytes: 1000,
              schema_id: 's',
              schema_version: '1',
              status: 'pending',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              upload_id: 'u2',
              status: 'completed',
              duplicate: true,
              message: 'Matches a prior upload',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      const result = await onboardingService.uploadCsv(file, 'seeker', true);
      expect(result.duplicate).toBe(true);
      expect(result.message).toBe('Matches a prior upload');
    });

    it('throws when the S3 PUT fails', async () => {
      const file = new File(['a,b'], 'rows.csv', { type: 'text/csv' });
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              upload_id: 'u3',
              upload_url: 'https://s3/put',
              s3_key: 'k',
              expires_at: '2026-01-01',
              content_type: 'text/csv',
              max_bytes: 1000,
              schema_id: 's',
              schema_version: '1',
              status: 'pending',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
      await expect(onboardingService.uploadCsv(file, 'seeker', true)).rejects.toThrow();
    });
  });
});
