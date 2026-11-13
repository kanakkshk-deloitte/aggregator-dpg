import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import {
  AuthError,
  UpstreamError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackDecryptedProfiles,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import { InMemoryVoiceProvider } from '@aggregator-dpg/voice-provider/testing';
import { VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import type {
  VoiceDispatchInput,
  VoiceDispatchResult,
} from '@aggregator-dpg/voice-provider/interface';
import {
  deriveJobStatus,
  type JobStatusCounts,
  type ProcessingJob,
} from '../campaign-job-client.js';
import { runCampaignJob, type CampaignJobDeps } from './index.js';

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

/** Always fails the batch create call — exercises the retryable-throw path. */
class FailingVoiceProvider extends VoiceProviderBase {
  override async dispatch(
    _input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    return err(new UpstreamError('raya down', { code: 'RAYA_DOWN' }));
  }
}

/** Always fails dispatch() with a caller-supplied error — for the deterministic-vs-transient tests. */
class ErroringVoiceProvider extends VoiceProviderBase {
  readonly calls: VoiceDispatchInput[] = [];
  constructor(private readonly error: BaseError) {
    super();
  }
  override async dispatch(
    input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    this.calls.push(input);
    return err(this.error);
  }
}

type FetchFn = (
  q: SignalStackFetchDecryptedProfilesQuery,
) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;

function row(over: Partial<SignalStackDecryptedProfileRow> = {}): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { role: 'Electrician', langs: ['hi', 'en'] },
    contact: {
      name: { value: 'Asha', source: 'item' },
      phone: { value: '+910000000001', source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-1',
    channel: 'voice',
    status: 'queued',
    signalstackOrgId: 'org-1',
    metadata: [],
    content: { agent_id: 'agent-1' },
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    items: [
      { itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null },
      { itemId: 'item-2', action: 'voice', status: 'pending', providerBatchRef: null },
    ],
    ...over,
  };
}

interface Harness {
  deps: CampaignJobDeps;
  itemMarks: Array<{ itemId: string; status: string; err?: string }>;
  submitted: Array<{ itemId: string; providerBatchRef: string; providerRef?: string }>;
  providerResponses: unknown[];
  fetchQueries: SignalStackFetchDecryptedProfilesQuery[];
  heartbeats: () => number;
  jobStatuses: string[];
  statusReasons: Array<string | undefined>;
  pendingFails: string[];
  provider: InMemoryVoiceProvider;
  logs: { info: object[]; warn: object[]; error: object[] };
  /** I3: records `markSubmitted`/`setProviderResponse` call order for ordering assertions. */
  callOrder: string[];
}

function harness(
  theJob: ProcessingJob | null,
  opts: { fetchDecryptedProfiles?: FetchFn; provider?: VoiceProviderBase } = {},
  attempt?: CampaignJobDeps['attempt'],
): Harness {
  const itemMarks: Harness['itemMarks'] = [];
  const submitted: Harness['submitted'] = [];
  const providerResponses: unknown[] = [];
  const fetchQueries: SignalStackFetchDecryptedProfilesQuery[] = [];
  const jobStatuses: string[] = [];
  const statusReasons: Array<string | undefined> = [];
  const pendingFails: string[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  const callOrder: string[] = [];
  let heartbeats = 0;
  const provider = new InMemoryVoiceProvider();

  // Same forward-only terminal set the real markItem/markSubmitted guard on.
  const TERMINAL_STATUSES = [
    'submitted',
    'sent',
    'skipped_not_owned',
    'skipped_no_contact',
    'duplicate_active',
    'failed',
  ];

  const itemStatus = new Map(
    (theJob?.items ?? []).map((i) => [
      i.itemId,
      { status: i.status as string, err: null as string | null },
    ]),
  );

  const defaultFetch: FetchFn = async (q) => {
    fetchQueries.push(q);
    return ok({ profiles: q.itemIds.map((id) => row({ item_id: id })), skipped: [] });
  };

  const deps: CampaignJobDeps = {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, errorReason) => {
        itemMarks.push({ itemId, status, ...(errorReason ? { err: errorReason } : {}) });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL_STATUSES.includes(cur.status)) {
          cur.status = status;
          cur.err = errorReason ?? null;
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
      setNotifiedAt: async () => undefined,
      failPendingItems: async (_jobId, reason) => {
        pendingFails.push(reason);
        for (const v of itemStatus.values()) {
          if (v.status === 'pending') {
            v.status = 'failed';
            v.err = reason;
          }
        }
      },
      markSubmitted: async (_jobId, itemId, args) => {
        callOrder.push(`markSubmitted:${itemId}`);
        submitted.push({
          itemId,
          providerBatchRef: args.providerBatchRef,
          ...(args.providerRef !== undefined ? { providerRef: args.providerRef } : {}),
        });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL_STATUSES.includes(cur.status)) {
          cur.status = 'submitted';
          cur.err = null;
        }
      },
      setProviderResponse: async (_jobId, response) => {
        callOrder.push('setProviderResponse');
        providerResponses.push(response);
      },
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
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: [] }),
      putObject: async () => undefined,
      signDownloadUrl: async () => ({ url: '', key: '', expiresAt: '' }),
      sendMail: async () => ({ ok: true, value: { messageId: 'm-1' } }),
    },
    voice: {
      fetchDecryptedProfiles: opts.fetchDecryptedProfiles ?? defaultFetch,
      provider: opts.provider ?? provider,
    },
    config: {
      decryptChunk: 500,
      fieldSet: 'contact',
      recipientMode: 'requester',
      emailSendConcurrency: 5,
    },
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...(attempt ? { attempt } : {}),
  };

  return {
    deps,
    itemMarks,
    submitted,
    providerResponses,
    fetchQueries,
    heartbeats: () => heartbeats,
    jobStatuses,
    statusReasons,
    pendingFails,
    provider,
    logs,
    callOrder,
  };
}

describe('runVoiceForJob (via runCampaignJob)', () => {
  it('requests contact name/phone plus the content.variables field projection', async () => {
    const h = harness(job({ content: { agent_id: 'agent-1', variables: ['role'] } }));
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(1);
    expect(h.fetchQueries[0]!.contact).toEqual(['name', 'phone']);
    expect(h.fetchQueries[0]!.fields).toEqual(['role']);
  });

  it("I6: the decrypt query is scoped to the job's own signalstackOrgId (cross-org guard)", async () => {
    const h = harness(job({ signalstackOrgId: 'org-owning-this-job' }));
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(1);
    expect(h.fetchQueries[0]!.actingOrgId).toBe('org-owning-this-job');
  });

  it('omits the fields key (full item_state) when content.variables is unset', async () => {
    const h = harness(job()); // default content: { agent_id: 'agent-1' } — no variables
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(1);
    expect(h.fetchQueries[0]).not.toHaveProperty('fields');
  });

  it('builds contacts with ref + flattened, JSON-stringified variables', async () => {
    const h = harness(
      job({
        items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    const [contact] = h.provider.dispatches[0]!.contacts;
    expect(contact).toEqual({
      ref: 'item-1',
      name: 'Asha',
      phone: '+910000000001',
      variables: { role: 'Electrician', langs: '["hi","en"]' },
    });
    expect(h.itemMarks).toContainEqual({ itemId: 'item-1', status: 'resolved' });
  });

  it('marks a not-owned item skipped_not_owned', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () =>
        ok({ profiles: [row({ item_id: 'item-1' })], skipped: ['item-2'] }),
    });
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
  });

  it('marks an owned item with no phone skipped_no_contact and excludes it from the batch', async () => {
    const h = harness(
      job({
        items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({
                item_id: 'item-1',
                contact: {
                  name: { value: 'Asha', source: 'item' },
                  phone: { value: null, source: null },
                },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'skipped_no_contact',
      err: 'no_phone',
    });
    expect(h.provider.dispatches).toHaveLength(0);
  });

  it('calls dispatch once and persists accepted (markSubmitted) vs rejected (failed)', async () => {
    const h = harness(job());
    h.provider.setReject('item-2', 'invalid phone number');
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    expect(h.submitted).toEqual([{ itemId: 'item-1', providerBatchRef: 'mem-batch-1' }]);
    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'failed',
      err: 'invalid phone number',
    });
  });

  it('perf follow-up: passes reuseExisting=false to dispatch on a first attempt (deps.attempt omitted)', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    expect(h.provider.dispatches[0]!.reuseExisting).toBe(false);
  });

  it('perf follow-up: passes reuseExisting=false to dispatch on attempt 1 of N', async () => {
    const h = harness(job(), {}, { attempt: 1, maxAttempts: 3 });
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    expect(h.provider.dispatches[0]!.reuseExisting).toBe(false);
  });

  it('perf follow-up: passes reuseExisting=true to dispatch on a BullMQ retry (attempt > 1)', async () => {
    const h = harness(job(), {}, { attempt: 2, maxAttempts: 3 });
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    expect(h.provider.dispatches[0]!.reuseExisting).toBe(true);
  });

  it('stores the raw provider response on the job', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.providerResponses).toHaveLength(1);
    expect(h.providerResponses[0]).toMatchObject({
      create: expect.anything(),
      start: expect.anything(),
    });
  });

  it('I3: stamps markSubmitted (the retry-safety batch ref write) before the setProviderResponse audit write', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    // Both accepted items' markSubmitted calls land before
    // setProviderResponse — so a crash between them still leaves the
    // retry-safety guard armed (some item already carries a batch ref).
    expect(h.callOrder).toEqual([
      'markSubmitted:item-1',
      'markSubmitted:item-2',
      'setProviderResponse',
    ]);
  });

  it('I3: a setProviderResponse failure still leaves accepted items stamped submitted', async () => {
    const h = harness(job());
    h.deps.client.setProviderResponse = async () => {
      throw new Error('audit write down');
    };

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/audit write down/);

    // The batch-ref writes already committed before the audit write failed —
    // both items are submitted, so a retry's guard sees an existing batch
    // ref and resumes rather than re-dispatching (see the module note).
    expect(h.submitted).toEqual(
      expect.arrayContaining([
        { itemId: 'item-1', providerBatchRef: 'mem-batch-1' },
        { itemId: 'item-2', providerBatchRef: 'mem-batch-1' },
      ]),
    );
  });

  it('never decrypts or dispatches a duplicate_active item', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'item-1', action: 'voice', status: 'duplicate_active', providerBatchRef: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
  });

  it('retry-safety: a job whose items already carry a raya_batch_id is never re-dispatched', async () => {
    const h = harness(
      job({
        items: [
          {
            itemId: 'item-1',
            action: 'voice',
            status: 'submitted',
            providerBatchRef: 'batch-prior',
          },
          { itemId: 'item-2', action: 'voice', status: 'pending', providerBatchRef: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
    // item-2 was never decrypted (still `pending`, not `resolved`) on the
    // crashed attempt, so it's left alone rather than guessed at.
    expect(h.submitted).toHaveLength(0);
  });

  it('retry-safety resume: a mix of already-submitted + resolved items all end submitted under the known batch, with no second dispatch call', async () => {
    const h = harness(
      job({
        items: [
          {
            itemId: 'item-1',
            action: 'voice',
            status: 'submitted',
            providerBatchRef: 'batch-prior',
          },
          { itemId: 'item-2', action: 'voice', status: 'resolved', providerBatchRef: null },
          { itemId: 'item-3', action: 'voice', status: 'resolved', providerBatchRef: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    // No re-decrypt, no second batch created at the provider.
    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
    // Every still-`resolved` item is resumed under the known batch id.
    expect(h.submitted).toEqual(
      expect.arrayContaining([
        { itemId: 'item-2', providerBatchRef: 'batch-prior' },
        { itemId: 'item-3', providerBatchRef: 'batch-prior' },
      ]),
    );
    expect(h.submitted).toHaveLength(2);
    // The already-submitted item-1 is untouched — forward-only guard, not re-marked.
    expect(h.submitted.find((s) => s.itemId === 'item-1')).toBeUndefined();
  });

  it('throws (BullMQ retry) when the provider dispatch fails', async () => {
    const h = harness(job(), {}, { attempt: 1, maxAttempts: 3 });
    h.deps.voice!.provider = new FailingVoiceProvider();

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/raya down/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
    expect(h.submitted).toHaveLength(0);
  });

  it('fails leftover items on the final attempt after a dispatch failure', async () => {
    const h = harness(job(), {}, { attempt: 3, maxAttempts: 3 });
    h.deps.voice!.provider = new FailingVoiceProvider();

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/raya down/);
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(h.pendingFails).toEqual(['job_failed']);
  });

  it('deterministic ValidationError (e.g. a Raya start-400): marks items failed with the specific reason, does NOT throw, and does not orphan-batch on a subsequent retry', async () => {
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new ValidationError('raya /batch/1/start returned 400', {
        code: 'RAYA_BAD_REQUEST',
        details: {
          status: 400,
          body: JSON.stringify({ message: 'max_concurrent_calls is required' }),
        },
      }),
    );
    h.deps.voice!.provider = provider;

    // No throw — a deterministic 4xx is terminal, not retryable.
    await expect(runCampaignJob('job-1', h.deps)).resolves.toBeUndefined();

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'failed',
      err: expect.stringContaining('max_concurrent_calls is required'),
    });
    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'failed',
      err: expect.stringContaining('max_concurrent_calls is required'),
    });
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(provider.calls).toHaveLength(1);

    // Job is now terminal — a BullMQ-style re-run of the same jobId must not
    // call dispatch() a second time (no orphan-batch multiplication).
    await runCampaignJob('job-1', h.deps);
    expect(provider.calls).toHaveLength(1);
  });

  it('deterministic AuthError (bad API key): marks items failed and does NOT throw', async () => {
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new AuthError('raya /batch returned 401', {
        code: 'RAYA_UNAUTHORIZED',
        details: { status: 401, body: JSON.stringify({ message: 'invalid api key' }) },
      }),
    );
    h.deps.voice!.provider = provider;

    await expect(runCampaignJob('job-1', h.deps)).resolves.toBeUndefined();

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'failed',
      err: expect.stringContaining('invalid api key'),
    });
    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'failed',
      err: expect.stringContaining('invalid api key'),
    });
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(provider.calls).toHaveLength(1);
  });

  it('transient UpstreamError still throws (retryable) and does NOT mark items failed', async () => {
    const h = harness(job(), {}, { attempt: 1, maxAttempts: 3 });
    const provider = new ErroringVoiceProvider(
      new UpstreamError('raya down', { code: 'RAYA_UPSTREAM_ERROR' }),
    );
    h.deps.voice!.provider = provider;

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/raya down/);
    expect(h.itemMarks.filter((m) => m.status === 'failed')).toHaveLength(0);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
    expect(provider.calls).toHaveLength(1);
  });

  it('never logs contact PII', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000001');
  });

  it('never writes contact PII into the item-level store calls (markItem/markSubmitted)', async () => {
    const h = harness(job());
    h.provider.setReject('item-2', 'invalid phone number');
    await runCampaignJob('job-1', h.deps);

    // itemMarks/submitted only ever carry ids, statuses, and provider batch
    // refs — never the decrypted name/phone that produced them.
    const serialized = JSON.stringify([...h.itemMarks, ...h.submitted]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000001');
  });

  it('throws when deps.voice is not wired for a voice-channel job', async () => {
    const h = harness(job());
    // exactOptionalPropertyTypes forbids `voice: undefined` — omit the key
    // entirely, matching how a real export-only deployment would build deps.
    const { voice: _voice, ...rest } = h.deps;
    await expect(runCampaignJob('job-1', rest)).rejects.toThrow(/voice collaborators/);
  });

  it('throws (BullMQ retry) when the decrypt call itself errors', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/decrypt/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
  });

  it('throws when job.content is missing agent_id (a malformed row the API schema should have rejected)', async () => {
    const h = harness(job({ content: {} }));
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/agent_id/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
  });

  it('flattens item_state into string variables, dropping null/undefined entries', async () => {
    const h = harness(
      job({
        items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({
                item_id: 'item-1',
                item_state: { role: 'Electrician', middle_name: null, nickname: undefined },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    const [contact] = h.provider.dispatches[0]!.contacts;
    expect(contact!.variables).toEqual({ role: 'Electrician' });
    expect(contact!.variables).not.toHaveProperty('middle_name');
    expect(contact!.variables).not.toHaveProperty('nickname');
  });

  it('JSON-stringifies object/array item_state values instead of coercing to "[object Object]"', async () => {
    const h = harness(
      job({
        items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({
                item_id: 'item-1',
                item_state: {
                  langs: ['hi', 'en'],
                  address: { city: 'Ghaziabad', pin: '201001' },
                  years_experience: 3,
                },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    const [contact] = h.provider.dispatches[0]!.contacts;
    expect(contact!.variables).toEqual({
      langs: JSON.stringify(['hi', 'en']),
      address: JSON.stringify({ city: 'Ghaziabad', pin: '201001' }),
      years_experience: '3',
    });
    expect(contact!.variables['langs']).not.toBe('[object Object]');
    expect(contact!.variables['address']).not.toBe('[object Object]');
  });

  it('falls back to an empty name when the decrypted contact carries no name value', async () => {
    const h = harness(
      job({
        items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({
                item_id: 'item-1',
                contact: { phone: { value: '+910000000001', source: 'item' } },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    const [contact] = h.provider.dispatches[0]!.contacts;
    expect(contact!.name).toBe('');
    expect(contact!.phone).toBe('+910000000001');
  });

  it('forwards every Raya start-option key present on the content to dispatch', async () => {
    const h = harness(
      job({
        content: {
          agent_id: 'agent-1',
          schedule: { start: '2026-01-01T00:00:00Z' },
          max_retries: 2,
          retry_after_hrs: 4,
          max_concurrent_calls: 5,
          selected_statuses: ['no-answer'],
        },
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches[0]!.startOptions).toEqual({
      schedule: { start: '2026-01-01T00:00:00Z' },
      max_retries: 2,
      retry_after_hrs: 4,
      max_concurrent_calls: 5,
      selected_statuses: ['no-answer'],
    });
  });

  it('describeDispatchFailure: falls back to the bare error message when the provider gives no response body', async () => {
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new AuthError('raya /batch returned 401', { code: 'RAYA_UNAUTHORIZED' }), // no `details`
    );
    h.deps.voice!.provider = provider;

    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'failed',
      err: 'raya /batch returned 401',
    });
  });

  it('describeDispatchFailure (C1): falls back to the bare error message when the body is not JSON — never the raw body text', async () => {
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new ValidationError('raya /batch/1/start returned 400', {
        code: 'RAYA_BAD_REQUEST',
        details: { status: 400, body: 'Bad Gateway' },
      }),
    );
    h.deps.voice!.provider = provider;

    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'failed',
      err: 'raya /batch/1/start returned 400',
    });
    // The raw body text must never reach the persisted reason.
    expect(
      h.itemMarks.find((m) => m.itemId === 'item-1' && m.status === 'failed')?.err,
    ).not.toContain('Bad Gateway');
  });

  it('describeDispatchFailure (C1): falls back to the bare error message when the JSON body carries no top-level message field — never the raw body', async () => {
    const body = JSON.stringify({ error: 'bad_request' });
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new ValidationError('raya /batch/1/start returned 400', {
        code: 'RAYA_BAD_REQUEST',
        details: { status: 400, body },
      }),
    );
    h.deps.voice!.provider = provider;

    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'failed',
      err: 'raya /batch/1/start returned 400',
    });
    expect(
      h.itemMarks.find((m) => m.itemId === 'item-1' && m.status === 'failed')?.err,
    ).not.toContain('bad_request');
  });

  it('describeDispatchFailure (C1, PII leak): a Raya 400 body embedding a phone number and data[] never leaks into error_reason — only the parsed top-level message survives', async () => {
    // Modelled on Raya's REAL `POST /batch` 400 shape: `errors[].value` echoes
    // the raw rejected phone back, and `data[]` echoes the full submitted
    // contact rows (name/phone) — both PII that must never reach
    // campaign_job_item.error_reason, a column the campaign manager reads
    // verbatim.
    const rawBody = JSON.stringify({
      status: 'error',
      message: 'max_concurrent_calls is required',
      errors: [
        { row: 1, field: 'contact_phone', value: '+910000000001', message: 'invalid phone' },
      ],
      data: [{ ref: 'item-1', contact_name: 'Asha', contact_phone: '+910000000001' }],
    });
    const h = harness(job());
    const provider = new ErroringVoiceProvider(
      new ValidationError('raya /batch/1/start returned 400', {
        code: 'RAYA_BAD_REQUEST',
        details: { status: 400, body: rawBody },
      }),
    );
    h.deps.voice!.provider = provider;

    await runCampaignJob('job-1', h.deps);

    const reason = h.itemMarks.find((m) => m.itemId === 'item-1' && m.status === 'failed')?.err;
    expect(reason).toBe('raya /batch/1/start returned 400: max_concurrent_calls is required');
    // Only error.message + the parsed top-level `message` survive — never
    // the raw phone number or the raw body (errors[]/data[]).
    expect(reason).not.toContain('+910000000001');
    expect(reason).not.toContain('Asha');
    expect(reason).not.toContain('errors');
    expect(reason).not.toContain('data');
  });
});
