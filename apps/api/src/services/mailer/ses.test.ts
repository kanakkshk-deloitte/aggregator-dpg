/**
 * Unit tests for the SES mailer's request assembly — specifically that a
 * `cc` on the SendInput is projected onto `Destination.CcAddresses`. A
 * stub SESv2 client is injected so no AWS call is made.
 */
import { describe, it, expect } from 'vitest';
import { type SESv2Client } from '@aws-sdk/client-sesv2';
import { SesMailer } from './ses.js';

/** Captures the last command the mailer sent to the SES client. */
class CapturingSesClient {
  lastInput: unknown = null;
  // Match the shape SesMailer calls: `client.send(command)`.
  async send(command: { input: unknown }): Promise<{ MessageId: string }> {
    this.lastInput = command.input;
    return { MessageId: 'msg-1' };
  }
}

function makeMailer() {
  const client = new CapturingSesClient();
  const mailer = new SesMailer({
    region: 'ap-south-1',
    from: 'no-reply@org.com',
    client: client as unknown as SESv2Client,
  });
  return { client, mailer };
}

describe('SesMailer cc handling', () => {
  it('maps a single cc string to Destination.CcAddresses', async () => {
    const { client, mailer } = makeMailer();
    const r = await mailer.send({
      to: 'to@org.com',
      cc: 'cc@org.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
    expect(r.ok).toBe(true);
    const input = client.lastInput as {
      Destination: { ToAddresses: string[]; CcAddresses?: string[] };
    };
    expect(input.Destination.ToAddresses).toEqual(['to@org.com']);
    expect(input.Destination.CcAddresses).toEqual(['cc@org.com']);
  });

  it('passes a cc array through unchanged', async () => {
    const { client, mailer } = makeMailer();
    await mailer.send({
      to: ['a@org.com', 'b@org.com'],
      cc: ['x@org.com', 'y@org.com'],
      subject: 's',
      html: '',
      text: '',
    });
    const input = client.lastInput as { Destination: { CcAddresses?: string[] } };
    expect(input.Destination.CcAddresses).toEqual(['x@org.com', 'y@org.com']);
  });

  it('omits CcAddresses entirely when no cc is set', async () => {
    const { client, mailer } = makeMailer();
    await mailer.send({ to: 'to@org.com', subject: 's', html: '', text: '' });
    const input = client.lastInput as { Destination: Record<string, unknown> };
    expect('CcAddresses' in input.Destination).toBe(false);
  });

  it('splits a comma-joined multi-recipient string into individual addresses (H1)', async () => {
    const { client, mailer } = makeMailer();
    // How the support config surfaces multiple recipients: a comma-joined
    // string. SES must receive individual addresses, not one invalid entry.
    const r = await mailer.send({
      to: 'a@org.com, b@org.com',
      cc: 'c@org.com, d@org.com',
      subject: 's',
      html: '',
      text: '',
    });
    expect(r.ok).toBe(true);
    const input = client.lastInput as {
      Destination: { ToAddresses: string[]; CcAddresses?: string[] };
    };
    expect(input.Destination.ToAddresses).toEqual(['a@org.com', 'b@org.com']);
    expect(input.Destination.CcAddresses).toEqual(['c@org.com', 'd@org.com']);
  });
});
