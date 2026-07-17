/**
 * Mailer contract.
 *
 * Concrete adapters implement the same surface so deployments can choose
 * between vendor-neutral SMTP (MailHog dev, customer SMTP, Postmark, etc.)
 * and AWS SES without touching application code.
 */

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
}

export interface SendOk {
  messageId: string;
}

export type MailerResult<T> = { ok: true; value: T } | { ok: false; error: MailerError };

export type MailerError =
  | { code: 'TRANSPORT_FAILED'; message: string }
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'INVALID_RECIPIENT'; message: string };

export abstract class MailerAdapter {
  abstract send(input: SendInput): Promise<MailerResult<SendOk>>;
}
