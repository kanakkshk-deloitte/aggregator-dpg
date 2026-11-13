/**
 * Campaign participant PII export.
 *
 *   POST /v1/campaign/export → 202 { job_id }
 *
 * Uses the shared submit flow in `../campaign/submit-job.ts`: creates a
 * `campaign_job` with one item per id and enqueues a `campaign-process` job.
 * The worker builds the CSV, uploads it to S3 and emails the link.
 *
 * Auth is a campaign-manager Bearer token; the aggregator must be active. The
 * recipient is the token's `email` claim, else the aggregator's contact email,
 * stored as `requested_by`; the request body cannot change it. The route
 * returns only `{ job_id }`. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';

/**
 * Registers the campaign-export route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/export',
    {
      config: { rbac: { capability: 'profiles.view_pii' } },
      schema: {
        tags: ['campaign'],
        summary: 'Request an async participant PII export',
        description:
          'Creates a durable campaign job that exports the participant contact fields (name/email/phone, each with profile/user provenance) for the given owned items to a private CSV, and emails a short-lived pre-signed download link to the requesting user. Body is the shared campaign envelope { item_ids, metadata[], content{} }. Send an Idempotency-Key header to make retries safe. Returns 202 { job_id }; poll GET /v1/campaign/export/{job_id} for status.',
        security: [{ bearerAuth: [] }],
        body: campaignEnvelopeSchema,
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'export',
        parseContent: (rawContent) => rawContent as Record<string, unknown>,
        // From deployment config (CAMPAIGN_EXPORT_FIELDS), not caller input.
        piiFields: () =>
          config.CAMPAIGN_EXPORT_FIELDS === 'full' ? ['full'] : ['name', 'email', 'phone'],
        buildItem: (itemId) => ({ itemId, action: null }),
        maxItems: config.CAMPAIGN_EXPORT_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_TOO_MANY_ITEMS',
        // Rate-limit bucket per channel.
        rateLimitNamespace: 'campaign-submit-export',
        submitWindowSeconds: config.CAMPAIGN_EXPORT_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_EXPORT_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG,
        attempts: config.CAMPAIGN_EXPORT_ATTEMPTS,
        enqueueFailedErrorCode: 'EXPORT_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue export',
        logOperation: 'campaignExport.enqueue',
        successMessage:
          'Export request submitted. A secure, time-limited download link will be emailed to your registered address once the export is ready.',
      });
    },
  );
}
