/**
 * Campaign job orchestrator in `@aggregator-dpg/worker`.
 *
 * Runs one `campaign_job`: skips jobs already terminal, marks the job
 * `processing`, runs the channel handler, and rolls the job status up from
 * item statuses.
 *
 * The export channel lives here (decrypt, CSV, private S3, email a signed
 * link). Voice and email live in `./voice.ts` and `./email.ts`.
 *
 * Transient failures re-throw so BullMQ retries; the job stays `processing`
 * until the last attempt, which marks it `failed`.
 * An item that is not found or not owned is an item outcome, not a job
 * failure. Never logs PII.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { CampaignAuditWriterBase, AuditOutcome } from '@aggregator-dpg/campaign-audit';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
  SignalStackDecryptedProfileRow,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { buildContactExportCsv, buildDecryptedProfilesCsv } from '@aggregator-dpg/profile-csv';
import type { SignedDownloadUrl } from '../../object-storage.js';
import { TERMINAL_JOB_STATUSES, toAuditCounts } from '../campaign-job-client.js';
import type {
  CampaignJobItemStatus,
  CampaignJobStatus,
  JobStatusCounts,
  MarkSubmittedArgs,
  ProcessingJob,
  RollUpResult,
} from '../campaign-job-client.js';
import { safeAudit } from '../campaign-audit.js';
import { runVoiceForJob, type VoiceCollaborators } from './voice.js';
import { runEmailForJob, type EmailCollaborators } from './email.js';

/** Minimal structured logger surface (satisfied by the worker's pino child). */
export interface CampaignLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** The subset of the job-client the orchestrator writes through. */
export interface CampaignJobClient {
  getJobForProcessing(jobId: string): Promise<ProcessingJob | null>;
  markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
    /** External id this item produced (email: the mailer's message id). */
    providerRef?: string,
  ): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  setJobStatus(jobId: string, status: CampaignJobStatus, errorReason?: string): Promise<void>;
  rollUpStatus(jobId: string): Promise<RollUpResult>;
  /** Marks the job's user-visible notification as sent; a retry must not re-send. */
  setNotifiedAt(jobId: string): Promise<void>;
  /** Fails items still `pending` on a job that has run out of retries. */
  failPendingItems(jobId: string, errorReason: string): Promise<void>;
  /** Voice: marks an item `submitted` and stores `providerBatchRef` (column `raya_batch_id`). */
  markSubmitted(jobId: string, itemId: string, args: MarkSubmittedArgs): Promise<void>;
  /** Voice: stores the raw provider response on the job. */
  setProviderResponse(jobId: string, response: unknown): Promise<void>;
  /**
   * Returns the job's item counts by status.
   *
   * Call after `failPendingItems` on failure paths, or pending items go uncounted.
   */
  countItems(jobId: string): Promise<JobStatusCounts>;
}

/** Export collaborators (decrypt, storage, mail). */
export interface ExportCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

export interface CampaignJobConfig {
  /** Items per decrypt chunk. */
  decryptChunk: number;
  /** `contact` = name/email/phone only; `full` = full item_state (variable columns). */
  fieldSet: 'contact' | 'full';
  /**
   * Who gets the export link: `requester` (the job's `requested_by`) or
   * `network_admin` (`networkAdminEmail`). Deployment-level, never caller-set.
   */
  recipientMode: 'requester' | 'network_admin';
  /** Recipient used when `recipientMode` is `network_admin`. */
  networkAdminEmail?: string;
  /** Recipients emailed in parallel within one email job (`EMAIL_SEND_CONCURRENCY`). */
  emailSendConcurrency: number;
}

export interface CampaignJobDeps {
  client: CampaignJobClient;
  export: ExportCollaborators;
  /** Voice-channel collaborators (decrypt + provider). Required only when `job.channel === 'voice'`. */
  voice?: VoiceCollaborators;
  /** Email-channel collaborators (decrypt + mailer). Required only when `job.channel === 'email'`. */
  email?: EmailCollaborators;
  config: CampaignJobConfig;
  log: CampaignLogger;
  /** Retry position, so the final attempt can record a terminal failure. */
  attempt?: { attempt: number; maxAttempts: number };
  /** Audit writer. Optional. */
  audit?: CampaignAuditWriterBase;
}

const TERMINAL_JOB = new Set<CampaignJobStatus>(TERMINAL_JOB_STATUSES);

/**
 * Returns the export download-link recipient: the network admin or the requester.
 *
 * Never a participant address. Used by the send path and the audit row.
 *
 * @param job - The job being processed (only `requestedBy` is read).
 * @param config - The job's recipient-mode config.
 * @returns The recipient, or `undefined` when `network_admin` has no address set.
 */
export function resolveExportRecipient(
  job: Pick<ProcessingJob, 'requestedBy'>,
  config: Pick<CampaignJobConfig, 'recipientMode' | 'networkAdminEmail'>,
): string | undefined {
  return config.recipientMode === 'network_admin' ? config.networkAdminEmail : job.requestedBy;
}

/**
 * Returns the fixed S3 key for a job's export CSV.
 *
 * Fixed per job so a retry overwrites the same object.
 *
 * @param orgId - The job's `signalstack_org_id`.
 * @param jobId - The `campaign_job.id`.
 * @returns The object key, e.g. `campaign-exports/org-1/job-1.csv`.
 */
export function exportObjectKey(orgId: string, jobId: string): string {
  return `campaign-exports/${orgId}/${jobId}.csv`;
}

/**
 * Truncates an error reason to 500 characters.
 */
export function truncateReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

/**
 * Runs one campaign job by id.
 *
 * @param jobId - The `campaign_job.id` to process (trusted — from the queue).
 * @param deps - Injected job-client, export collaborators, config, logger.
 */
export async function runCampaignJob(jobId: string, deps: CampaignJobDeps): Promise<void> {
  const job = await deps.client.getJobForProcessing(jobId);
  if (!job) {
    deps.log.warn({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'job_not_found',
      job_id: jobId,
    });
    return;
  }
  // Retry guard: a job that already reached a terminal status is not re-run.
  if (TERMINAL_JOB.has(job.status)) {
    deps.log.info({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'already_terminal',
      job_id: jobId,
      job_status: job.status,
    });
    return;
  }

  await deps.client.setJobStatus(jobId, 'processing');

  try {
    if (job.channel === 'export') {
      await runExportForJob(job, deps);
    } else if (job.channel === 'voice') {
      await runVoiceForJob(job, deps);
    } else if (job.channel === 'email') {
      await runEmailForJob(job, deps);
    } else {
      throw new Error(`campaign channel not implemented: ${job.channel}`);
    }
    const { status, counts } = await deps.client.rollUpStatus(jobId);

    // Write the `completed` audit row only if the roll-up is terminal.
    await recordSuccessPathAudit(job, deps, status, counts);

    deps.log.info({
      operation: 'campaign.process',
      status: 'success',
      job_id: jobId,
      channel: job.channel,
      job_status: status,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // An unknown retry position is treated as not final.
    const attempt = deps.attempt;
    const isFinalAttempt = attempt !== undefined && attempt.attempt >= attempt.maxAttempts;

    deps.log.error({
      operation: 'campaign.process',
      status: 'failure',
      job_id: jobId,
      channel: job.channel,
      attempt: attempt?.attempt,
      max_attempts: attempt?.maxAttempts,
      final_attempt: isFinalAttempt,
      error: reason,
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
    });

    // Before the last attempt, leave the job `processing` for the retry.
    // On the last attempt, fail it with the real reason.
    if (isFinalAttempt) {
      await finalizeFailedJob(job, deps, reason, err);
    }
    throw err;
  }
}

/**
 * Maps a rolled-up job status to the `completed` audit row's `outcome`.
 *
 * The roll-up can return `failed` without an error, so it is mapped explicitly.
 *
 * @param status - The job's rolled-up terminal status.
 * @returns The audit outcome to record on the `completed` row.
 */
function deriveAuditOutcome(status: CampaignJobStatus): AuditOutcome {
  if (status === 'partial') return 'partial';
  if (status === 'failed') return 'failed';
  return 'succeeded';
}

/**
 * Writes the `completed` audit row after a normal run.
 *
 * Logs a warning instead when the roll-up is not terminal. Never throws.
 *
 * @param job - The job just processed.
 * @param deps - The job's collaborators/config/logger/audit writer.
 * @param status - The job's rolled-up status, from `rollUpStatus`.
 * @param counts - The job's rolled-up item-status counts.
 */
async function recordSuccessPathAudit(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  status: CampaignJobStatus,
  counts: JobStatusCounts,
): Promise<void> {
  if (!TERMINAL_JOB.has(status)) {
    deps.log.warn({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'non_terminal_after_handler',
      job_id: job.id,
      channel: job.channel,
      job_status: status,
    });
    return;
  }

  await safeAudit(
    () =>
      deps.audit?.recordCompleted({
        correlationId: job.id,
        channel: job.channel,
        actorSignalstackOrgId: job.signalstackOrgId,
        outcome: deriveAuditOutcome(status),
        completedAt: new Date(),
        ...toAuditCounts(counts),
        ...exportAuditExtras(job, deps.config),
      }) ?? Promise.resolve(undefined),
    deps.log,
    { operation: 'campaignAudit.completed', job_id: job.id, channel: job.channel },
  );
}

/**
 * Fails a job that has used all its retries and writes its audit row.
 *
 * Order matters: fail pending items, mark the job failed, count items, then audit.
 *
 * @param job - The job being failed.
 * @param deps - The job's collaborators/config/logger/audit writer.
 * @param reason - The failure reason already extracted by the caller (untruncated).
 * @param err - The original thrown error, for the audit row's `errorCode`.
 */
async function finalizeFailedJob(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  reason: string,
  err: unknown,
): Promise<void> {
  await deps.client.failPendingItems(job.id, 'job_failed');
  await deps.client.setJobStatus(job.id, 'failed', truncateReason(reason));

  // Counted after `failPendingItems` so every item is in a final state.
  const counts = await deps.client.countItems(job.id);
  await safeAudit(
    () =>
      deps.audit?.recordCompleted({
        correlationId: job.id,
        channel: job.channel,
        actorSignalstackOrgId: job.signalstackOrgId,
        outcome: 'failed',
        completedAt: new Date(),
        errorCode: err instanceof Error ? err.constructor.name : 'unknown',
        ...toAuditCounts(counts),
        ...exportAuditExtras(job, deps.config),
      }) ?? Promise.resolve(undefined),
    deps.log,
    { operation: 'campaignAudit.completed', job_id: job.id, channel: job.channel },
  );
}

/**
 * Returns the export-only audit fields: recipient and S3 destination.
 *
 * Used by every terminal audit write, including the watchdog. Returns `{}`
 * for other channels.
 *
 * @param job - The job's channel, org id, id and requester.
 * @param config - The export recipient-mode config.
 * @returns `{ recipientRef, destination }` for `channel === 'export'`; `{}` otherwise.
 */
export function exportAuditExtras(
  job: Pick<ProcessingJob, 'channel' | 'signalstackOrgId' | 'id' | 'requestedBy'>,
  config: Pick<CampaignJobConfig, 'recipientMode' | 'networkAdminEmail'>,
): { recipientRef?: string; destination?: string } {
  if (job.channel !== 'export') return {};
  const recipientRef = resolveExportRecipient(job, config);
  return {
    ...(recipientRef !== undefined ? { recipientRef } : {}),
    destination: exportObjectKey(job.signalstackOrgId, job.id),
  };
}

/**
 * Decrypts the job's items in chunks, marks each item, and bumps the heartbeat per chunk.
 *
 * Throws on a decrypt failure or a missing contact block, so BullMQ retries.
 * Returns the resolved profile rows.
 */
async function decryptAndMarkItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  contactOnly: boolean,
): Promise<SignalStackDecryptedProfileRow[]> {
  const itemIds = job.items.map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(itemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // Contact mode asks for contact fields only, no item_state.
      ...(contactOnly ? { fields: [], contact: ['name', 'email', 'phone'] } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await deps.export.fetchDecryptedProfiles(query);
    if (!result.success) {
      // Throw so BullMQ retries. Items marked so far are kept.
      throw new Error(
        `campaign export decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    // A contact request with no contact block in the response would produce
    // an empty export, so fail instead.
    if (contactOnly && profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        'campaign export decrypt returned no contact block — Signals participant/decrypt predates #521',
      );
    }

    for (const p of profiles) {
      resolvedRows.push(p);
      await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      // The org does not own this item. Skips do not make the job `partial`.
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/** Runs the export channel: decrypt, mark items, build CSV, upload to S3, email the link. */
async function runExportForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const contactOnly = deps.config.fieldSet === 'contact';
  const resolvedRows = await decryptAndMarkItems(job, deps, contactOnly);

  const base = {
    operation: 'campaign.export',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: job.items.length,
  };

  if (resolvedRows.length === 0) {
    // Nothing to export: no upload and no email.
    deps.log.warn({ ...base, status: 'skipped', reason: 'no_resolvable_items', exported: 0 });
    return;
  }

  const csv = contactOnly
    ? buildContactExportCsv(resolvedRows)
    : buildDecryptedProfilesCsv(resolvedRows);
  // Fixed key per job, so a retry overwrites the same object.
  const key = exportObjectKey(job.signalstackOrgId, job.id);
  await deps.export.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.export.signDownloadUrl(key);

  const recipient = resolveExportRecipient(job, deps.config);
  if (!recipient) {
    throw new Error(
      `campaign export has no recipient for mode "${deps.config.recipientMode}" ` +
        '(set EXPORT_NETWORK_ADMIN_EMAIL, or use CAMPAIGN_EXPORT_RECIPIENT=requester)',
    );
  }

  const email = renderExportEmail({
    orgId: job.signalstackOrgId,
    purpose: purposeOf(job) ?? '—',
    exported: resolvedRows.length,
    skipped: job.items.length - resolvedRows.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });
  // Do not send a second link on retry.
  if (job.notifiedAt) {
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'already_notified',
      exported: resolvedRows.length,
    });
    return;
  }

  const sent = await deps.export.sendMail({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    // Throw so BullMQ retries the job; decrypt and upload run again against the
    // same S3 key.
    throw new Error(`campaign export email failed: ${sent.error.code}: ${sent.error.message}`);
  }

  // Stamp before returning so a retry after this point cannot re-send.
  await deps.client.setNotifiedAt(job.id);

  deps.log.info({ ...base, status: 'success', exported: resolvedRows.length, s3_key: key });
}

/** Reads the `purpose` metadata pair off a job, if present. */
function purposeOf(job: ProcessingJob): string | undefined {
  const p = job.metadata.find((m) => m.key === 'purpose')?.value;
  return p?.trim() ? p : undefined;
}

/**
 * Splits an array into chunks of `size`; the last chunk may be shorter.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Formats an ISO-8601 timestamp as `13 Aug 2026, 06:13 UTC`.
 *
 * Returns the input unchanged if it cannot be parsed.
 */
function formatExpiry(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(when);
  return `${formatted} UTC`;
}

/** Renders the export-ready email. It holds the link only, never PII. */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.exported} records`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download it before ${formatExpiry(i.expiresAt)}:`,
    i.url,
    '',
    'After that the link stops working and the file is permanently deleted from storage — so download it now. The file contains personal data; do not forward this link.',
  ].join('\n');
  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    '<p>A participant PII export is ready.</p>',
    '<ul>',
    `<li>Requested by org: <strong>${esc(i.orgId)}</strong></li>`,
    `<li>Purpose: ${esc(i.purpose)}</li>`,
    `<li>Records exported: <strong>${i.exported}</strong></li>`,
    `<li>Skipped (not found / not owned): <strong>${i.skipped}</strong></li>`,
    '</ul>',
    `<p><a href="${esc(i.url)}">Download the export</a> before <strong>${formatExpiry(i.expiresAt)}</strong>.</p>`,
    '<p style="color:#a00">After that the link stops working and the file is <strong>permanently deleted</strong> from storage — so download it now. The file contains personal data; do not forward this link.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}
