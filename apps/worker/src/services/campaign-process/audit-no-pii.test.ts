/**
 * Property test: no DECRYPTED participant PII value can reach the worker's
 * `completed` audit row (aggregator-dpg#617).
 *
 * Scope note (this is the worker-side counterpart of
 * `apps/api/src/campaign/__tests__/audit-no-pii.test.ts` — read that file's
 * doc first): the API-side test proves the guarantee only for `apps/api`,
 * and its own doc says why that is a narrow proof — the API never decrypts a
 * participant record, it only ever sees item-id uuids and an opaque
 * `content` object. **The worker is the only place a real decrypted
 * participant record exists** (`decryptEmailItems` in `./email.ts`, and its
 * voice twin `decryptVoiceItems` in `./voice.ts`), and the worker is what
 * writes the `completed` row (`runCampaignJob` in `./index.ts`). So the
 * no-PII guarantee is unproven exactly where the risk is real — and it has
 * already failed for real once, on the voice channel's `content.variables`
 * (see `apps/api/src/campaign/audit-field-names.ts`'s module doc). This file
 * closes that gap for the worker.
 *
 * What it drives: both channels that decrypt real participant rows (email,
 * voice) through `runCampaignJob`, seeded with distinctive name/email/phone
 * values plus (voice only, since it is the channel that actually projects
 * `item_state`) a distinctive `item_state` field value — then asserts none
 * of those values appear anywhere in the captured `completed` audit row,
 * across BOTH terminal paths that write one: the ordinary success roll-up
 * (`runCampaignJob`'s try block) and a final-attempt failure (the catch
 * block, once `attempt.attempt >= attempt.maxAttempts`). Decrypt always
 * happens first in both channels, so by the time either terminal path
 * writes its row, the PII values were already resolved into memory — this
 * is deliberately not "decrypt never ran".
 *
 * All PII assertions are case-insensitive (per the task-7 finding that a
 * `.toLowerCase()`'d copy of a value slips past a case-sensitive
 * `.not.toContain(...)`). Substring matching has the same inherent blind
 * spot the API-side test documents and does NOT chase: a truncated or
 * otherwise transformed fragment of a PII value (e.g. `name.slice(0, 4)`)
 * would not be caught by any string-containment check, case-insensitive or
 * not. This test proves the sanctioned `CompletedAuditInput` fields stay
 * free of the PII values used here, not that no partial fragment of one
 * could ever appear under some other transformation.
 *
 * @module apps/worker/campaign-process/audit-no-pii.test
 */
import { describe, it, expect } from 'vitest';
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { CampaignAuditWriterFake, type AuditRow } from '@aggregator-dpg/campaign-audit/testing';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import type {
  VoiceDispatchInput,
  VoiceDispatchResult,
} from '@aggregator-dpg/voice-provider/interface';
import { InMemoryVoiceProvider } from '@aggregator-dpg/voice-provider/testing';
import {
  deriveJobStatus,
  type JobStatusCounts,
  type ProcessingJob,
} from '../campaign-job-client.js';
import { runCampaignJob, type CampaignJobDeps } from './index.js';
import type { EmailCollaborators } from './email.js';
import type { VoiceCollaborators } from './voice.js';

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

/**
 * Distinctive decrypted-participant values seeded on every fake row in this
 * file. None of them is a plausible substring of a legitimate
 * `CompletedAuditInput` field (a channel name, a count, an error class
 * name, a destination string) — a match here can only mean the value itself
 * leaked.
 */
const PII_NAME = 'Ananya Rao';
const PII_EMAIL = 'ananya.rao@example.org';
const PII_PHONE = '+919876543210';
/** Voice projects `item_state` field values into call variables — see `flattenVariables` in `./voice.ts`. */
const PII_ITEM_STATE_VALUE = 'Warehouse-Supervisor-Shift-B';

const ALL_PII = [PII_NAME, PII_EMAIL, PII_PHONE, PII_ITEM_STATE_VALUE];

/**
 * Asserts none of {@link ALL_PII}'s values appear anywhere in the serialised
 * captured rows, matched case-insensitively. See the module doc for the
 * substring-matching limitation this does NOT cover (truncated/transformed
 * fragments).
 */
function assertNoPii(rows: AuditRow[]): void {
  const serialised = JSON.stringify(rows).toLowerCase();
  for (const value of ALL_PII) {
    expect(serialised).not.toContain(value.toLowerCase());
  }
}

/** A decrypted participant row carrying every PII value this file guards. */
function piiRow(itemId: string): SignalStackDecryptedProfileRow {
  return {
    item_id: itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { role: PII_ITEM_STATE_VALUE },
    contact: {
      name: { value: PII_NAME, source: 'item' },
      email: { value: PII_EMAIL, source: 'user' },
      phone: { value: PII_PHONE, source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

/** Minimal structured-logger stub — this file asserts on audit rows, never on logs. */
function noopLog(): CampaignJobDeps['log'] {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

/**
 * Builds a minimal, channel-agnostic {@link CampaignJobDeps} wired to
 * `theJob`, an in-memory item-status roll-up (so `rollUpStatus` derives a
 * real terminal status the way the production job-client would), and the
 * supplied `audit` writer. Only the collaborators the test actually needs
 * are passed via `over`.
 */
function buildDeps(
  theJob: ProcessingJob,
  over: {
    email?: EmailCollaborators;
    voice?: VoiceCollaborators;
    audit: CampaignAuditWriterFake;
    attempt?: CampaignJobDeps['attempt'];
  },
): CampaignJobDeps {
  const itemStatus = new Map(
    theJob.items.map((i) => [i.itemId, { status: i.status as string, err: null as string | null }]),
  );
  const TERMINAL = ['submitted', 'sent', 'skipped_not_owned', 'skipped_no_contact', 'failed'];

  return {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, reason) => {
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL.includes(cur.status)) {
          cur.status = status;
          cur.err = reason ?? null;
        }
      },
      heartbeat: async () => undefined,
      setJobStatus: async (_jobId, status) => {
        theJob.status = status;
      },
      countItems: async () => tallyItemStatus(itemStatus),
      rollUpStatus: async () => {
        const counts = tallyItemStatus(itemStatus);
        const status = deriveJobStatus(counts);
        theJob.status = status;
        return { status, counts };
      },
      setNotifiedAt: async () => undefined,
      failPendingItems: async (_jobId, reason) => {
        for (const v of itemStatus.values()) {
          if (v.status === 'pending') {
            v.status = 'failed';
            v.err = reason;
          }
        }
      },
      markSubmitted: async (_jobId, itemId) => {
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL.includes(cur.status)) cur.status = 'submitted';
      },
      setProviderResponse: async () => undefined,
    },
    export: {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: [] }),
      putObject: async () => undefined,
      signDownloadUrl: async (key) => ({ url: `https://signed/${key}`, key, expiresAt: 'x' }),
      sendMail: async () => ({ ok: true, value: { messageId: 'export-mail' } }),
    },
    config: {
      decryptChunk: 500,
      fieldSet: 'contact',
      recipientMode: 'requester',
      emailSendConcurrency: 5,
    },
    log: noopLog(),
    ...(over.email ? { email: over.email } : {}),
    ...(over.voice ? { voice: over.voice } : {}),
    ...(over.attempt ? { attempt: over.attempt } : {}),
    audit: over.audit,
  };
}

function emailJob(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-email-pii',
    channel: 'email',
    status: 'processing',
    signalstackOrgId: 'org-1',
    metadata: [{ key: 'purpose', value: 'quarterly outreach' }],
    content: { subject: 'Hi {{first_name}}', body_markdown: 'Hello **{{name}}**, news.' },
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    items: [{ itemId: 'item-1', action: null, status: 'pending', providerBatchRef: null }],
    ...over,
  } as ProcessingJob;
}

function voiceJob(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-voice-pii',
    channel: 'voice',
    status: 'processing',
    signalstackOrgId: 'org-1',
    metadata: [{ key: 'purpose', value: 'quarterly outreach' }],
    content: { agent_id: 'agent-1', variables: ['role'] },
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    items: [{ itemId: 'item-1', action: 'voice', status: 'pending', providerBatchRef: null }],
    ...over,
  } as ProcessingJob;
}

/** Email collaborators that decrypt one PII-bearing row and send successfully. */
function successfulEmailCollaborators(): EmailCollaborators {
  return {
    fetchDecryptedProfiles: async (q: SignalStackFetchDecryptedProfilesQuery) =>
      ok({ profiles: q.itemIds.map((id) => piiRow(id)), skipped: [] }),
    sendMail: async (_input: SendInput): Promise<MailerResult<SendOk>> =>
      ({ ok: true, value: { messageId: 'msg-1' } }) as MailerResult<SendOk>,
  };
}

/**
 * Email collaborators that decrypt the PII row successfully, then blow up
 * with an unexpected (non-`MailerResult`) exception from the mailer —
 * modelling a final-attempt terminal failure that happens AFTER PII was
 * already resolved into memory.
 */
function explodingEmailCollaborators(): EmailCollaborators {
  return {
    fetchDecryptedProfiles: async (q: SignalStackFetchDecryptedProfilesQuery) =>
      ok({ profiles: q.itemIds.map((id) => piiRow(id)), skipped: [] }),
    sendMail: async (): Promise<MailerResult<SendOk>> => {
      throw new Error('smtp transport exploded');
    },
  };
}

/** A voice provider that always accepts every contact. */
function successfulVoiceCollaborators(): VoiceCollaborators {
  return {
    fetchDecryptedProfiles: async (q: SignalStackFetchDecryptedProfilesQuery) =>
      ok({ profiles: q.itemIds.map((id) => piiRow(id)), skipped: [] }),
    provider: new InMemoryVoiceProvider(),
  };
}

/** A voice provider whose `dispatch()` throws an unexpected exception (not an `err(...)` Result). */
class ExplodingVoiceProvider extends VoiceProviderBase {
  override async dispatch(
    _input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    throw new Error('raya connection reset');
  }
}

function explodingVoiceCollaborators(): VoiceCollaborators {
  return {
    fetchDecryptedProfiles: async (q: SignalStackFetchDecryptedProfilesQuery) =>
      ok({ profiles: q.itemIds.map((id) => piiRow(id)), skipped: [] }),
    provider: new ExplodingVoiceProvider(),
  };
}

describe('worker completed-audit rows never contain a decrypted participant PII value (#617)', () => {
  describe('email channel', () => {
    it('holds on the success roll-up path', async () => {
      const audit = new CampaignAuditWriterFake();
      const deps = buildDeps(emailJob(), { email: successfulEmailCollaborators(), audit });

      await runCampaignJob('job-email-pii', deps);

      const rows = audit.rows.filter((r) => r.kind === 'completed');
      expect(rows).toHaveLength(1);
      expect((rows[0] as { outcome?: string }).outcome).toBe('succeeded');
      assertNoPii(audit.rows);
    });

    it('holds on the final-attempt failure path, even though PII was already decrypted', async () => {
      const audit = new CampaignAuditWriterFake();
      const deps = buildDeps(emailJob(), {
        email: explodingEmailCollaborators(),
        audit,
        attempt: { attempt: 3, maxAttempts: 3 },
      });

      await expect(runCampaignJob('job-email-pii', deps)).rejects.toThrow(
        'smtp transport exploded',
      );

      const rows = audit.rows.filter((r) => r.kind === 'completed');
      expect(rows).toHaveLength(1);
      expect((rows[0] as { outcome?: string }).outcome).toBe('failed');
      assertNoPii(audit.rows);
    });
  });

  describe('voice channel', () => {
    it('holds on the success roll-up path, including the item_state field voice projects', async () => {
      const audit = new CampaignAuditWriterFake();
      const deps = buildDeps(voiceJob(), { voice: successfulVoiceCollaborators(), audit });

      await runCampaignJob('job-voice-pii', deps);

      const rows = audit.rows.filter((r) => r.kind === 'completed');
      expect(rows).toHaveLength(1);
      expect((rows[0] as { outcome?: string }).outcome).toBe('succeeded');
      assertNoPii(audit.rows);
    });

    it('records a non-zero resolvedCount for a fully successful voice job (#617 follow-up)', async () => {
      // Voice items terminate at `submitted` — never `resolved` or `sent`
      // (see `decryptVoiceItems`/`markSubmitted` in `./voice.ts`). Before
      // rolling `submitted` into `resolvedCount`, this exact scenario — every
      // contact accepted by the provider — produced a `completed` row with
      // EVERY outcome count at zero: indistinguishable from "nothing was
      // released" even though every phone number went to Raya. This harness
      // (unlike the simpler export-focused one in `index.test.ts`) correctly
      // models the forward-only `resolved -> submitted` transition, so it is
      // the one that can actually prove this.
      const audit = new CampaignAuditWriterFake();
      const deps = buildDeps(voiceJob(), { voice: successfulVoiceCollaborators(), audit });

      await runCampaignJob('job-voice-pii', deps);

      const rows = audit.rows.filter((r) => r.kind === 'completed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: 'succeeded',
        resolvedCount: 1,
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
      });
    });

    it('holds on the final-attempt failure path, even though PII was already decrypted', async () => {
      const audit = new CampaignAuditWriterFake();
      const deps = buildDeps(voiceJob(), {
        voice: explodingVoiceCollaborators(),
        audit,
        attempt: { attempt: 3, maxAttempts: 3 },
      });

      await expect(runCampaignJob('job-voice-pii', deps)).rejects.toThrow('raya connection reset');

      const rows = audit.rows.filter((r) => r.kind === 'completed');
      expect(rows).toHaveLength(1);
      expect((rows[0] as { outcome?: string }).outcome).toBe('failed');
      assertNoPii(audit.rows);
    });
  });
});
