/**
 * The email channel's message contract.
 *
 * The API validates the inbound `content` block against this schema before a
 * job row exists. The worker re-validates the stored row against the same
 * schema before rendering. It lives in a package because apps cannot import
 * from each other.
 *
 * Belongs to `@aggregator-dpg/campaign-template`.
 */
import { z } from 'zod';

/** Max characters allowed in the subject line. */
export const SUBJECT_MAX = 200;

/** Max characters allowed in the Markdown body. */
export const BODY_MAX = 20000;

/**
 * The email channel's `content` block.
 *
 * `reply_to` is the only header the caller can set. `From` is always the
 * configured sender. Unknown keys are rejected.
 */
export const emailContentSchema = z
  .object({
    subject: z.string().trim().min(1).max(SUBJECT_MAX),
    body_markdown: z.string().min(1).max(BODY_MAX),
    reply_to: z.string().email().optional(),
  })
  .strict();

/** Inferred type from {@link emailContentSchema}. */
export type EmailContent = z.infer<typeof emailContentSchema>;
