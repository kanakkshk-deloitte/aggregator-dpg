/**
 * Async-job submission flow shared by the api app's campaign channels.
 *
 * Steps: auth, active-aggregator check, content parsing, item dedup and cap,
 * rate limit, per-org active-job cap, create job, enqueue (marking the job
 * `failed` if that fails), best-effort `requested` audit row, `202`.
 * Each route passes its channel settings via {@link SubmitCampaignJobOptions}.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { getUserStore } from '../services/user-store/index.js';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import type {
  CampaignChannel,
  CreateJobItemInput,
  JobRecord,
} from '../services/campaign-job-store/index.js';
import { enqueueCampaignProcess } from '../services/campaign-process-queue/index.js';
import { dedupeItemIds, metadataValue } from './envelope.js';
import type { campaignEnvelopeSchema } from './envelope.js';
import { requireCampaignAuth, requireOrgId } from './auth.js';
import { consume } from '../services/rate-limiter/index.js';
import { httpError } from '../errors/http-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { getCampaignAuditWriter, safeAudit } from '../services/campaign-audit/index.js';

/** Channel-specific knobs consumed by {@link submitCampaignJob}. */
export interface SubmitCampaignJobOptions {
  /** The campaign channel this submission belongs to. */
  channel: CampaignChannel;
  /** Validates the raw `content` for the job; throw an `httpError` to fail before any row is created. */
  parseContent: (rawContent: unknown) => Record<string, unknown>;
  /** Builds one job item's `action` column from a deduped item id. */
  buildItem: (itemId: string) => CreateJobItemInput;
  /** Per-request item cap (`CAMPAIGN_<CHANNEL>_MAX_ITEMS`). */
  maxItems: number;
  /** Error code thrown when `maxItems` is exceeded. */
  maxItemsErrorCode: ErrorCode;
  /** Rate-limiter bucket namespace, one per channel. */
  rateLimitNamespace: string;
  /** Rate-limiter window, in seconds. */
  submitWindowSeconds: number;
  /** Rate-limiter max requests per window. */
  submitMax: number;
  /** Per-org active-job cap (`CAMPAIGN_<CHANNEL>_MAX_ACTIVE_PER_ORG`). */
  maxActivePerOrg: number;
  /** BullMQ `attempts` passed to `enqueueCampaignProcess`. */
  attempts: number;
  /** Error code thrown when the post-commit enqueue fails. */
  enqueueFailedErrorCode: ErrorCode;
  /** Fallback detail text when the enqueue rejection isn't an `Error`. */
  enqueueFailedFallbackMessage: string;
  /** `operation` log field used when marking an un-enqueued job failed also fails. */
  logOperation: string;
  /** `message` field of the `202` response body. */
  successMessage: string;
  /** PII field names this channel releases, for the audit `requested` row. Names only, never values. */
  piiFields: (content: Record<string, unknown>) => string[];
}

/**
 * Runs the campaign-job submission flow for one channel and sends the `202`.
 *
 * @param req - The Fastify request; `req.body` is already validated against `campaignEnvelopeSchema`.
 * @param reply - The Fastify reply; this function sends the response.
 * @param opts - Channel-specific config, see {@link SubmitCampaignJobOptions}.
 */
export async function submitCampaignJob(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SubmitCampaignJobOptions,
): Promise<void> {
  const auth = await requireCampaignAuth(req);
  const orgId = requireOrgId(auth);
  const requestedBy = await resolveRequestedBy(auth.aggregatorId, auth.email);

  const envelope = req.body as z.infer<typeof campaignEnvelopeSchema>;
  const content = opts.parseContent(envelope.content);

  const itemIds = dedupeItemIds(envelope.item_ids);
  if (itemIds.length > opts.maxItems) {
    throw httpError(opts.maxItemsErrorCode, {
      fields: { max: opts.maxItems, received: itemIds.length },
    });
  }

  // Per-org rate limit. Fails open on a Redis error.
  const rl = await consume({
    namespace: opts.rateLimitNamespace,
    key: orgId,
    windowSeconds: opts.submitWindowSeconds,
    max: opts.submitMax,
  });
  if (!rl.allowed) {
    reply.header('retry-after', String(rl.retryAfterSeconds));
    throw httpError('CAMPAIGN_RATE_LIMITED', { fields: { retry_after: rl.retryAfterSeconds } });
  }

  const store = getCampaignJobStore();

  const active = await store.countActiveJobs(orgId, opts.channel);
  if (!active.ok) throw httpError('INTERNAL', { detail: 'could not read active job count' });
  if (active.value >= opts.maxActivePerOrg) {
    throw httpError('CAMPAIGN_ACTIVE_LIMIT', { fields: { max: opts.maxActivePerOrg } });
  }

  const idempotencyKey = readIdempotencyKey(req);
  const created = await store.createJob({
    aggregatorId: auth.aggregatorId,
    signalstackOrgId: orgId,
    channel: opts.channel,
    metadata: envelope.metadata,
    content,
    requestedBy,
    requestId: req.id,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    items: itemIds.map(opts.buildItem),
  });
  if (!created.ok) throw httpError('INTERNAL', { detail: 'could not create campaign job' });

  await enqueueWithCompensation(created.value.job, created.value.created, opts, req, store);

  // Best-effort audit; the job is already committed and enqueued.
  // Written only on first creation, not on an idempotency replay, so nothing is counted twice.
  if (created.value.created) {
    const purpose = metadataValue(envelope.metadata, 'purpose');
    // Caller-supplied header; capped to keep the audit row small.
    const traceId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 200);
    await safeAudit(
      () =>
        getCampaignAuditWriter().recordRequested({
          correlationId: created.value.job.id,
          channel: opts.channel,
          actorUserId: auth.userId,
          actorSignalstackOrgId: orgId,
          ...(auth.azp ? { actorAzp: auth.azp } : {}),
          piiFields: opts.piiFields(content),
          itemCount: itemIds.length,
          requestedAt: new Date(),
          ...(purpose ? { purpose } : {}),
          endpoint: `POST /v1/campaign/${opts.channel}`,
          requestIp: req.ip,
          ...(traceId ? { traceId } : {}),
        }),
      {
        operation: 'campaignAudit.requested',
        correlation_id: created.value.job.id,
        channel: opts.channel,
      },
    );
  }

  await reply.code(202).send({
    status: 'queued' as const,
    requested: itemIds.length,
    job_id: created.value.job.id,
    message: opts.successMessage,
  });
}

/**
 * Checks the aggregator is active and resolves the `requested_by` email (token email, else `contact_email`).
 *
 * @param aggregatorId - The requesting aggregator's id (from the auth token).
 * @param tokenEmail - The token's own `email` claim, if present.
 * @returns The resolved requester email.
 * @throws `FORBIDDEN` if the aggregator is not active or no email resolves.
 */
async function resolveRequestedBy(
  aggregatorId: string,
  tokenEmail: string | undefined,
): Promise<string> {
  const found = await getUserStore().findById(aggregatorId);
  if (!found.ok || found.value?.status !== 'active') {
    throw httpError('FORBIDDEN', {
      detail: 'requesting aggregator is not active',
      fields: { reason: 'AGGREGATOR_INACTIVE' },
    });
  }

  // The `requested_by` column is NOT NULL, so one of these must resolve.
  const requestedBy = tokenEmail ?? found.value.contactEmail;
  if (!requestedBy) {
    throw httpError('FORBIDDEN', {
      detail:
        'no requester identity — the token has no email claim and the aggregator has no contact_email',
      fields: { reason: 'RECIPIENT_UNRESOLVED' },
    });
  }
  return requestedBy;
}

/**
 * Enqueues the created or replayed campaign job, marking it `failed` if the enqueue fails.
 *
 * @param job - The created or replayed job row.
 * @param wasCreated - Whether this call created the row (false for an idempotency replay).
 * @param opts - Channel-specific settings.
 * @param req - The Fastify request, used for logging.
 * @param store - The campaign job store.
 * @throws The channel's `enqueueFailedErrorCode` if the enqueue fails.
 */
async function enqueueWithCompensation(
  job: JobRecord,
  wasCreated: boolean,
  opts: SubmitCampaignJobOptions,
  req: FastifyRequest,
  store: ReturnType<typeof getCampaignJobStore>,
): Promise<void> {
  // Also re-enqueue a replay that is still `queued`: its first enqueue may have failed.
  // BullMQ de-duplicates on jobId, so an extra add does nothing.
  const needsEnqueue = wasCreated || job.status === 'queued';
  if (!needsEnqueue) return;

  try {
    await enqueueCampaignProcess({ jobId: job.id }, { attempts: opts.attempts });
  } catch (cause) {
    // A `queued` job counts against the org's active cap and the watchdog never
    // reaps it, so mark it failed to free the slot.
    const reason = cause instanceof Error ? cause.message : opts.enqueueFailedFallbackMessage;
    const marked = await store.setJobStatus(job.id, 'failed', 'enqueue_failed');
    if (!marked.ok) {
      req.log.error({
        operation: opts.logOperation,
        status: 'failure',
        job_id: job.id,
        error: 'could not mark the un-enqueued job failed',
      });
    }
    throw httpError(opts.enqueueFailedErrorCode, { detail: reason });
  }
}

/** Reads the `Idempotency-Key` request header (Fastify lowercases header names). */
function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}
