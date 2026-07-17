/**
 * Unit test for the SMTP mailer's message assembly — that a `cc` on the
 * SendInput is forwarded onto the nodemailer `SendMailOptions`. The pooled
 * transport never dials out here: its `sendMail` method is spied so no SMTP
 * connection is opened.
 */
import { describe, it, expect, vi } from 'vitest';
import { SmtpMailer } from './smtp.js';

function makeMailer() {
  const mailer = new SmtpMailer({ host: 'localhost', port: 1025, from: 'no-reply@org.com' });
  // Replace only the send method on the real transport (spy, not module mock)
  // so we can assert the options without touching the network.
  const sendMail = vi.fn().mockResolvedValue({ messageId: '<id@local>' });
  (mailer as unknown as { transporter: { sendMail: unknown } }).transporter.sendMail = sendMail;
  return { mailer, sendMail };
}

describe('SmtpMailer cc handling', () => {
  it('forwards cc onto the nodemailer options', async () => {
    const { mailer, sendMail } = makeMailer();
    const r = await mailer.send({
      to: 'to@org.com',
      cc: ['ops@org.com', 'lead@org.com'],
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
    expect(r.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      to: 'to@org.com',
      cc: ['ops@org.com', 'lead@org.com'],
    });
    await mailer.close();
  });

  it('omits cc when none is set', async () => {
    const { mailer, sendMail } = makeMailer();
    await mailer.send({ to: 'to@org.com', subject: 's', html: '', text: '' });
    expect('cc' in sendMail.mock.calls[0]![0]).toBe(false);
    await mailer.close();
  });
});
