/**
 * Route schema shared by the api app's campaign submit endpoints.
 *
 * `POST /v1/campaign/{export,email,voice}` share one `202` body and one error set.
 * Path, summary, description and `content` shape stay in each route.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';
import { errorResponses } from '../errors/openapi.js';

/**
 * The `202` body every campaign submit endpoint returns. `job_id` is the handle
 * for that channel's poll endpoints; `requested` is the de-duplicated item
 * count, not a promise that every one was acted on.
 */
export const campaignSubmitAcceptedSchema = z.object({
  status: z.literal('queued'),
  requested: z.number().int(),
  job_id: z.string().uuid(),
  message: z.string(),
});

/**
 * The response map shared by the campaign submit endpoints: the `202` above plus the shared errors.
 *
 * @returns A Fastify `schema.response` map, spreadable into a route schema.
 */
export function campaignSubmitResponses() {
  return {
    202: campaignSubmitAcceptedSchema,
    ...errorResponses(400, 401, 403, 429, 503),
  };
}
