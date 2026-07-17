/**
 * AWS SES v2-backed mailer.
 *
 * Used in deployments where the operator prefers SES over generic SMTP.
 * Authentication uses the standard AWS SDK credential chain (env vars,
 * shared profile, IAM role on EC2/ECS/Lambda).
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { MailerAdapter, type MailerResult, type SendInput, type SendOk } from './interface.js';

/**
 * Normalises a recipient value to a list of individual addresses. Accepts an
 * array, a single address, or a comma-separated string (each entry trimmed,
 * blanks dropped) — SES requires individual addresses, unlike SMTP.
 *
 * @param value - One address, a comma-separated string, or an array.
 * @returns The individual, trimmed, non-empty addresses.
 */
function toAddressList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(','))
    .map((address) => address.trim())
    .filter(Boolean);
}

export interface SesMailerOptions {
  region: string;
  from: string;
  /** Optional SES configuration set for tracking, suppression list, etc. */
  configurationSetName?: string;
  /** Inject a pre-built client (tests). */
  client?: SESv2Client;
}

export class SesMailer extends MailerAdapter {
  private readonly client: SESv2Client;
  private readonly from: string;
  private readonly configurationSetName: string | undefined;

  constructor(opts: SesMailerOptions) {
    super();
    this.client = opts.client ?? new SESv2Client({ region: opts.region });
    this.from = opts.from;
    this.configurationSetName = opts.configurationSetName;
  }

  async send(input: SendInput): Promise<MailerResult<SendOk>> {
    // SES expects an array of individual addresses; a comma-joined string
    // (how the support config surfaces multiple recipients) would otherwise
    // be treated as one invalid RFC-5321 address and rejected. Normalise
    // string | string[] to a trimmed list here so multi-recipient TO/CC work.
    const ccAddresses = input.cc ? toAddressList(input.cc) : [];
    const command = new SendEmailCommand({
      FromEmailAddress: input.from ?? this.from,
      Destination: {
        ToAddresses: toAddressList(input.to),
        ...(ccAddresses.length ? { CcAddresses: ccAddresses } : {}),
      },
      ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
      ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: input.html, Charset: 'UTF-8' },
            Text: { Data: input.text, Charset: 'UTF-8' },
          },
        },
      },
    });
    try {
      const out = await this.client.send(command);
      return {
        ok: true,
        value: { messageId: out.MessageId ?? '' },
      };
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      let code: 'AUTH_FAILED' | 'INVALID_RECIPIENT' | 'TRANSPORT_FAILED' = 'TRANSPORT_FAILED';
      if (e.name === 'AccessDeniedException' || e.name === 'NotAuthorizedException') {
        code = 'AUTH_FAILED';
      } else if (e.name === 'MailFromDomainNotVerifiedException' || e.name === 'MessageRejected') {
        code = 'INVALID_RECIPIENT';
      }
      return {
        ok: false,
        error: { code, message: `SES ${e.name ?? 'error'}: ${e.message ?? 'send failed'}` },
      };
    }
  }
}
