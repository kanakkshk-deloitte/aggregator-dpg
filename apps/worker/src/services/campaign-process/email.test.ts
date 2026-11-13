/**
 * Unit tests for the campaign email channel: the whole handler
 * (`runEmailForJob`) and the per-recipient send loop it drives.
 *
 * @module @aggregator-dpg/worker
 */
import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import type { JobStatusCounts, ProcessingJob } from '../campaign-job-client.js';
import type { CampaignJobDeps } from './index.js';
import {
  runEmailForJob,
  sendCampaignEmails,
  type EmailCollaborators,
  type EmailSendDeps,
} from './email.js';

function row(
  itemId: string,
  contact: SignalStackDecryptedProfileRow['contact'] = {
    name: { value: 'Asha', source: 'item' },
    email: { value: `${itemId}@example.com`, source: 'user' },
  },
): SignalStackDecryptedProfileRow {
  return {
    item_id: itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    ...(contact ? { contact } : {}),
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

const TEMPLATE = { subject: 'Hi {{first_name}}', bodyMarkdown: 'Hello {{name}}' };

/** Zero item-status tally — `jobHarness`'s `rollUpStatus`/`countItems` never drive an assertion in this file (that's `index.test.ts`'s job). */
const ZERO_COUNTS: JobStatusCounts = {
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

interface Harness {
  deps: EmailSendDeps;
  sends: SendInput[];
  marks: Array<{ itemId: string; status: string; reason?: string; ref?: string }>;
  maxInFlight: () => number;
  heartbeats: () => number;
}

function harness(over: Partial<Pick<EmailSendDeps, 'sendMail' | 'concurrency'>> = {}): Harness {
  const sends: SendInput[] = [];
  const marks: Harness['marks'] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let heartbeats = 0;

  const deps: EmailSendDeps = {
    sendMail: async (input): Promise<MailerResult<SendOk>> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so concurrent senders overlap observably.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      sends.push(input);
      return { ok: true, value: { messageId: `msg-${sends.length}` } };
    },
    concurrency: 5,
    heartbeat: async () => {
      heartbeats += 1;
    },
    markRecipient: async (itemId, status, detail) => {
      marks.push({
        itemId,
        status,
        ...(detail?.reason ? { reason: detail.reason } : {}),
        ...(detail?.providerRef ? { ref: detail.providerRef } : {}),
      });
    },
    log: { info: () => undefined },
    ...over,
  };
  return { deps, sends, marks, maxInFlight: () => maxInFlight, heartbeats: () => heartbeats };
}

describe('sendCampaignEmails', () => {
  it('renders per recipient and reports sent with the mailer message id', async () => {
    const h = harness();
    const summary = await sendCampaignEmails([row('a')], TEMPLATE, h.deps);

    expect(summary).toEqual({ sent: 1, skippedNoContact: 0, failed: 0, transient: [] });
    expect(h.sends[0]!.to).toBe('a@example.com');
    expect(h.sends[0]!.subject).toBe('Hi Asha');
    expect(h.marks).toEqual([{ itemId: 'a', status: 'sent', ref: 'msg-1' }]);
  });

  it('sets Reply-To only when the template carries one', async () => {
    const withReply = harness();
    await sendCampaignEmails([row('a')], { ...TEMPLATE, replyTo: 'x@y.example' }, withReply.deps);
    expect(withReply.sends[0]!.replyTo).toBe('x@y.example');

    const without = harness();
    await sendCampaignEmails([row('a')], TEMPLATE, without.deps);
    expect(without.sends[0]!.replyTo).toBeUndefined();
  });

  it('reports a recipient with no email as skipped_no_contact and sends nothing', async () => {
    const h = harness();
    const summary = await sendCampaignEmails(
      [row('a', { name: { value: 'Ravi', source: 'item' } })],
      TEMPLATE,
      h.deps,
    );
    expect(summary).toEqual({ sent: 0, skippedNoContact: 1, failed: 0, transient: [] });
    expect(h.sends).toHaveLength(0);
    expect(h.marks).toEqual([
      { itemId: 'a', status: 'skipped_no_contact', reason: 'no_email_address' },
    ]);
  });

  it('records a permanently rejected address as failed, with the code only', async () => {
    let call = 0;
    const h = harness({
      sendMail: async (): Promise<MailerResult<SendOk>> => {
        call += 1;
        return call === 1
          ? {
              ok: false,
              // The provider's message quotes the address — exactly what must
              // not reach the item row or the poll API.
              error: {
                code: 'INVALID_RECIPIENT',
                message: '550 5.1.1 <a@example.com>: Recipient address rejected',
              },
            }
          : { ok: true, value: { messageId: 'msg-ok' } };
      },
    });
    const summary = await sendCampaignEmails([row('a'), row('b')], TEMPLATE, h.deps);

    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.transient).toEqual([]);
    // Only the typed code is persisted — no address, no provider text.
    expect(h.marks).toContainEqual({ itemId: 'a', status: 'failed', reason: 'INVALID_RECIPIENT' });
    const persisted = JSON.stringify(h.marks);
    expect(persisted).not.toContain('a@example.com');
    expect(persisted).not.toContain('550');
    expect(h.marks).toContainEqual({ itemId: 'b', status: 'sent', ref: 'msg-ok' });
  });

  it('reports a transient send failure without writing it to the item row', async () => {
    let call = 0;
    const h = harness({
      sendMail: async (): Promise<MailerResult<SendOk>> => {
        call += 1;
        return call === 1
          ? { ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp timeout' } }
          : { ok: true, value: { messageId: 'msg-ok' } };
      },
    });
    const summary = await sendCampaignEmails([row('a'), row('b')], TEMPLATE, h.deps);

    // `failed` is terminal, so a transient error must NOT be written here — the
    // caller decides from the job's retry position.
    expect(summary.transient).toEqual([{ itemId: 'a', code: 'TRANSPORT_FAILED' }]);
    expect(summary.failed).toBe(0);
    expect(h.marks.map((m) => m.itemId)).toEqual(['b']);
  });

  it('records a render failure terminally rather than burning every attempt', async () => {
    const h = harness();
    const summary = await sendCampaignEmails(
      [row('a')],
      // A body that makes the Markdown renderer throw is hard to construct, so
      // drive the same branch by making the template itself invalid input.
      { subject: 'S', bodyMarkdown: null as unknown as string },
      h.deps,
    );
    expect(summary.failed).toBe(1);
    expect(h.marks).toEqual([{ itemId: 'a', status: 'failed', reason: 'render_failed' }]);
    expect(h.sends).toHaveLength(0);
  });

  it('beats the heartbeat during a long batch', async () => {
    const h = harness({ concurrency: 4 });
    const rows = Array.from({ length: 50 }, (_, i) => row(`r${i}`));
    await sendCampaignEmails(rows, TEMPLATE, h.deps);
    // 50 recipients at one heartbeat per 25 → the watchdog sees progress
    // instead of flagging an actively-sending job `stalled`.
    expect(h.heartbeats()).toBeGreaterThanOrEqual(2);
  });

  it('never exceeds the configured send concurrency', async () => {
    const h = harness({ concurrency: 2 });
    const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}`));
    const summary = await sendCampaignEmails(rows, TEMPLATE, h.deps);

    expect(summary.sent).toBe(8);
    expect(h.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it('is a no-op for an empty recipient list', async () => {
    const h = harness();
    expect(await sendCampaignEmails([], TEMPLATE, h.deps)).toEqual({
      sent: 0,
      skippedNoContact: 0,
      failed: 0,
      transient: [],
    });
    expect(h.sends).toHaveLength(0);
  });
});

// ─── The channel handler end-to-end (runEmailForJob) ────────────────────────
// The send loop above is covered in isolation; these drive the handler itself:
// content validation, the terminal-item retry guard, the decrypt projection,
// and the per-item status writes.

function job(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-1',
    channel: 'email',
    status: 'processing',
    signalstackOrgId: 'org-1',
    metadata: [{ key: 'purpose', value: 'audit' }],
    content: { subject: 'Hello {{first_name}}', body_markdown: 'Hi **{{name}}**, news.' },
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    providerResponse: null,
    items: [{ itemId: 'item-1', action: null, status: 'pending', providerBatchRef: null }],
    ...over,
  } as ProcessingJob;
}

function profileRow(
  itemId: string,
  contact: SignalStackDecryptedProfileRow['contact'] = {
    name: { value: 'Asha', source: 'item' },
    email: { value: 'asha@example.com', source: 'user' },
    phone: { value: '+910000000000', source: 'item' },
  },
): SignalStackDecryptedProfileRow {
  return {
    item_id: itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    ...(contact ? { contact } : {}),
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

function pendingItem(itemId: string, status = 'pending') {
  return { itemId, action: null, status, providerBatchRef: null } as ProcessingJob['items'][number];
}

interface JobHarness {
  deps: CampaignJobDeps;
  emails: SendInput[];
  itemMarks: Array<{ itemId: string; status: string; err?: string; ref?: string }>;
  queries: SignalStackFetchDecryptedProfilesQuery[];
  heartbeats: () => number;
  logs: { info: object[]; warn: object[]; error: object[] };
}

function jobHarness(
  theJob: ProcessingJob,
  over: Partial<EmailCollaborators> = {},
  attempt?: CampaignJobDeps['attempt'],
): JobHarness {
  const emails: SendInput[] = [];
  const itemMarks: JobHarness['itemMarks'] = [];
  const queries: SignalStackFetchDecryptedProfilesQuery[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  let heartbeats = 0;

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
      },
      heartbeat: async () => {
        heartbeats++;
      },
      setJobStatus: async () => undefined,
      rollUpStatus: async () => ({ status: 'completed', counts: ZERO_COUNTS }),
      setNotifiedAt: async () => undefined,
      failPendingItems: async () => undefined,
      markSubmitted: async () => undefined,
      setProviderResponse: async () => undefined,
      countItems: async () => ZERO_COUNTS,
    },
    export: {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: [] }),
      putObject: async () => undefined,
      signDownloadUrl: async (key) => ({ url: `https://signed/${key}`, key, expiresAt: 'x' }),
      sendMail: async () => ({ ok: true, value: { messageId: 'export-mail' } }),
    },
    email: {
      fetchDecryptedProfiles: async (q) => {
        queries.push(q);
        return ok({ profiles: (q.itemIds ?? []).map((id) => profileRow(id)), skipped: [] });
      },
      sendMail: async (input): Promise<MailerResult<SendOk>> => {
        emails.push(input);
        return { ok: true, value: { messageId: `msg-${emails.length}` } };
      },
      ...over,
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
  return { deps, emails, itemMarks, queries, heartbeats: () => heartbeats, logs };
}

describe('runEmailForJob', () => {
  it('emails every resolved recipient and records the message id', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('b')] });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(2);
    expect(h.emails[0]!.subject).toBe('Hello Asha');
    expect(h.emails[0]!.html).toContain('<strong>Asha</strong>');
    // `sent` carries the mailer's message id as the item's provider ref.
    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'sent', ref: 'msg-1' });
    expect(h.itemMarks).toContainEqual({ itemId: 'b', status: 'sent', ref: 'msg-2' });
    expect(h.heartbeats()).toBeGreaterThanOrEqual(1);
  });

  it('passes Reply-To through from the job content when set', async () => {
    const theJob = job({
      content: { subject: 'S', body_markdown: 'B', reply_to: 'campaign@org.example' },
    });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);
    expect(h.emails[0]!.replyTo).toBe('campaign@org.example');
  });

  it('requests only the contact fields the template references', async () => {
    const noTokens = job({ content: { subject: 'Hi', body_markdown: 'No tokens here' } });
    const h1 = jobHarness(noTokens);
    await runEmailForJob(noTokens, h1.deps);
    // No placeholders → only the address itself is needed.
    expect(h1.queries[0]).toMatchObject({ fields: [], contact: ['email'] });

    const withPhone = job({ content: { subject: 'Hi {{name}}', body_markdown: '{{phone}}' } });
    const h2 = jobHarness(withPhone);
    await runEmailForJob(withPhone, h2.deps);
    expect(h2.queries[0]!.contact).toEqual(['email', 'name', 'phone']);
  });

  it('marks a recipient with no email address skipped_no_contact, not failed', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('b')] });
    const h = jobHarness(theJob, {
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [profileRow('a'), profileRow('b', { name: { value: 'Ravi', source: 'item' } })],
          skipped: [],
        }),
    });
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_no_contact',
      err: 'no_email_address',
    });
  });

  it('scopes the decrypt to the job org (cross-org PII guard)', async () => {
    const theJob = job({ signalstackOrgId: 'org-scoped-check' });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);
    // A regression that dropped or hardcoded this would leak another org's PII.
    expect(h.queries[0]!.actingOrgId).toBe('org-scoped-check');
  });

  it('fails an id Signals returns in neither profiles nor skipped', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('ghost')] });
    const h = jobHarness(theJob, {
      // `ghost` is simply absent from both lists.
      fetchDecryptedProfiles: async () => ok({ profiles: [profileRow('a')], skipped: [] }),
    });
    await runEmailForJob(theJob, h.deps);

    // Left `pending` it would strand the job until the watchdog stamped a
    // generic `stalled`, with no per-item reason.
    expect(h.itemMarks).toContainEqual({
      itemId: 'ghost',
      status: 'failed',
      err: 'decrypt_missing',
    });
  });

  it('retries the job on a transient send error while attempts remain', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('b')] });
    let call = 0;
    const h = jobHarness(
      theJob,
      {
        sendMail: async (): Promise<MailerResult<SendOk>> => {
          call += 1;
          return call === 1
            ? { ok: true, value: { messageId: 'msg-1' } }
            : { ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp timeout' } };
        },
      },
      { attempt: 1, maxAttempts: 3 },
    );

    await expect(runEmailForJob(theJob, h.deps)).rejects.toThrow(/transiently/);
    // The successful recipient is still recorded, so the retry skips it...
    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'sent', ref: 'msg-1' });
    // ...and the transient one is left open rather than terminally `failed`.
    expect(h.itemMarks.some((m) => m.itemId === 'b')).toBe(false);
  });

  it('records a transient send error terminally on the final attempt', async () => {
    const theJob = job({ items: [pendingItem('a')] });
    const h = jobHarness(
      theJob,
      {
        sendMail: async (): Promise<MailerResult<SendOk>> => ({
          ok: false,
          error: { code: 'TRANSPORT_FAILED', message: 'smtp timeout' },
        }),
      },
      { attempt: 3, maxAttempts: 3 },
    );

    await runEmailForJob(theJob, h.deps);
    // Out of retries: record the typed code so the caller sees a reason rather
    // than an item stuck `pending`.
    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'failed', err: 'TRANSPORT_FAILED' });
  });

  it('fails the items when the stored content has an unknown placeholder', async () => {
    // The API rejects these at submit; the worker re-asserts the same guarantee
    // against the persisted row rather than rendering a literal token.
    const theJob = job({ content: { subject: 'Hi {{city}}', body_markdown: 'b' } });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toEqual([
      { itemId: 'item-1', status: 'failed', err: 'invalid_email_content' },
    ]);
  });

  it('fails the items when the stored reply_to is not an email (canonical schema)', async () => {
    const theJob = job({
      content: { subject: 'S', body_markdown: 'b', reply_to: 'not-an-email' },
    });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);
    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toEqual([
      { itemId: 'item-1', status: 'failed', err: 'invalid_email_content' },
    ]);
  });

  it('marks an unowned id skipped_not_owned without emailing it', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('b')] });
    const h = jobHarness(theJob, {
      fetchDecryptedProfiles: async () => ok({ profiles: [profileRow('a')], skipped: ['b'] }),
    });
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
  });

  it('records a per-recipient send failure without aborting the batch (last attempt)', async () => {
    const theJob = job({ items: [pendingItem('a'), pendingItem('b')] });
    let call = 0;
    const h = jobHarness(theJob, {
      sendMail: async (): Promise<MailerResult<SendOk>> => {
        call += 1;
        return call === 1
          ? { ok: true, value: { messageId: 'msg-1' } }
          : { ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp refused' } };
      },
    });
    await runEmailForJob(theJob, h.deps);

    expect(h.itemMarks.filter((m) => m.status === 'sent')).toHaveLength(1);
    // No retry position injected ⇒ treated as the last attempt, so the failure
    // is recorded terminally — with the typed code only, never the provider's
    // message (which routinely quotes the address).
    expect(h.itemMarks).toContainEqual({ itemId: 'b', status: 'failed', err: 'TRANSPORT_FAILED' });
  });

  it('never re-emails an item already sent when the job is retried', async () => {
    // Attempt 2 of the same job: `a` was sent last time (terminal), `b` was not.
    const theJob = job({ items: [pendingItem('a', 'sent'), pendingItem('b')] });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(1);
    // The retry must not even ask Signals about the already-sent item.
    expect(h.queries[0]!.itemIds).toEqual(['b']);
    expect(h.itemMarks.map((m) => m.itemId)).toEqual(['b']);
  });

  it('emails nobody when every item is already terminal (full retry)', async () => {
    const theJob = job({ items: [pendingItem('a', 'sent')] });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toHaveLength(0);
    expect(h.queries).toHaveLength(0);
  });

  it('fails the job items (not the process) when the stored content is malformed', async () => {
    const theJob = job({ content: { subject: 'only a subject' } });
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);

    // Deterministic — a retry cannot fix it, so the items reach a terminal
    // status instead of the job being left `processing` for the watchdog.
    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toEqual([
      { itemId: 'item-1', status: 'failed', err: 'invalid_email_content' },
    ]);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws (so BullMQ retries) when the decrypt fails', async () => {
    const theJob = job();
    const h = jobHarness(theJob, {
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runEmailForJob(theJob, h.deps)).rejects.toThrow(/email decrypt failed/);
    expect(h.emails).toHaveLength(0);
  });

  it('throws when a contact projection returns no contact block (#521 guard)', async () => {
    const theJob = job();
    const h = jobHarness(theJob, {
      // A row with NO contact block at all — what an older Signals returns.
      // `profileRow`'s default would supply one, so build it explicitly.
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
    await expect(runEmailForJob(theJob, h.deps)).rejects.toThrow(/#521/);
    expect(h.emails).toHaveLength(0);
  });

  it('logs a skip and sends nothing when no item is owned', async () => {
    const theJob = job();
    const h = jobHarness(theJob, {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['item-1'] }),
    });
    await runEmailForJob(theJob, h.deps);

    expect(h.emails).toHaveLength(0);
    expect(JSON.stringify(h.logs.warn)).toContain('no_resolvable_items');
  });

  it('throws when the email collaborators are not wired', async () => {
    const theJob = job();
    const h = jobHarness(theJob);
    const deps: CampaignJobDeps = { ...h.deps };
    delete deps.email;
    await expect(runEmailForJob(theJob, deps)).rejects.toThrow(/not wired/);
  });

  it('never logs the recipient address or other contact PII', async () => {
    const theJob = job();
    const h = jobHarness(theJob);
    await runEmailForJob(theJob, h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('asha@example.com');
    expect(serialized).not.toContain('+910000000000');
    expect(serialized).not.toContain('Asha');
  });
});
