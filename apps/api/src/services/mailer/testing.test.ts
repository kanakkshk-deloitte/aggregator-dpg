import { describe, it, expect, beforeEach } from 'vitest';
import { FakeMailer } from './testing.js';

describe('FakeMailer', () => {
  let mailer: FakeMailer;

  beforeEach(() => {
    mailer = new FakeMailer();
  });

  it('captures messages to the outbox', async () => {
    const r = await mailer.send({
      to: 'a@b.in',
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(r.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.last()?.subject).toBe('hi');
    if (r.ok) expect(r.value.messageId).toMatch(/^<[0-9a-f-]+@fake\.local>$/);
  });

  it('failOnce makes only the next call fail', async () => {
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'down' });
    const a = await mailer.send({ to: 'a@b.in', subject: 's', html: '', text: '' });
    expect(a.ok).toBe(false);
    const b = await mailer.send({ to: 'a@b.in', subject: 's', html: '', text: '' });
    expect(b.ok).toBe(true);
  });

  it('captures the cc recipients on the outbox message', async () => {
    await mailer.send({
      to: 'a@b.in',
      cc: ['ops@b.in', 'lead@b.in'],
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(mailer.last()?.cc).toEqual(['ops@b.in', 'lead@b.in']);
  });

  it('reset clears outbox', async () => {
    await mailer.send({ to: 'a@b.in', subject: 's', html: '', text: '' });
    mailer.reset();
    expect(mailer.outbox).toHaveLength(0);
  });
});
