/**
 * Campaign email channel in `@aggregator-dpg/worker`.
 *
 * Runs one `email` job: decrypt the open recipients (only the contact fields
 * the template uses), render the Markdown, send with bounded concurrency, and
 * write each recipient's status. `index.ts` owns the job lifecycle.
 *
 * Delivery is at-least-once per recipient. A retry skips items already `sent`,
 * but a crash between the send and the `sent` write means that recipient is
 * emailed again. SMTP and SES have no idempotency key to prevent this.
 * Unlike export, there is no job-level `notified_at` guard: a partly sent job
 * resumes per recipient.
 *
 * Decrypted items are not marked `resolved`; `sent` is the only success status.
 * Never logs PII.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
  SignalStackDecryptedProfileRow,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import {
  placeholderValues,
  requiredContactFields,
  unknownPlaceholders,
  type ContactField,
} from '@aggregator-dpg/campaign-template';
import { emailContentSchema, type EmailContent } from '@aggregator-dpg/campaign-template/content';
import { renderEmail } from '@aggregator-dpg/campaign-template/render';
import { TERMINAL_ITEM_STATUSES, type ProcessingJob } from '../campaign-job-client.js';
import { chunkArray, type CampaignJobDeps } from './index.js';

/** Email-channel collaborators (decrypt + mailer). */
export interface EmailCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

/** The message the caller submitted (the job row's `content` block). */
export interface EmailTemplate {
  subject: string;
  bodyMarkdown: string;
  replyTo?: string;
}

/**
 * Runs the email channel for one job.
 *
 * @param job - The job to process (`job.channel === 'email'`).
 * @param deps - Injected job-client, email collaborators, config, logger.
 * @throws {Error} If `deps.email` is not set, or decrypt or sending fails transiently.
 *   Invalid stored `content` fails the items instead of throwing.
 */
export async function runEmailForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const email = deps.email;
  if (!email) throw new Error('campaign email collaborators not wired');

  const base = {
    operation: 'campaign.email',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: job.items.length,
  };
  const start = Date.now();

  const content = await resolveStoredContent(job, deps, base);
  if (!content) return;

  const open = job.items.filter((i) => !TERMINAL_ITEM_STATUSES.includes(i.status));
  if (open.length === 0) {
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'all_items_terminal',
      latency_ms: Date.now() - start,
    });
    return;
  }

  const rows = await decryptEmailItems(
    job,
    deps,
    email,
    content,
    open.map((i) => i.itemId),
  );
  if (rows.length === 0) {
    // Nothing to email.
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      sent: 0,
    });
    return;
  }

  const summary = await sendCampaignEmails(
    rows,
    {
      subject: content.subject,
      bodyMarkdown: content.body_markdown,
      ...(content.reply_to ? { replyTo: content.reply_to } : {}),
    },
    {
      sendMail: email.sendMail,
      concurrency: deps.config.emailSendConcurrency,
      markRecipient: (itemId, status, detail) =>
        deps.client.markItem(job.id, itemId, status, detail?.reason, detail?.providerRef),
      // Keeps a long batch from being marked `stalled` by the watchdog.
      heartbeat: () => deps.client.heartbeat(job.id),
      log: deps.log,
    },
  );
  await deps.client.heartbeat(job.id);

  // Transient send errors throw while attempts remain, so the retry resends
  // to open items only.
  await settleTransientFailures(job, deps, base, summary, start);

  const failed = summary.failed + summary.transient.length;
  deps.log.info({
    ...base,
    status: failed > 0 ? 'partial' : 'success',
    latency_ms: Date.now() - start,
    sent: summary.sent,
    skipped_no_contact: summary.skippedNoContact,
    failed,
  });
}

/**
 * Re-validates the `content` block persisted on the job row.
 *
 * Applies the same schema and placeholder checks as the API. A failure will
 * not change on retry, so every open item is marked `failed`.
 *
 * @param job - The job being processed.
 * @param deps - Injected client + logger.
 * @param base - Shared log fields for this job.
 * @returns The validated content, or `null` when invalid (items already failed).
 */
async function resolveStoredContent(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  base: Record<string, unknown>,
): Promise<EmailContent | null> {
  const parsed = emailContentSchema.safeParse(job.content);
  const unknownTokens = parsed.success
    ? unknownPlaceholders(parsed.data.subject, parsed.data.body_markdown)
    : [];
  if (parsed.success && unknownTokens.length === 0) return parsed.data;

  deps.log.error({
    ...base,
    status: 'failure',
    step: 'content',
    reason: 'invalid_email_content',
    error: parsed.success
      ? `unknown_placeholders:${unknownTokens.join(',')}`
      : parsed.error.issues.map((i) => i.path.join('.')).join(','),
  });
  for (const item of job.items) {
    if (!TERMINAL_ITEM_STATUSES.includes(item.status)) {
      await deps.client.markItem(job.id, item.itemId, 'failed', 'invalid_email_content');
    }
  }
  return null;
}

/**
 * Decides what a transient send failure means for this attempt.
 *
 * While attempts remain it throws, so BullMQ retries the open recipients.
 * On the last attempt it marks them `failed`.
 *
 * An unknown retry position counts as the last attempt, so no item is left
 * `pending` without a reason.
 *
 * @param job - The job being processed.
 * @param deps - Injected client, logger and retry position.
 * @param base - Shared log fields for this job.
 * @param summary - The send loop's outcome tally.
 * @param start - Job start timestamp, for the latency field.
 * @throws {Error} When transient failures remain and attempts are left.
 */
async function settleTransientFailures(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  base: Record<string, unknown>,
  summary: EmailSendSummary,
  start: number,
): Promise<void> {
  if (summary.transient.length === 0) return;

  const attempt = deps.attempt;
  const isFinalAttempt = attempt === undefined || attempt.attempt >= attempt.maxAttempts;
  if (!isFinalAttempt) {
    deps.log.warn({
      ...base,
      status: 'failure',
      reason: 'transient_send_errors',
      latency_ms: Date.now() - start,
      sent: summary.sent,
      transient: summary.transient.length,
      attempt: attempt?.attempt,
      max_attempts: attempt?.maxAttempts,
    });
    throw new Error(
      `campaign email: ${summary.transient.length} recipient(s) failed transiently, retrying the job`,
    );
  }

  // Out of attempts: mark them failed with the error code.
  for (const t of summary.transient) {
    await deps.client.markItem(job.id, t.itemId, 'failed', t.code);
  }
}

/**
 * Decrypts the job's open items in chunks and bumps the heartbeat per chunk.
 *
 * Unowned ids are marked `skipped_not_owned`. Only `email` plus the contact
 * fields the template uses are requested.
 *
 * @param job - The job being processed.
 * @param deps - Injected collaborators (client, config, logger).
 * @param email - The email collaborators (already null-checked by the caller).
 * @param content - The validated message, whose placeholders drive the projection.
 * @param openItemIds - The job's still-open item ids, decided by the caller.
 * @returns The resolved profile rows (owned items only).
 * @throws {Error} On a decrypt failure, or when the response has no contact block.
 */
async function decryptEmailItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  email: EmailCollaborators,
  content: EmailContent,
  openItemIds: string[],
): Promise<SignalStackDecryptedProfileRow[]> {
  const contact: ContactField[] = [
    ...new Set<ContactField>([
      'email',
      ...requiredContactFields(content.subject, content.body_markdown),
    ]),
  ];
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(openItemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // Contact fields only, no item_state.
      fields: [],
      contact,
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await email.fetchDecryptedProfiles(query);
    if (!result.success) {
      throw new Error(
        `campaign email decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    if (profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        'campaign email decrypt returned no contact block — Signals participant/decrypt predates #521',
      );
    }

    // No `resolved` mark: `sent` is this channel's only success write.
    resolvedRows.push(...profiles);
    for (const missing of skipped) {
      // The org does not own this item. Skips do not make the job `partial`.
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }

    // Fail any id missing from both lists, so it does not stay `pending`.
    const accounted = new Set([...profiles.map((p) => p.item_id), ...skipped]);
    for (const id of chunk) {
      if (!accounted.has(id)) {
        await deps.client.markItem(job.id, id, 'failed', 'decrypt_missing');
      }
    }

    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/** Per-recipient outcome the caller persists as the item's terminal status. */
export type EmailRecipientStatus = 'sent' | 'skipped_no_contact' | 'failed';

/**
 * Mailer error codes that will not succeed on retry. All others are transient.
 */
const PERMANENT_SEND_ERRORS: ReadonlySet<string> = new Set(['INVALID_RECIPIENT']);

/** How many recipients to send between watchdog heartbeats inside the loop. */
const HEARTBEAT_EVERY = 25;

/** Collaborators for the send loop. */
export interface EmailSendDeps {
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** How many recipients to send in parallel (`EMAIL_SEND_CONCURRENCY`). */
  concurrency: number;
  /** Beats the job's watchdog heartbeat periodically during a long batch. */
  heartbeat?: () => Promise<void>;
  /**
   * Records one recipient's terminal outcome. `providerRef` is the mailer's
   * message id, present only on `sent`.
   */
  markRecipient: (
    itemId: string,
    status: EmailRecipientStatus,
    detail?: { reason?: string; providerRef?: string },
  ) => Promise<void>;
  log: { info(obj: object): void };
}

/** Tally of the loop's outcomes, for the caller's summary log. */
export interface EmailSendSummary {
  sent: number;
  skippedNoContact: number;
  /** Recipients that failed permanently. */
  failed: number;
  /**
   * Recipients whose send failed transiently. Not written here; the caller
   * decides whether to retry or mark them `failed`.
   */
  transient: Array<{ itemId: string; code: string }>;
}

/**
 * Renders and sends the campaign message to every supplied recipient row.
 *
 * One recipient's failure does not stop the batch.
 *
 * @param rows - Decrypted profile rows to email (already ownership-scoped).
 * @param template - Subject / Markdown body / optional Reply-To.
 * @param deps - Mailer, send concurrency, per-recipient reporter, logger.
 * @returns The outcome tally across all recipients.
 */
export async function sendCampaignEmails(
  rows: readonly SignalStackDecryptedProfileRow[],
  template: EmailTemplate,
  deps: EmailSendDeps,
): Promise<EmailSendSummary> {
  const summary: EmailSendSummary = { sent: 0, skippedNoContact: 0, failed: 0, transient: [] };
  let done = 0;

  await mapWithConcurrency([...rows], deps.concurrency, async (profile) => {
    const email = profile.contact?.email?.value ?? '';
    let status: EmailRecipientStatus;

    if (!email) {
      // No email address on file.
      summary.skippedNoContact += 1;
      status = 'skipped_no_contact';
      await deps.markRecipient(profile.item_id, status, { reason: 'no_email_address' });
    } else {
      const values = placeholderValues({
        name: profile.contact?.name?.value ?? null,
        email: profile.contact?.email?.value ?? null,
        phone: profile.contact?.phone?.value ?? null,
      });
      let rendered;
      try {
        rendered = renderEmail({
          subject: template.subject,
          bodyMarkdown: template.bodyMarkdown,
          values,
        });
      } catch {
        // A retry would fail the same way, so mark it failed. The error text
        // is not stored because it can quote the template.
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, { reason: 'render_failed' });
        deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });
        return;
      }

      const res = await deps.sendMail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(template.replyTo ? { replyTo: template.replyTo } : {}),
      });
      if (res.ok) {
        summary.sent += 1;
        status = 'sent';
        await deps.markRecipient(profile.item_id, status, { providerRef: res.value.messageId });
      } else if (PERMANENT_SEND_ERRORS.has(res.error.code)) {
        // Store only the code. The provider message can contain the address,
        // and this reason is returned by the poll API.
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, { reason: res.error.code });
      } else {
        // Transient: leave the item open for the caller to decide.
        summary.transient.push({ itemId: profile.item_id, code: res.error.code });
        status = 'failed';
      }
    }

    // Log item_id and status only, never the address.
    deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });

    done += 1;
    if (deps.heartbeat && done % HEARTBEAT_EVERY === 0) await deps.heartbeat();
  });

  return summary;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  });
  await Promise.all(runners);
}
