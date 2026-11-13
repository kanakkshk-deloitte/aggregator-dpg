/**
 * Campaign voice-call dispatch.
 *
 *   POST /v1/campaign/voice → 202 { status, requested, job_id }
 *
 * Uses the shared submit flow in `../campaign/submit-job.ts`: creates a
 * `campaign_job` with one `voice_call` item per id and enqueues a
 * `campaign-process` job. An id already in another live voice job is marked
 * `duplicate_active`. The worker dispatches the calls to Raya.
 *
 * `content` is validated against `voiceContentSchema`. `action` must be `dispatch`.
 *
 * Auth is a campaign-manager Bearer token; the aggregator must be active.
 * `requested_by` (token `email`, else the aggregator's contact email) is kept
 * for the audit trail. The route never returns PII. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { voiceContentSchema } from '../campaign/voice-content.js';
import { auditFieldNameEntries } from '../campaign/audit-field-names.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';

/**
 * Registers the campaign-voice route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/voice',
    {
      config: { rbac: { capability: 'campaigns.run' } },
      schema: {
        tags: ['campaign'],
        summary: 'Request an async voice-call campaign dispatch',
        description:
          'Creates a durable campaign job that dispatches a Raya voice-call batch to the given owned items. Body is the shared campaign envelope { item_ids, metadata[], content{} } where content is the voice dispatch request (agent_id required; action is dispatch-only in v1). Send an Idempotency-Key header to make retries safe. Returns 202 { status, requested, job_id }; poll GET /v1/campaign/voice/{job_id} for status.',
        security: [{ bearerAuth: [] }],
        body: campaignEnvelopeSchema,
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'voice',
        parseContent: (rawContent) => {
          const contentParsed = voiceContentSchema.safeParse(rawContent);
          if (!contentParsed.success) {
            throw httpError('SCHEMA_VALIDATION', {
              detail: 'content failed voice dispatch schema validation',
              fields: { issues: contentParsed.error.issues },
            });
          }
          return contentParsed.data;
        },
        // `variables` is caller free text. Only identifier-shaped names are
        // audited; anything else is recorded as a redaction count, never a value.
        piiFields: (content) => [
          'name',
          'phone',
          ...auditFieldNameEntries((content.variables as string[] | undefined) ?? []),
        ],
        buildItem: (itemId) => ({ itemId, action: 'voice_call' }),
        maxItems: config.CAMPAIGN_VOICE_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_VOICE_TOO_MANY_ITEMS',
        // Rate-limit bucket per channel.
        rateLimitNamespace: 'campaign-submit-voice',
        submitWindowSeconds: config.CAMPAIGN_VOICE_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_VOICE_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG,
        attempts: config.CAMPAIGN_VOICE_ATTEMPTS,
        enqueueFailedErrorCode: 'VOICE_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue voice job',
        logOperation: 'campaignVoice.enqueue',
        successMessage:
          'Voice campaign request submitted. Poll the job status endpoint for progress.',
      });
    },
  );
}
