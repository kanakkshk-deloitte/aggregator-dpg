/**
 * Unit tests for attachment handling in both mailer adapters (#551).
 *
 * SMTP is a straight passthrough to nodemailer; SES has to leave its
 * `Content.Simple` API for raw MIME, which is the part worth pinning down —
 * that the file actually lands in the message, and that the no-attachment path
 * is untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { type SESv2Client } from '@aws-sdk/client-sesv2';
import { SesMailer } from './ses.js';
import { SmtpMailer } from './smtp.js';
import { totalAttachmentBytes } from './interface.js';

const attachment = {
  filename: 'evidence.png',
  contentType: 'image/png',
  content: Buffer.from('a tiny png'),
};

/** Captures the last command the mailer sent to the SES client. */
class CapturingSesClient {
  lastInput: unknown = null;
  async send(command: { input: unknown }): Promise<{ MessageId: string }> {
    this.lastInput = command.input;
    return { MessageId: 'msg-1' };
  }
}

function makeSesMailer() {
  const client = new CapturingSesClient();
  const mailer = new SesMailer({
    region: 'ap-south-1',
    from: 'no-reply@org.com',
    client: client as unknown as SESv2Client,
  });
  return { client, mailer };
}

function makeSmtpMailer() {
  const mailer = new SmtpMailer({ host: 'localhost', port: 1025, from: 'no-reply@org.com' });
  const sendMail = vi.fn().mockResolvedValue({ messageId: '<id@local>' });
  (mailer as unknown as { transporter: { sendMail: unknown } }).transporter.sendMail = sendMail;
  return { mailer, sendMail };
}

describe('SmtpMailer attachments', () => {
  it('forwards attachments onto the nodemailer options', async () => {
    const { mailer, sendMail } = makeSmtpMailer();
    const r = await mailer.send({
      to: 'to@org.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      attachments: [attachment],
    });
    expect(r.ok).toBe(true);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ attachments: [attachment] });
    await mailer.close();
  });

  it('omits the attachments key when there are none', async () => {
    const { mailer, sendMail } = makeSmtpMailer();
    await mailer.send({ to: 'to@org.com', subject: 's', html: '', text: '' });
    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('attachments');
    await mailer.close();
  });
});

describe('SesMailer attachments', () => {
  it('switches to raw MIME carrying the file', async () => {
    const { client, mailer } = makeSesMailer();
    const r = await mailer.send({
      to: 'to@org.com',
      cc: 'ops@org.com',
      replyTo: 'asha@example.com',
      subject: 'Complaint from Asha',
      html: '<p>details</p>',
      text: 'details',
      attachments: [attachment],
    });
    expect(r.ok).toBe(true);

    const input = client.lastInput as {
      Content: { Raw?: { Data: Uint8Array }; Simple?: unknown };
      Destination: { ToAddresses: string[]; CcAddresses?: string[] };
      ReplyToAddresses?: string[];
    };
    expect(input.Content.Simple).toBeUndefined();
    expect(input.Content.Raw).toBeDefined();

    const mime = Buffer.from(input.Content.Raw!.Data).toString('utf8');
    expect(mime).toContain('evidence.png');
    expect(mime).toContain('Content-Type: image/png');
    // Attachment bodies are base64 in MIME, so assert the encoded payload.
    expect(mime).toContain(attachment.content.toString('base64'));
    // Headers must carry the recipients too, so the mail doesn't look blind...
    expect(mime).toContain('to@org.com');
    expect(mime).toContain('ops@org.com');
    expect(mime).toContain('Subject: Complaint from Asha');
    expect(mime).toContain('asha@example.com');
    // ...while Destination stays set, since SES uses it as the envelope.
    expect(input.Destination.ToAddresses).toEqual(['to@org.com']);
    expect(input.Destination.CcAddresses).toEqual(['ops@org.com']);
    expect(input.ReplyToAddresses).toEqual(['asha@example.com']);
  });

  it('keeps both body parts in the raw message', async () => {
    const { client, mailer } = makeSesMailer();
    await mailer.send({
      to: 'to@org.com',
      subject: 's',
      html: '<p>hello html</p>',
      text: 'hello text',
      attachments: [attachment],
    });
    const input = client.lastInput as { Content: { Raw: { Data: Uint8Array } } };
    const mime = Buffer.from(input.Content.Raw.Data).toString('utf8');
    expect(mime).toContain('text/html');
    expect(mime).toContain('text/plain');
  });

  it('carries multiple attachments', async () => {
    const { client, mailer } = makeSesMailer();
    await mailer.send({
      to: 'to@org.com',
      subject: 's',
      html: '',
      text: '',
      attachments: [
        attachment,
        { filename: 'clip.mp4', contentType: 'video/mp4', content: Buffer.from('mp4 bytes') },
      ],
    });
    const input = client.lastInput as { Content: { Raw: { Data: Uint8Array } } };
    const mime = Buffer.from(input.Content.Raw.Data).toString('utf8');
    expect(mime).toContain('evidence.png');
    expect(mime).toContain('clip.mp4');
    expect(mime).toContain('video/mp4');
  });

  it('still uses Content.Simple when there are no attachments', async () => {
    const { client, mailer } = makeSesMailer();
    await mailer.send({ to: 'to@org.com', subject: 's', html: '<p>h</p>', text: 't' });
    const input = client.lastInput as {
      Content: { Raw?: unknown; Simple?: { Subject: { Data: string } } };
    };
    expect(input.Content.Raw).toBeUndefined();
    expect(input.Content.Simple?.Subject.Data).toBe('s');
  });

  it('reports a send failure the same way on the raw path', async () => {
    const failing = {
      async send() {
        throw Object.assign(new Error('rejected'), { name: 'MessageRejected' });
      },
    };
    const mailer = new SesMailer({
      region: 'ap-south-1',
      from: 'no-reply@org.com',
      client: failing as unknown as SESv2Client,
    });
    const r = await mailer.send({
      to: 'to@org.com',
      subject: 's',
      html: '',
      text: '',
      attachments: [attachment],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_RECIPIENT' } });
  });

  it('returns a Result instead of throwing when the MIME build fails', async () => {
    // buildRawMime awaits MailComposer, which can reject on pathological input.
    // Built outside the try, that rejection would escape send() and the route's
    // error handler would turn it into a 500 INTERNAL instead of the intended
    // 502 SUPPORT_SEND_FAILED — the adapter contract is "return a Result, never
    // throw across the boundary".
    const { mailer } = makeSesMailer();
    // A throwing getter stands in for a MailComposer rejection: it fires while
    // the raw MIME is being assembled, which is exactly where buildRawMime runs.
    const hostile = {
      filename: 'evidence.png',
      contentType: 'image/png',
      get content(): Buffer {
        throw new Error('unreadable attachment');
      },
    } as unknown as { filename: string; contentType: string; content: Buffer };

    const result = await mailer.send({
      to: 'to@org.com',
      subject: 's',
      html: '',
      text: '',
      attachments: [hostile],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSPORT_FAILED');
  });
});

describe('totalAttachmentBytes', () => {
  it('sums content sizes and treats an absent list as zero', () => {
    expect(totalAttachmentBytes(undefined)).toBe(0);
    expect(totalAttachmentBytes([attachment, attachment])).toBe(attachment.content.byteLength * 2);
  });
});
