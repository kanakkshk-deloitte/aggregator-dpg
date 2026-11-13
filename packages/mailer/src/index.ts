/**
 * Mailer factory (`@aggregator-dpg/mailer`). Picks an implementation via `MAIL_PROVIDER`:
 *   - `smtp` (default) → SmtpMailer
 *   - `ses`            → SesMailer
 *
 * Returns a process-wide singleton so the SMTP connection pool is reused.
 */

import { SmtpMailer } from './smtp.js';
import { SesMailer } from './ses.js';
import type { MailerAdapter } from './interface.js';

let instance: MailerAdapter | null = null;

/**
 * Returns the shared mailer.
 */
export function getMailer(): MailerAdapter {
  if (instance) return instance;
  const provider = (process.env.MAIL_PROVIDER ?? 'smtp').toLowerCase();
  switch (provider) {
    case 'ses': {
      const region = mustEnv('AWS_REGION');
      const from = mustEnv('SES_FROM');
      const configurationSetName = process.env.SES_CONFIGURATION_SET;
      instance = new SesMailer({
        region,
        from,
        ...(configurationSetName ? { configurationSetName } : {}),
      });
      return instance;
    }
    case 'smtp': {
      const host = mustEnv('SMTP_HOST');
      const port = Number(process.env.SMTP_PORT ?? 1025);
      const from = process.env.SMTP_FROM ?? 'no-reply@bluedots.local';
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASSWORD;
      const secure = process.env.SMTP_SECURE === 'true';
      instance = new SmtpMailer({
        host,
        port,
        from,
        secure,
        ...(user ? { user } : {}),
        ...(pass ? { pass } : {}),
      });
      return instance;
    }
    default:
      throw new Error(`unknown MAIL_PROVIDER: ${provider}`);
  }
}

/** Test helper — replace the singleton. */
export function _setMailer(m: MailerAdapter | null): void {
  instance = m;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

export { MailerAdapter } from './interface.js';
export type { SendInput, SendOk, MailerResult, MailerError } from './interface.js';
export { FakeMailer } from './testing.js';
