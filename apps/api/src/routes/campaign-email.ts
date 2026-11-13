/**
 * Campaign participant email.
 *
 *   POST /v1/campaign/email → 202 { status, requested, job_id }
 *
 * Uses the shared submit flow in `../campaign/submit-job.ts`: creates a
 * `campaign_job` with one item per recipient and enqueues a `campaign-process`
 * job. The worker decrypts, renders and sends, writing item status back for
 * `GET /v1/campaign/email/{job_id}`. Email items have no active-job dedup.
 *
 * `content` (subject, Markdown body, optional `reply_to`) is validated against
 * `emailContentSchema`; an unknown `{{placeholder}}` answers 400.
 *
 * Auth is a campaign-manager Bearer token; its `signalstack_org_id` claim
 * scopes the decrypt, and unowned ids are skipped. The route never returns
 * PII. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { requiredContactFields } from '@aggregator-dpg/campaign-template';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { parseEmailContent } from '../campaign/email-content.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';

/**
 * Registers the campaign-email route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignEmailRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/email',
    {
      config: { rbac: { capability: 'campaigns.run' } },
      schema: {
        tags: ['campaign'],
        summary: 'Email owned participants (async)',
        description:
          'Creates a durable campaign job that emails the given owned participants a shared message (subject + Markdown body, with an optional fixed set of {{placeholder}} tokens personalised per recipient). Body is the shared campaign envelope { item_ids, metadata[], content{subject, body_markdown, reply_to?} }. Recipient email addresses are resolved server-side and never returned. Send an Idempotency-Key header to make retries safe. Returns 202 { job_id }; poll GET /v1/campaign/email/{job_id} for per-recipient outcomes.',
        security: [{ bearerAuth: [] }],
        body: campaignEnvelopeSchema,
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'email',
        parseContent: parseEmailContent,
        // Every send releases `email`; placeholders may add `name` and `phone`.
        // Keep in sync with `decryptEmailItems` in the worker.
        piiFields: (content) => [
          ...new Set([
            'email',
            ...requiredContactFields(content.subject as string, content.body_markdown as string),
          ]),
        ],
        // `action: null`: no active-job dedup for email.
        buildItem: (itemId) => ({ itemId, action: null }),
        maxItems: config.CAMPAIGN_EMAIL_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_TOO_MANY_ITEMS',
        // Rate-limit bucket per channel.
        rateLimitNamespace: 'campaign-submit-email',
        submitWindowSeconds: config.CAMPAIGN_EMAIL_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_EMAIL_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG,
        // Safe to retry: the worker skips items already marked `sent`.
        attempts: config.CAMPAIGN_EMAIL_ATTEMPTS,
        enqueueFailedErrorCode: 'EMAIL_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue email',
        logOperation: 'campaignEmail.enqueue',
        successMessage:
          'Your campaign email has been queued. Poll GET /v1/campaign/email/{job_id} for per-recipient outcomes.',
      });
    },
  );
}
