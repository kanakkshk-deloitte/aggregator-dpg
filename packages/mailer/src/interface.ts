/**
 * Mailer contract (`@aggregator-dpg/mailer`).
 *
 * SMTP and AWS SES adapters implement the same surface, so a deployment can
 * pick either without code changes.
 */

/** One file to attach to a message. */
export interface SendAttachment {
  /** Filename shown to the recipient. Must already be sanitised. */
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SendInput {
  to: string | string[];
  subject: string;
  /** Inline-styled HTML body. Email clients strip <style> tags. */
  html: string;
  /** Plain-text fallback. Required for spam-filter friendliness. */
  text: string;
  /** Override default `from`. Optional. */
  from?: string;
  /** Reply-To header. Optional. */
  replyTo?: string;
  /** CC recipients. Optional. */
  cc?: string | string[];
  /** Files to attach. Optional. SES sends these as raw MIME. */
  attachments?: SendAttachment[];
}

export interface SendOk {
  messageId: string;
}

export type MailerResult<T> = { ok: true; value: T } | { ok: false; error: MailerError };

export type MailerError =
  | { code: 'TRANSPORT_FAILED'; message: string }
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'INVALID_RECIPIENT'; message: string };

/** Total attachment bytes on a message, for logging and size checks. */
export function totalAttachmentBytes(attachments: SendAttachment[] | undefined): number {
  return (attachments ?? []).reduce((sum, item) => sum + item.content.byteLength, 0);
}

export abstract class MailerAdapter {
  abstract send(input: SendInput): Promise<MailerResult<SendOk>>;
}
