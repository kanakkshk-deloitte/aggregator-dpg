/**
 * Isolated `safeAudit` coverage for its `err(BaseError)` branch (#617).
 *
 * `CampaignAuditWriterFake` (used by `submit-job.audit.test.ts`) only ever
 * THROWS on failure — by its own design, to exercise the "harsher" call-site
 * failure mode. But `PostgresCampaignAuditWriter` never throws: every one of
 * its methods catches the DB error internally and resolves
 * `err(UpstreamError)` (see `@aggregator-dpg/campaign-audit`'s `postgres.ts`).
 * That resolved-`err` path is the one a real deployment actually hits, so it
 * needs its own direct test rather than relying on the throwing fake to
 * stand in for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { logger } from '../../logger.js';
import { safeAudit } from './index.js';

describe('safeAudit', () => {
  // Each test spies on the same `logger.error`. vitest 4 hands back the EXISTING
  // spy when a method is already spied, call history included, so without this
  // the "does not log" assertion sees the previous test's call and fails. Under
  // vitest 3 each `vi.spyOn` handed back a fresh spy and the leak was invisible.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw and logs at error when the writer resolves err(...)', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const cause = new UpstreamError('campaign audit insert failed', {
      code: 'CAMPAIGN_AUDIT_INSERT_FAILED',
    });

    await expect(
      safeAudit(() => Promise.resolve(err(cause)), {
        operation: 'campaignAudit.requested',
        correlation_id: 'job-1',
        channel: 'export',
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignAudit.requested',
        correlation_id: 'job-1',
        channel: 'export',
        status: 'failure',
        error: 'campaign audit insert failed',
      }),
    );
  });

  it('does not log when the writer resolves ok(...)', async () => {
    const errorSpy = vi.spyOn(logger, 'error');

    await safeAudit(() => Promise.resolve(ok(undefined)), {
      operation: 'campaignAudit.requested',
      correlation_id: 'job-2',
      channel: 'export',
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('clears its internal timeout timer once the write settles, so it never lingers past the call (#617 cheap item)', async () => {
    vi.useFakeTimers();
    try {
      await safeAudit(() => Promise.resolve(ok(undefined)), {
        operation: 'campaignAudit.requested',
        correlation_id: 'job-timer',
        channel: 'export',
      });
      // An uncleared race timer would still be scheduled here even though the
      // write already settled — that's exactly the leak this guards against.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still logs at error, and does not throw, when the writer itself throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error');

    await expect(
      safeAudit(
        () => {
          throw new Error('writer exploded');
        },
        { operation: 'campaignAudit.requested', correlation_id: 'job-3', channel: 'export' },
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failure', error: 'writer exploded' }),
    );
  });
});
