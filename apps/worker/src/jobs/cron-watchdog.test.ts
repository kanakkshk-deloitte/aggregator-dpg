/**
 * Unit tests for the stuck-job watchdog + retention sweeper cron job.
 *
 * `runWatchdog` is a queue-consumer job that reads/writes Postgres (via a
 * hand-built chainable Drizzle stub) and purges Redis working-set keys. Both
 * are faked here. DB calls happen in a fixed, sequential order in the source
 * (`update bulkUploads` abandoned -> `update bulkUploads` stuck -> `update
 * campaignJob` stalled -> `delete bulkUploads` retention -> `delete
 * linkSubmissions` retention), so the fake dispenses one canned result per
 * call in that order. The campaign-stall sweep additionally reads item
 * counts (`select ... groupBy` — a separate canned queue) and writes a
 * `completed` PII-audit row per stalled job (#617 follow-up); the audit
 * writer is swapped for `CampaignAuditWriterFake` via `_setCampaignAuditWriter`
 * so those rows are inspectable and failures are fully controllable —
 * without this override, `getCampaignAuditWriter()` would build a real
 * `PostgresCampaignAuditWriter`, which must never be exercised against a
 * live database from a unit test.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';

// ─── DB fake — one queue of results per call-site, consumed in source order ──

// Update call order in source: bulkUploads abandoned -> bulkUploads stuck ->
// campaignJob stalled. One canned result per call, consumed in that order.
let updateReturns: Array<
  Array<{ id: string; channel?: string; signalstackOrgId?: string; requestedBy?: string }>
> = [[], [], []];
let deleteReturns: Array<Array<{ id: string }>> = [[], []];
let updateShouldThrow: Error | null = null;
let updateCallIdx = 0;
let deleteCallIdx = 0;
const updateSets: Array<Record<string, unknown>> = [];

// `countItems`'s `select(...).from(...).where(...).groupBy(...)` — one canned
// per-status-tally queue entry per stalled job, consumed in `campaignStalled`
// order. An `Error` entry models that specific item-count read throwing
// (e.g. a transient DB blip) without affecting any other queued call.
let selectReturns: Array<Array<{ status: string; n: number }> | Error> = [];
let selectCallIdx = 0;

function makeDb() {
  return {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        return {
          where: () => ({
            returning: async () => {
              if (updateShouldThrow) throw updateShouldThrow;
              return updateReturns[updateCallIdx++] ?? [];
            },
          }),
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => deleteReturns[deleteCallIdx++] ?? [],
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: async () => {
            const next = selectReturns[selectCallIdx++] ?? [];
            if (next instanceof Error) throw next;
            return next;
          },
        }),
      }),
    }),
  };
}

vi.mock('../db.js', () => ({
  getDb: () => makeDb(),
  schema: {
    bulkUploads: {
      id: 'id',
      status: 'status',
      createdAt: 'createdAt',
      lastProgressAt: 'lastProgressAt',
    },
    linkSubmissions: { id: 'id', rolledUpAt: 'rolledUpAt', createdAt: 'createdAt' },
    campaignJob: {
      id: 'id',
      status: 'status',
      lastProgressAt: 'lastProgressAt',
      channel: 'channel',
      signalstackOrgId: 'signalstackOrgId',
      requestedBy: 'requestedBy',
    },
  },
}));

// ─── Redis fake ──────────────────────────────────────────────────────────────

const del = vi.fn(async (...keys: string[]) => keys.length);
vi.mock('../services/redis.js', () => ({ getRedis: () => ({ del }) }));

vi.mock('../config.js', () => ({
  config: {
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    CAMPAIGN_STALL_SECONDS: 900,
    // `requester` by default so `resolveExportRecipient` falls back to the
    // job's own `requestedBy` — the common case; the `network_admin` case is
    // exercised by overriding these two directly in the tests that need it.
    CAMPAIGN_EXPORT_RECIPIENT: 'requester',
    EXPORT_NETWORK_ADMIN_EMAIL: undefined,
  },
}));

const { runWatchdog } = await import('./cron-watchdog.js');
const { _setCampaignAuditWriter } = await import('../services/campaign-audit.js');

const audit = new CampaignAuditWriterFake();

beforeEach(() => {
  vi.clearAllMocks();
  updateReturns = [[], [], []];
  deleteReturns = [[], []];
  updateShouldThrow = null;
  updateCallIdx = 0;
  deleteCallIdx = 0;
  updateSets.length = 0;
  selectReturns = [];
  selectCallIdx = 0;
  audit.reset();
  _setCampaignAuditWriter(audit);
});

describe('runWatchdog — normal execution', () => {
  it('reports abandoned + stuck uploads and purges their Redis working set', async () => {
    updateReturns = [[{ id: 'b1' }, { id: 'b2' }], [{ id: 's1' }]];
    deleteReturns = [[{ id: 'p1' }], [{ id: 'sub1' }, { id: 'sub2' }]];

    const res = await runWatchdog();

    expect(res).toEqual({
      abandoned: 2,
      stuck: 1,
      campaignStalled: 0,
      bulkPurged: 1,
      submissionsPurged: 2,
    });
    expect(updateSets[0]).toMatchObject({ status: 'failed', statusReason: 'upload_abandoned' });
    expect(updateSets[1]).toMatchObject({ status: 'failed', statusReason: 'processing_stuck' });
    expect(del).toHaveBeenCalledTimes(1);
    const keys = del.mock.calls[0]!;
    // 3 terminal ids (b1, b2, s1) x 6 keys per upload namespace = 18.
    expect(keys).toHaveLength(18);
    expect(keys).toEqual(expect.arrayContaining(['bu:b1:lines', 'bu:s1:errors']));
    // Bulk uploads never touch the campaign PII-audit log.
    expect(audit.rows).toHaveLength(0);
  });

  it('fails stalled campaign jobs with reason "stalled"', async () => {
    // 3rd update call = campaignJob stalled sweep.
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
        {
          id: 'cj2',
          channel: 'voice',
          signalstackOrgId: 'org-2',
          requestedBy: 'user@org-2.example',
        },
      ],
    ];
    const res = await runWatchdog();
    expect(res.campaignStalled).toBe(2);
    expect(updateSets[2]).toMatchObject({ status: 'failed', errorReason: 'stalled' });
    // Campaign jobs don't own bulk Redis keys, so Redis is untouched.
    expect(del).not.toHaveBeenCalled();
  });

  it('does not touch Redis when there are no newly-terminal uploads', async () => {
    updateReturns = [[], []];
    deleteReturns = [[{ id: 'p1' }], []];

    const res = await runWatchdog();

    expect(res).toEqual({
      abandoned: 0,
      stuck: 0,
      campaignStalled: 0,
      bulkPurged: 1,
      submissionsPurged: 0,
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('purges Redis keys for abandoned-only uploads (stuck pass empty)', async () => {
    updateReturns = [[{ id: 'b1' }], []];
    deleteReturns = [[], []];

    const res = await runWatchdog();

    expect(res.abandoned).toBe(1);
    expect(res.stuck).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toHaveLength(6);
  });

  it('runs the retention sweep independently of the watchdog pass', async () => {
    updateReturns = [[], []];
    deleteReturns = [[{ id: 'old-1' }, { id: 'old-2' }], [{ id: 'old-sub' }]];

    const res = await runWatchdog();

    expect(res).toEqual({
      abandoned: 0,
      stuck: 0,
      campaignStalled: 0,
      bulkPurged: 2,
      submissionsPurged: 1,
    });
  });

  it('returns all-zero counts on a fully quiet run', async () => {
    const res = await runWatchdog();
    expect(res).toEqual({
      abandoned: 0,
      stuck: 0,
      campaignStalled: 0,
      bulkPurged: 0,
      submissionsPurged: 0,
    });
    expect(del).not.toHaveBeenCalled();
  });
});

describe('runWatchdog — failure propagation', () => {
  it('propagates a DB failure rather than swallowing it', async () => {
    updateShouldThrow = new Error('connection terminated unexpectedly');
    await expect(runWatchdog()).rejects.toThrow('connection terminated unexpectedly');
  });
});

describe('runWatchdog — stalled-campaign completed audit row (#617 follow-up)', () => {
  it('writes one completed row per stalled job, with outcome failed and errorCode stalled', async () => {
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
      ],
    ];
    selectReturns = [
      [
        { status: 'resolved', n: 2 },
        { status: 'sent', n: 1 },
      ],
    ];

    await runWatchdog();

    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row).toMatchObject({
      kind: 'completed',
      correlationId: 'cj1',
      channel: 'export',
      actorSignalstackOrgId: 'org-1',
      outcome: 'failed',
      errorCode: 'stalled',
      // The operator (requester) address, never a participant's.
      recipientRef: 'user@org-1.example',
    });
  });

  it('populates the outcome counts from countItems, mapped the same way as the worker paths', async () => {
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
      ],
    ];
    selectReturns = [
      [
        { status: 'resolved', n: 2 },
        { status: 'sent', n: 1 },
        { status: 'skipped_not_owned', n: 1 },
        { status: 'skipped_no_contact', n: 1 },
        { status: 'duplicate_active', n: 1 },
        { status: 'failed', n: 3 },
      ],
    ];

    await runWatchdog();

    expect(audit.rows[0]).toMatchObject({
      resolvedCount: 2,
      sentCount: 1,
      // skipped_not_owned + skipped_no_contact + duplicate_active
      skippedCount: 3,
      failedCount: 3,
    });
  });

  it('force-fails leftover pending items before counting, so the counts sum to the job total (#617 follow-up)', async () => {
    // A stalled job means the worker died mid-run — leftover `pending` items
    // are the NORMAL case, not an edge case. `pending` maps to no audit
    // column at all, so without `failPendingItems` running first, a 10-item
    // job that stalled after resolving 3 would silently audit `resolvedCount:
    // 3` with the other 7 vanishing — indistinguishable from a job that only
    // ever had 3 items. This fixture models the state AFTER
    // `failPendingItems` has already run (what was 7 `pending` is now 7
    // `failed`), and separately proves the call itself happened.
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
      ],
    ];
    selectReturns = [
      [
        { status: 'resolved', n: 3 },
        { status: 'failed', n: 7 },
      ],
    ];

    await runWatchdog();

    // Proves `failPendingItems` actually ran: a 4th `.update().set()` call
    // beyond the 3 standard sweep updates (bulkUploads abandoned / stuck /
    // campaignJob stalled) — `failPendingItems` sets the same
    // `{status: 'failed', errorReason: 'stalled'}` shape on campaign_job_item.
    expect(updateSets).toHaveLength(4);
    expect(updateSets[3]).toMatchObject({ status: 'failed', errorReason: 'stalled' });

    const row = audit.rows[0] as {
      resolvedCount?: number;
      sentCount?: number;
      skippedCount?: number;
      failedCount?: number;
    };
    expect(row).toMatchObject({ resolvedCount: 3, failedCount: 7, sentCount: 0, skippedCount: 0 });
    const total =
      (row.resolvedCount ?? 0) +
      (row.sentCount ?? 0) +
      (row.skippedCount ?? 0) +
      (row.failedCount ?? 0);
    // The job's real total (10) — nothing vanished into an uncounted `pending` bucket.
    expect(total).toBe(10);
  });

  it('sets destination + recipientRef for an export-channel stalled job, and omits both for voice/email', async () => {
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj-export',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
        {
          id: 'cj-voice',
          channel: 'voice',
          signalstackOrgId: 'org-2',
          requestedBy: 'user@org-2.example',
        },
      ],
    ];
    selectReturns = [[], []];

    await runWatchdog();

    const exportRow = audit.rows.find((r) => r.correlationId === 'cj-export')!;
    const voiceRow = audit.rows.find((r) => r.correlationId === 'cj-voice')!;
    expect(exportRow).toMatchObject({
      destination: 'campaign-exports/org-1/cj-export.csv',
      // Same operator address a normal export completion would carry —
      // recomputed via `resolveExportRecipient`, never a participant's.
      recipientRef: 'user@org-1.example',
    });
    expect('destination' in voiceRow).toBe(false);
    expect('recipientRef' in voiceRow).toBe(false);
  });

  it('uses the configured network-admin address for recipientRef when CAMPAIGN_EXPORT_RECIPIENT=network_admin', async () => {
    const configModule = await import('../config.js');
    const original = { ...configModule.config };
    Object.assign(configModule.config, {
      CAMPAIGN_EXPORT_RECIPIENT: 'network_admin',
      EXPORT_NETWORK_ADMIN_EMAIL: 'admin@network.example',
    });
    try {
      updateReturns = [
        [],
        [],
        [
          {
            id: 'cj-export',
            channel: 'export',
            signalstackOrgId: 'org-1',
            // Deliberately different from the admin address, to prove the
            // admin override — not the requester — wins.
            requestedBy: 'requester@org-1.example',
          },
        ],
      ];
      selectReturns = [[]];

      await runWatchdog();

      expect(audit.rows[0]).toMatchObject({ recipientRef: 'admin@network.example' });
    } finally {
      Object.assign(configModule.config, original);
    }
  });

  it('still audits every other stalled job when the item-count read throws for one', async () => {
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
        {
          id: 'cj2',
          channel: 'email',
          signalstackOrgId: 'org-2',
          requestedBy: 'user@org-2.example',
        },
      ],
    ];
    // First job's countItems() throws; the second's succeeds — proves one
    // job's count-read failure doesn't skip auditing the rest.
    selectReturns = [new Error('select failed'), [{ status: 'sent', n: 1 }]];

    const res = await runWatchdog();

    expect(res.campaignStalled).toBe(2);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.map((r) => r.correlationId)).toEqual(['cj1', 'cj2']);
    // cj1's row has no counts (the read failed); cj2's does.
    expect('resolvedCount' in audit.rows[0]!).toBe(false);
    expect(audit.rows[1]).toMatchObject({ sentCount: 1 });
  });

  it('does not abort the sweep or the retention pass when the audit writer resolves err(...)', async () => {
    const { err } = await import('@aggregator-dpg/shared-primitives/result');
    const { UpstreamError } = await import('@aggregator-dpg/shared-primitives/errors');
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
      ],
    ];
    deleteReturns = [[{ id: 'old-1' }], [{ id: 'old-sub' }]];
    selectReturns = [[]];
    _setCampaignAuditWriter({
      recordRequested: async () => ({ success: true, value: undefined }) as never,
      recordCompleted: async () =>
        err(new UpstreamError('insert failed', { code: 'CAMPAIGN_AUDIT_INSERT_FAILED' })),
    } as never);

    const res = await runWatchdog();

    expect(res.campaignStalled).toBe(1);
    expect(res.bulkPurged).toBe(1);
    expect(res.submissionsPurged).toBe(1);
  });

  it('does not abort the sweep or the retention pass when the audit writer throws', async () => {
    updateReturns = [
      [],
      [],
      [
        {
          id: 'cj1',
          channel: 'export',
          signalstackOrgId: 'org-1',
          requestedBy: 'user@org-1.example',
        },
      ],
    ];
    deleteReturns = [[{ id: 'old-1' }], [{ id: 'old-sub' }]];
    selectReturns = [[]];
    audit.failWith = new Error('audit db down');

    const res = await runWatchdog();

    expect(res.campaignStalled).toBe(1);
    expect(res.bulkPurged).toBe(1);
    expect(res.submissionsPurged).toBe(1);
  });
});
