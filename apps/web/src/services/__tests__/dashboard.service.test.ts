import { describe, it, expect, vi, afterEach } from 'vitest';
import { dashboardService, triggerCsvDownload } from '../dashboard.service';

/** Captures a rejected promise's Error and returns its message, for
 * environments where `.rejects.toThrow(/regex/)` loses the message text. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected promise to reject');
}

/**
 * Reads a Blob as text across both Blob implementations in play here.
 *
 * Two incompatible ones coexist: `Response.blob()` returns Node's (undici)
 * Blob, while `FileReader` comes from jsdom and type-checks its argument
 * against jsdom's own Blob — so passing the former throws "parameter 1 is not
 * of type 'Blob'". Node's Blob does have `.text()` (the comment this replaces
 * assumed every Blob here was jsdom's, which has none), so prefer it and keep
 * the FileReader path for a Blob that lacks it.
 */
function readBlobText(blob: Blob): Promise<string> {
  if (typeof (blob as { text?: unknown }).text === 'function') {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('dashboardService.dashboard', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws when domain is missing', async () => {
    await expect(dashboardService.dashboard()).rejects.toThrow();
  });

  it('builds the query string with page/limit/status/refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ by_domain: {}, metadata: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await dashboardService.dashboard({
      domain: 'seeker',
      page: 2,
      limit: 25,
      status: 'active',
      lifecycle: 'draft',
      refresh: true,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('domain=seeker');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=25');
    expect(url).toContain('status=active');
    expect(url).toContain('lifecycle=draft');
    expect(url).toContain('refresh=true');
  });

  it('omits status/refresh when unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ by_domain: {}, metadata: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await dashboardService.dashboard({ domain: 'seeker' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).not.toContain('status=');
    expect(url).not.toContain('lifecycle=');
    expect(url).not.toContain('refresh=');
  });
});

describe('dashboardService.dashboardExport', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws when domain is missing', async () => {
    await expect(dashboardService.dashboardExport()).rejects.toThrow();
  });

  it('resolves the blob + filename from Content-Disposition', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('id,name\n1,a', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="export.csv"' },
      }),
    ) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker', status: 'active' });
    expect(result.filename).toBe('export.csv');
    expect(await readBlobText(result.blob)).toBe('id,name\n1,a');
  });

  it('falls back to a default filename when Content-Disposition is absent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('data', { status: 200 })) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(result.filename).toMatch(/^aggregator-dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('parses the RFC 6266 filename* form', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data', {
        status: 200,
        headers: { 'content-disposition': "attachment; filename*=UTF-8''export%20file.csv" },
      }),
    ) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(result.filename).toBe('export file.csv');
  });

  it('stops the filename* value at the next parameter', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data', {
        status: 200,
        headers: {
          'content-disposition': "attachment; filename*=UTF-8''a%20b.csv; size=42",
        },
      }),
    ) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(result.filename).toBe('a b.csv');
  });

  it('falls back to the plain filename when filename* has no charset delimiter', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename*=broken; filename="plain.csv"',
        },
      }),
    ) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(result.filename).toBe('plain.csv');
  });

  it('falls back to the plain filename when filename* is not valid percent-encoding', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename*=UTF-8\'\'%E0%A4%A; filename="plain.csv"',
        },
      }),
    ) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(result.filename).toBe('plain.csv');
  });

  it('resolves a pathological non-terminating filename* header without hanging', async () => {
    // Regression guard for the super-linear parse this replaced: a long run of
    // non-quote characters after `filename*=` that never reaches the `''`
    // charset delimiter used to be rescanned from every start offset.
    const hostile = `attachment; filename*=${'a'.repeat(50_000)}`;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('data', { status: 200, headers: { 'content-disposition': hostile } }),
      ) as unknown as typeof fetch;
    const started = performance.now();
    const result = await dashboardService.dashboardExport({ domain: 'seeker' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.filename).toMatch(/^aggregator-dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('surfaces the upstream JSON error detail on failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { detail: 'quota exceeded' } }), { status: 429 }),
      ) as unknown as typeof fetch;
    const message = await rejectionMessage(dashboardService.dashboardExport({ domain: 'seeker' }));
    expect(message).toBe('quota exceeded');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const message = await rejectionMessage(dashboardService.dashboardExport({ domain: 'seeker' }));
    expect(message).toBe('dashboard export failed: 500');
  });
});

describe('dashboardService.dashboardExportProfiles', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws when domain or itemIds are missing', async () => {
    await expect(
      dashboardService.dashboardExportProfiles({ domain: '', itemIds: ['a'] }),
    ).rejects.toThrow();
    await expect(
      dashboardService.dashboardExportProfiles({ domain: 'seeker', itemIds: [] }),
    ).rejects.toThrow();
  });

  it('posts the item ids and resolves the blob + filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('item_id\r\ni1', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="profiles-seeker.csv"' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await dashboardService.dashboardExportProfiles({
      domain: 'seeker',
      itemIds: ['i1'],
    });
    expect(result.filename).toBe('profiles-seeker.csv');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ item_ids: ['i1'], domain: 'seeker' });
  });

  it('falls back to a default filename derived from the domain', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('data', { status: 200 })) as unknown as typeof fetch;
    const result = await dashboardService.dashboardExportProfiles({
      domain: 'seeker',
      itemIds: ['i1'],
    });
    expect(result.filename).toBe('profiles-seeker.csv');
  });

  it('surfaces the upstream error detail on failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }),
      ) as unknown as typeof fetch;
    const message = await rejectionMessage(
      dashboardService.dashboardExportProfiles({ domain: 'seeker', itemIds: ['i1'] }),
    );
    expect(message).toBe('boom');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('oops', { status: 502 })) as unknown as typeof fetch;
    const message = await rejectionMessage(
      dashboardService.dashboardExportProfiles({ domain: 'seeker', itemIds: ['i1'] }),
    );
    expect(message).toBe('profile export failed: 502');
  });
});

describe('dashboardService.dashboardBulkAction', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('validates required fields', async () => {
    await expect(
      dashboardService.dashboardBulkAction({ action: '', domain: 'seeker', ids: ['1'] }),
    ).rejects.toThrow();
    await expect(
      dashboardService.dashboardBulkAction({ action: 'trigger_callback', domain: '', ids: ['1'] }),
    ).rejects.toThrow();
    await expect(
      dashboardService.dashboardBulkAction({
        action: 'trigger_callback',
        domain: 'seeker',
        ids: [],
      }),
    ).rejects.toThrow();
  });

  it('posts the action + returns the ack envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: 2 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await dashboardService.dashboardBulkAction({
      action: 'trigger_callback',
      domain: 'seeker',
      ids: ['1', '2'],
    });
    expect(res).toEqual({ accepted: 2 });
  });

  it('surfaces the upstream error detail on failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { detail: 'not allowed' } }), { status: 403 }),
      ) as unknown as typeof fetch;
    const message = await rejectionMessage(
      dashboardService.dashboardBulkAction({ action: 'x', domain: 'seeker', ids: ['1'] }),
    );
    expect(message).toBe('not allowed');
  });

  it('falls back to a generic message on a non-JSON error body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const message = await rejectionMessage(
      dashboardService.dashboardBulkAction({ action: 'x', domain: 'seeker', ids: ['1'] }),
    );
    expect(message).toBe('bulk action failed: 500');
  });
});

describe('triggerCsvDownload', () => {
  it('creates an object URL, clicks a transient anchor, then revokes the URL', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake-url');
    const revokeObjectURL = vi.fn();
    // jsdom does not implement URL.createObjectURL / revokeObjectURL.
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === 'a') el.click = clickSpy;
        return el;
      });

    triggerCsvDownload({ blob: new Blob(['a,b']), filename: 'out.csv' });

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    createElementSpy.mockRestore();
  });
});
