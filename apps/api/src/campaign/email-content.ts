/**
 * Validates email campaign content in the api app.
 *
 * The schema is shared with the worker. This module adds the placeholder
 * check, which fails the request before a job row exists.
 *
 * @module @aggregator-dpg/api
 */
import { unknownPlaceholders } from '@aggregator-dpg/campaign-template';
import { emailContentSchema, type EmailContent } from '@aggregator-dpg/campaign-template/content';
import { httpError } from '../errors/http-error.js';

export { emailContentSchema, type EmailContent };

/**
 * Validates the envelope's raw `content` as an email message.
 *
 * @param rawContent - The envelope's `content` value, unvalidated.
 * @returns The parsed content, ready to persist on the job row.
 * @throws `SCHEMA_VALIDATION` when the block is malformed.
 * @throws `UNKNOWN_PLACEHOLDER` when the subject or body uses an unsupported `{{token}}`.
 */
export function parseEmailContent(rawContent: unknown): EmailContent {
  const parsed = emailContentSchema.safeParse(rawContent);
  if (!parsed.success) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'content failed email schema validation',
      fields: { issues: parsed.error.issues },
    });
  }

  const unknown = unknownPlaceholders(parsed.data.subject, parsed.data.body_markdown);
  if (unknown.length > 0) {
    throw httpError('UNKNOWN_PLACEHOLDER', { fields: { unknown } });
  }
  return parsed.data;
}
