/**
 * OpenAPI helpers for the api app's error envelope. Routes spread
 * `errorResponses(...)` into `schema.response` to document their error statuses.
 */

import { z } from 'zod';
import type { ErrorEnvelope } from './serialize.js';

/**
 * Zod mirror of {@link import('./serialize.js').ErrorEnvelope}. Passthrough
 * on every object so the serializer can never strip envelope fields.
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        title: z.string(),
        detail: z.string(),
        docs: z.string().optional(),
        fields: z.record(z.unknown()).optional(),
        requestId: z.string(),
        timestamp: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Fails to typecheck if the schema stops matching {@link ErrorEnvelope}.
 *
 * Property types are widened with `| undefined` because zod infers optionals that way.
 */
type _Expect<T extends true> = T;
type _WidenOptional<T> = { [K in keyof T]: T[K] | undefined };
type _ErrorEnvelopeSchemaMatchesType = _Expect<
  z.infer<typeof ErrorEnvelopeSchema> extends { error: _WidenOptional<ErrorEnvelope['error']> }
    ? true
    : false
>;

/**
 * Builds a `{ <status>: ErrorEnvelopeSchema }` map for the given HTTP
 * statuses, deduplicating repeats, for spreading into a route's
 * `schema.response`.
 *
 * @param statuses - HTTP status codes the route can return as errors.
 * @returns Map of status code to the canonical error envelope schema.
 */
export function errorResponses(...statuses: number[]): Record<number, typeof ErrorEnvelopeSchema> {
  const map: Record<number, typeof ErrorEnvelopeSchema> = {};
  for (const status of statuses) {
    map[status] = ErrorEnvelopeSchema;
  }
  return map;
}
