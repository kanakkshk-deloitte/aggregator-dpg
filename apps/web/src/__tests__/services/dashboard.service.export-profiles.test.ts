/**
 * Covers how `dashboardExportProfiles` reads `X-Export-Skipped-Count`.
 *
 * The distinction the field's contract rests on is absent-vs-zero: the API
 * omits the header on every export other than profiles, and a caller must not
 * render "0 withheld" for a figure nothing measured. `Headers.get` returns
 * `null` when absent and `Number(null)` is `0`, so the null case needs its own
 * branch — this file is what stops that regressing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { dashboardService } from '../../services/dashboard.service';

function csvResponse(headers: Record<string, string>): Response {
  return new Response('item_id,name\n1,Asha\n', {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', ...headers },
  });
}

describe('dashboardService.dashboardExportProfiles — skippedCount', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the count the API measured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(csvResponse({ 'x-export-skipped-count': '3' })),
    );
    const res = await dashboardService.dashboardExportProfiles({
      domain: 'seeker',
      itemIds: ['a'],
    });
    expect(res.skippedCount).toBe(3);
  });

  it('reports a measured zero as zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(csvResponse({ 'x-export-skipped-count': '0' })),
    );
    const res = await dashboardService.dashboardExportProfiles({
      domain: 'seeker',
      itemIds: ['a'],
    });
    expect(res.skippedCount).toBe(0);
  });

  it('leaves skippedCount undefined when the header is absent', async () => {
    // Number(null) === 0, so a naive Number() coercion reports a measured zero
    // here — the one case the field's TSDoc explicitly rules out.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(csvResponse({})));
    const res = await dashboardService.dashboardExportProfiles({
      domain: 'seeker',
      itemIds: ['a'],
    });
    expect(res.skippedCount).toBeUndefined();
    expect('skippedCount' in res).toBe(false);
  });

  it('leaves skippedCount undefined when the header is not a count', async () => {
    for (const value of ['abc', '', '-1', '2.5']) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(csvResponse({ 'x-export-skipped-count': value })),
      );
      const res = await dashboardService.dashboardExportProfiles({
        domain: 'seeker',
        itemIds: ['a'],
      });
      expect(res.skippedCount, `value: ${JSON.stringify(value)}`).toBeUndefined();
    }
  });
});
