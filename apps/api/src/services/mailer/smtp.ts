/**
 * SMTP-backed mailer using nodemailer.
 *
 * Targets MailHog in dev (host `mailhog`, port `1025`, no auth) and any
 * standard SMTP server in production (Postmark, Mailgun, AWS SES SMTP
 * endpoint, customer relay, etc.). Connection is created once per adapter
 * instance and pooled by nodemailer internally.
 */

import { createRequire } from 'node:module';
import type { Transporter, SendMailOptions } from 'nodemailer';
import { MailerAdapter, type MailerResult, type SendInput, type SendOk } from './interface.js';

const require = createRequire(import.meta.url);
type NodemailerCreateTransport = (opts: unknown) => Transporter;
const createTransport: NodemailerCreateTransport =
  require('nodemailer').default?.createTransport ?? require('nodemailer').createTransport;

export interface SmtpMailerOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /** Use STARTTLS or TLS. Default `false` (MailHog has no TLS). */
  secure?: boolean;
}

export class SmtpMailer extends MailerAdapter {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(opts: SmtpMailerOptions) {
    super();
    this.from = opts.from;
    this.transporter = createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? false,
      ...(opts.user && opts.pass ? { auth: { user: opts.user, pass: opts.pass } } : {}),
      // Use a small connection pool so concurrent sends don't open a fresh
      // TCP for each one.
      pool: true,
      maxConnections: 3,
    });
  }

  async send(input: SendInput): Promise<MailerResult<SendOk>> {
    const message: SendMailOptions = {
      from: input.from ?? this.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.cc ? { cc: input.cc } : {}),
    };
    try {
      const info = await this.transporter.sendMail(message);
      return { ok: true, value: { messageId: info.messageId } };
    } catch (err) {
      const e = err as { code?: string; message?: string; responseCode?: number };
      const code = mapSmtpError(e);
      return {
        ok: false,
        error: { code, message: e.message ?? 'smtp send failed' },
      };
    }
  }

  /** Closes the underlying transport. Call from process shutdown. */
  async close(): Promise<void> {
    this.transporter.close();
  }
}

function mapSmtpError(e: {
  code?: string;
  responseCode?: number;
}): 'AUTH_FAILED' | 'INVALID_RECIPIENT' | 'TRANSPORT_FAILED' {
  if (e.code === 'EAUTH') return 'AUTH_FAILED';
  if (e.responseCode === 550 || e.responseCode === 553) return 'INVALID_RECIPIENT';
  return 'TRANSPORT_FAILED';
}
