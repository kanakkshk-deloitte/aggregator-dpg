import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import {
  VoiceProviderBase,
  brandCuratedProviderResponse,
} from '@aggregator-dpg/voice-provider/interface';
import type {
  VoiceDispatchInput,
  VoiceDispatchResult,
} from '@aggregator-dpg/voice-provider/interface';
import {
  deriveJobStatus,
  type JobStatusCounts,
  type ProcessingJob,
} from '../campaign-job-client.js';
import {
  exportObjectKey,
  resolveExportRecipient,
  runCampaignJob,
  type CampaignJobDeps,
} from './index.js';

/** Tallies the harness's in-memory item-status map into a real {@link JobStatusCounts} shape. */
function tallyItemStatus(
  itemStatus: Map<string, { status: string; err: string | null }>,
): JobStatusCounts {
  const counts: JobStatusCounts = {
    total: 0,
    pending: 0,
    resolved: 0,
    submitted: 0,
    sent: 0,
    skipped_not_owned: 0,
    skipped_no_contact: 0,
    duplicate_active: 0,
    failed: 0,
  };
  for (const v of itemStatus.values()) {
    counts.total++;
    counts[v.status as keyof Omit<JobStatusCounts, 'total'>]++;
  }
  return counts;
}

function row(over: Partial<SignalStackDecryptedProfileRow> = {}): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    contact: {
      name: { value: 'Asha', source: 'item' },
      email: { value: 'asha@example.com', source: 'user' },
      phone: { value: '+910000000000', source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-1',
    channel: 'export',
    status: 'queued',
    signalstackOrgId: 'org-1',
    metadata: [{ key: 'purpose', value: 'audit' }],
    content: {},
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    items: [{ itemId: 'item-1', action: null, status: 'pending', providerBatchRef: null }],
    ...over,
  };
}

interface Harness {
  deps: CampaignJobDeps;
  puts: Array<{ key: string; body: Buffer; contentType: string }>;
  mails: SendInput[];
  itemMarks: Array<{ itemId: string; status: string; err?: string; ref?: string }>;
  heartbeats: () => number;
  jobStatuses: string[];
  logs: { info: object[]; warn: object[]; error: object[] };
  /** Reasons passed to setJobStatus, positionally aligned with jobStatuses. */
  statusReasons: Array<string | undefined>;
  pendingFails: string[];
  notified: () => number;
}

function harness(
  theJob: ProcessingJob | null,
  over: Partial<CampaignJobDeps['export']> = {},
  config: Partial<CampaignJobDeps['config']> = {},
  attempt?: CampaignJobDeps['attempt'],
  audit?: CampaignAuditWriterBase,
): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const itemMarks: Harness['itemMarks'] = [];
  const jobStatuses: string[] = [];
  const statusReasons: Array<string | undefined> = [];
  const pendingFails: string[] = [];
  let notified = 0;
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  let heartbeats = 0;

  // In-memory item-status map for roll-up + forward-only marks.
  const itemStatus = new Map(
    (theJob?.items ?? []).map((i) => [
      i.itemId,
      { status: i.status as string, err: null as string | null },
    ]),
  );
  const TERMINAL = ['resolved', 'submitted', 'failed'];

  const deps: CampaignJobDeps = {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, reason, providerRef) => {
        itemMarks.push({
          itemId,
          status,
          ...(reason ? { err: reason } : {}),
          ...(providerRef ? { ref: providerRef } : {}),
        });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL.includes(cur.status)) {
          cur.status = status;
          cur.err = reason ?? null;
        }
      },
      heartbeat: async () => {
        heartbeats++;
      },
      setJobStatus: async (_jobId, status, errorReason) => {
        jobStatuses.push(status);
        statusReasons.push(errorReason);
        if (theJob) theJob.status = status;
      },
      setNotifiedAt: async () => {
        notified++;
        if (theJob) theJob.notifiedAt = new Date('2026-08-01T00:30:00.000Z');
      },
      failPendingItems: async (_jobId, reason) => {
        pendingFails.push(reason);
        for (const v of itemStatus.values()) {
          if (v.status === 'pending') {
            v.status = 'failed';
            v.err = reason;
          }
        }
      },
      // Not exercised by the export-channel tests in this file — see
      // campaign-process/voice.test.ts for coverage of these two writers.
      markSubmitted: async () => undefined,
      setProviderResponse: async () => undefined,
      countItems: async () => tallyItemStatus(itemStatus),
      rollUpStatus: async () => {
        const counts = tallyItemStatus(itemStatus);
        const status = deriveJobStatus(counts);
        jobStatuses.push(status);
        if (theJob) theJob.status = status;
        return { status, counts };
      },
    },
    export: {
      fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
      putObject: async (key, body, contentType) => {
        puts.push({ key, body, contentType });
      },
      signDownloadUrl: async (key) => ({
        url: `https://signed.example/${key}`,
        key,
        expiresAt: '2026-08-01T01:00:00.000Z',
      }),
      sendMail: async (input): Promise<MailerResult<SendOk>> => {
        mails.push(input);
        return { ok: true, value: { messageId: 'm-1' } };
      },
      ...over,
    },
    config: {
      decryptChunk: 500,
      fieldSet: 'contact',
      recipientMode: 'requester',
      emailSendConcurrency: 5,
      ...config,
    },
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...(attempt ? { attempt } : {}),
    ...(audit ? { audit } : {}),
  };
  return {
    deps,
    puts,
    mails,
    itemMarks,
    heartbeats: () => heartbeats,
    jobStatuses,
    logs,
    statusReasons,
    pendingFails,
    notified: () => notified,
  };
}

describe('runCampaignJob (export channel)', () => {
  it('resolves every item, uploads a CSV, emails the link, and rolls up to succeeded', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.jobStatuses[0]).toBe('processing');
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.itemMarks).toEqual([{ itemId: 'item-1', status: 'resolved' }]);
    expect(h.heartbeats()).toBeGreaterThanOrEqual(1);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('user@org.example');
    expect(h.mails[0]!.text).toContain('01 Aug 2026, 01:00 UTC');
  });

  it('marks an unowned item skipped_not_owned and still completes the job', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'a', action: null, status: 'pending', providerBatchRef: null },
          { itemId: 'b', action: null, status: 'pending', providerBatchRef: null },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_id: 'a' })], skipped: ['b'] }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'resolved' });
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
    // A skip is not a failure, so the job completes rather than going partial.
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.mails).toHaveLength(1); // the one owned record is still exported
  });

  it('completes with no email when every item is unowned (all skipped)', async () => {
    const h = harness(
      job({ items: [{ itemId: 'a', action: null, status: 'pending', providerBatchRef: null }] }),
      {
        fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['a'] }),
      },
    );
    await runCampaignJob('job-1', h.deps);
    // Nothing was owned, so nothing was exported — but the handler ran
    // correctly, so this is `completed` with counts telling the real story,
    // not `failed`. See deriveJobStatus.
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.itemMarks).toContainEqual({
      itemId: 'a',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('throws (BullMQ retry) and leaves the job processing when decrypt fails', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/decrypt/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws when a contact projection returns no contact block (#521 guard)', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            {
              item_id: 'item-1',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_state: {},
              created_at: '2026-08-01T00:00:00.000Z',
              updated_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          skipped: [],
        }),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/#521/);
    expect(h.mails).toHaveLength(0);
  });

  it('is a no-op for an already-terminal job (retry guard)', async () => {
    const h = harness(job({ status: 'completed' }));
    await runCampaignJob('job-1', h.deps);
    expect(h.jobStatuses).toEqual([]); // never set processing
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('uses the variable-column CSV builder for the full field-set', async () => {
    const h = harness(
      job(),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_state: { age: '30' } })], skipped: [] }),
      },
      { fieldSet: 'full' },
    );
    await runCampaignJob('job-1', h.deps);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.body.toString('utf8')).toContain('age');
  });

  it('prefers the recipient override over the job requested_by', async () => {
    const h = harness(
      job(),
      {},
      { recipientMode: 'network_admin', networkAdminEmail: 'admin@network.example' },
    );
    await runCampaignJob('job-1', h.deps);
    expect(h.mails[0]!.to).toBe('admin@network.example');
  });

  it('never logs raw contact PII', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('asha@example.com');
    expect(serialized).not.toContain('+910000000000');
  });
});

describe('runCampaignJob failure paths', () => {
  it('leaves a mid-sequence failure retryable: still processing, no terminal mark', async () => {
    const h = harness(
      job(),
      {
        putObject: async () => {
          throw new Error('s3 unreachable');
        },
      },
      {},
      { attempt: 1, maxAttempts: 3 },
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 unreachable');
    // BullMQ will retry, so the job must NOT be marked terminal here.
    expect(h.jobStatuses).toEqual(['processing']);
    expect(h.pendingFails).toEqual([]);
    expect(h.mails).toHaveLength(0);
  });

  it('records the real reason and fails leftover items on the final attempt', async () => {
    const h = harness(
      job(),
      {
        putObject: async () => {
          throw new Error('s3 unreachable');
        },
      },
      {},
      { attempt: 3, maxAttempts: 3 },
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 unreachable');
    expect(h.jobStatuses.at(-1)).toBe('failed');
    // The cause is preserved rather than being swept later as a generic stall.
    expect(h.statusReasons.at(-1)).toBe('s3 unreachable');
    expect(h.pendingFails).toEqual(['job_failed']);
  });

  it('fails terminally when the mailer rejects on the final attempt', async () => {
    const h = harness(
      job(),
      {
        sendMail: async (): Promise<MailerResult<SendOk>> => ({
          ok: false,
          error: { code: 'TRANSPORT_FAILED', message: 'smtp refused' },
        }),
      },
      {},
      { attempt: 2, maxAttempts: 2 },
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/email failed/);
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(h.statusReasons.at(-1)).toContain('TRANSPORT_FAILED');
    // The CSV was uploaded before the send failed; the link was never delivered.
    expect(h.puts).toHaveLength(1);
    expect(h.notified()).toBe(0);
  });

  it('fails when recipientMode is network_admin but no admin address is configured', async () => {
    const h = harness(
      job(),
      {},
      { recipientMode: 'network_admin' },
      { attempt: 1, maxAttempts: 1 },
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/no recipient/);
    // Fail closed: a PII export is never redirected to the requester as a fallback.
    expect(h.mails).toHaveLength(0);
    expect(h.jobStatuses.at(-1)).toBe('failed');
  });
});

describe('runCampaignJob completed audit (#617)', () => {
  it('writes one completed audit row when the job reaches a terminal status', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(job(), {}, {}, undefined, audit);
    await runCampaignJob('job-1', h.deps);

    const rows = audit.rows.filter((r) => r.kind === 'completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.correlationId).toBe('job-1');
    expect(rows[0]!.outcome).toBe('succeeded');
    expect(rows[0]!.actorSignalstackOrgId).toBe('org-1');
  });

  it('populates the outcome counts, recipientRef and destination on the export success row (#617 follow-up)', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(job(), {}, {}, undefined, audit);
    await runCampaignJob('job-1', h.deps);

    const row = audit.rows.find((r) => r.kind === 'completed')!;
    expect(row).toMatchObject({
      resolvedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      sentCount: 0,
      recipientRef: 'user@org.example',
      destination: 'campaign-exports/org-1/job-1.csv',
    });
    // The recipient is the same helper the send path itself uses — never a
    // participant address (#617 follow-up).
    expect(resolveExportRecipient(job(), h.deps.config)).toBe(row.recipientRef);
    expect(exportObjectKey('org-1', 'job-1')).toBe(row.destination);
  });

  it('aggregates skipped_not_owned into skippedCount on the export success row', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(
      job({
        items: [
          { itemId: 'a', action: null, status: 'pending', providerBatchRef: null },
          { itemId: 'b', action: null, status: 'pending', providerBatchRef: null },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_id: 'a' })], skipped: ['b'] }),
      },
      {},
      undefined,
      audit,
    );
    await runCampaignJob('job-1', h.deps);

    const completed = audit.rows.find((r) => r.kind === 'completed')!;
    expect(completed).toMatchObject({ resolvedCount: 1, skippedCount: 1, failedCount: 0 });
  });

  it('populates counts, recipientRef and destination on the export final-attempt-failure row', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(
      job(),
      {
        putObject: async () => {
          throw new Error('s3 down');
        },
      },
      {},
      { attempt: 3, maxAttempts: 3 },
      audit,
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 down');
    const row = audit.rows.find((r) => r.kind === 'completed')!;
    // decryptAndMarkItems resolved the one item before the S3 write blew up;
    // failPendingItems then has nothing left pending to fail.
    expect(row).toMatchObject({
      resolvedCount: 1,
      failedCount: 0,
      recipientRef: 'user@org.example',
      destination: 'campaign-exports/org-1/job-1.csv',
    });
  });

  it('never sets recipientRef or destination on a voice/email completed row', async () => {
    const audit = new CampaignAuditWriterFake();
    const voiceJob = job({
      channel: 'voice',
      content: { agent_id: 'agent-1' },
      items: [
        { itemId: 'item-1', action: 'voice_call', status: 'pending', providerBatchRef: null },
      ],
    });
    const h = harness(voiceJob, {}, {}, undefined, audit);
    const deps: CampaignJobDeps = {
      ...h.deps,
      voice: {
        fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
        provider: new (class extends VoiceProviderBase {
          async dispatch(
            input: VoiceDispatchInput,
          ): Promise<Result<VoiceDispatchResult, BaseError>> {
            return ok({
              providerBatchRef: 'batch-1',
              accepted: input.contacts.map((c) => c.ref),
              rejected: [],
              providerResponse: {
                create: brandCuratedProviderResponse({}),
                start: brandCuratedProviderResponse({}),
              },
            });
          }
        })(),
      },
    };

    await runCampaignJob('job-1', deps);

    const completed = audit.rows.find((r) => r.kind === 'completed')!;
    expect('recipientRef' in completed).toBe(false);
    expect('destination' in completed).toBe(false);
  });

  it('writes NO completed row for a retryable mid-sequence failure', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(
      job(),
      {
        putObject: async () => {
          throw new Error('s3 down');
        },
      },
      {},
      { attempt: 1, maxAttempts: 3 },
      audit,
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 down');
    // Not terminal — BullMQ will retry, so there is no outcome to record yet.
    expect(audit.rows.filter((r) => r.kind === 'completed')).toHaveLength(0);
  });

  it('writes one failed audit row on the final attempt', async () => {
    const audit = new CampaignAuditWriterFake();
    const h = harness(
      job(),
      {
        putObject: async () => {
          throw new Error('s3 down');
        },
      },
      {},
      { attempt: 3, maxAttempts: 3 },
      audit,
    );

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 down');
    const rows = audit.rows.filter((r) => r.kind === 'completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('failed');
  });

  it('still completes the job when the audit write throws', async () => {
    const audit = new CampaignAuditWriterFake();
    audit.failWith = new Error('audit down');
    const h = harness(job(), {}, {}, undefined, audit);
    await expect(runCampaignJob('job-1', h.deps)).resolves.toBeUndefined();
    expect(h.jobStatuses.at(-1)).toBe('completed');
  });

  it('writes NO completed row when rollUpStatus reports a non-terminal status (#617 SHOULD-FIX 2)', async () => {
    // `deriveJobStatus` returns `processing` (not terminal) when an item is
    // still `pending`. No currently-reachable handler leaves the job in that
    // state on a normal return (the reviewer found this latent, not live),
    // so this forces it directly at the client boundary to prove the guard
    // itself — rather than relying on a real handler code path that may not
    // exist today.
    const audit = new CampaignAuditWriterFake();
    const h = harness(job(), {}, {}, undefined, audit);
    h.deps.client.rollUpStatus = async () => ({
      status: 'processing',
      counts: {
        total: 1,
        pending: 1,
        resolved: 0,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 0,
      },
    });

    await runCampaignJob('job-1', h.deps);

    expect(audit.rows.filter((r) => r.kind === 'completed')).toHaveLength(0);
    expect(h.logs.warn).toContainEqual(
      expect.objectContaining({
        operation: 'campaign.process',
        status: 'skipped',
        reason: 'non_terminal_after_handler',
        job_status: 'processing',
      }),
    );
  });

  it('logs at error and does not throw when the writer resolves err(...)', async () => {
    const errors: object[] = [];
    const audit: CampaignAuditWriterBase = {
      recordRequested: async () => ok(undefined),
      recordCompleted: async () =>
        err(new UpstreamError('insert failed', { code: 'CAMPAIGN_AUDIT_INSERT_FAILED' })),
    } as CampaignAuditWriterBase;
    const h = harness(job(), {}, {}, undefined, audit);
    h.deps.log.error = (o) => errors.push(o);

    await expect(runCampaignJob('job-1', h.deps)).resolves.toBeUndefined();
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(errors).toContainEqual(
      expect.objectContaining({
        operation: 'campaignAudit.completed',
        status: 'failure',
        error: 'insert failed',
      }),
    );
  });
});

describe('runCampaignJob (voice channel wiring)', () => {
  // Not a re-test of runVoiceForJob's own behaviour (see
  // campaign-process/voice.test.ts) — this exercises the actual
  // `job.channel === 'voice'` branch in runCampaignJob itself, which no
  // other test file drives (voice.test.ts calls runVoiceForJob directly).
  class StubProvider extends VoiceProviderBase {
    async dispatch(input: VoiceDispatchInput): Promise<Result<VoiceDispatchResult, BaseError>> {
      return ok({
        providerBatchRef: 'batch-1',
        accepted: input.contacts.map((c) => c.ref),
        rejected: [],
        providerResponse: {
          create: brandCuratedProviderResponse({}),
          start: brandCuratedProviderResponse({}),
        },
      });
    }
  }

  it('routes a voice job through runVoiceForJob and rolls up to completed', async () => {
    const voiceJob = job({
      channel: 'voice',
      content: { agent_id: 'agent-1' },
      items: [
        { itemId: 'item-1', action: 'voice_call', status: 'pending', providerBatchRef: null },
      ],
    });
    const h = harness(voiceJob);
    const submitted: Array<{ jobId: string; itemId: string; providerBatchRef: string }> = [];
    const providerResponses: Array<{ jobId: string; response: unknown }> = [];
    const deps: CampaignJobDeps = {
      ...h.deps,
      client: {
        ...h.deps.client,
        markSubmitted: async (jobId, itemId, args) => {
          submitted.push({ jobId, itemId, providerBatchRef: args.providerBatchRef });
        },
        setProviderResponse: async (jobId, response) => {
          providerResponses.push({ jobId, response });
        },
      },
      voice: {
        fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
        provider: new StubProvider(),
      },
    };

    await runCampaignJob('job-1', deps);

    expect(submitted).toEqual([{ jobId: 'job-1', itemId: 'item-1', providerBatchRef: 'batch-1' }]);
    expect(providerResponses).toHaveLength(1);
    // No mail/S3 side effects — the export path must not run for a voice job.
    expect(h.mails).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });
});

describe('runCampaignJob (email channel wiring)', () => {
  // Not a re-test of runEmailForJob's own behaviour (see
  // campaign-process/email.test.ts) — this exercises the actual
  // `job.channel === 'email'` branch in runCampaignJob itself, which no other
  // test file drives (email.test.ts calls runEmailForJob directly).
  it('routes an email job through runEmailForJob and rolls up to completed', async () => {
    const emailJob = job({
      channel: 'email',
      content: { subject: 'Hi {{first_name}}', body_markdown: 'Hello {{name}}' },
      items: [{ itemId: 'item-1', action: null, status: 'pending', providerBatchRef: null }],
    });
    const h = harness(emailJob);
    const sent: SendInput[] = [];
    const deps: CampaignJobDeps = {
      ...h.deps,
      email: {
        fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
        sendMail: async (input) => {
          sent.push(input);
          return { ok: true, value: { messageId: 'msg-1' } };
        },
      },
    };

    await runCampaignJob('job-1', deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Hi Asha');
    expect(h.itemMarks).toEqual([{ itemId: 'item-1', status: 'sent', ref: 'msg-1' }]);
    expect(h.jobStatuses.at(-1)).toBe('completed');
    // No export side effects — the export path must not run for an email job.
    expect(h.mails).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });
});

describe('runCampaignJob retry safety', () => {
  it('writes the CSV at a deterministic per-job key so a retry overwrites it', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    expect(h.puts[0]!.key).toBe('campaign-exports/org-1/job-1.csv');
  });

  it('stamps notified_at after a successful send', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    expect(h.notified()).toBe(1);
  });

  it('never re-sends the download link for an already-notified job', async () => {
    const h = harness(job({ notifiedAt: new Date('2026-08-01T00:30:00.000Z') }));
    await runCampaignJob('job-1', h.deps);

    // A second working pre-signed link to the same PII must not go out.
    expect(h.mails).toHaveLength(0);
    expect(h.notified()).toBe(0);
    expect(h.jobStatuses.at(-1)).toBe('completed');
  });
});
