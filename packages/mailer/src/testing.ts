/**
 * In-memory mailer for tests. Captures every outbound message for
 * inspection and never touches the network.
 */

import { randomUUID } from 'node:crypto';
import { MailerAdapter, type MailerResult, type SendInput, type SendOk } from './interface.js';

export interface CapturedMessage extends SendInput {
  messageId: string;
  sentAt: Date;
}

export class FakeMailer extends MailerAdapter {
  readonly outbox: CapturedMessage[] = [];
  private failNext: {
    code: 'TRANSPORT_FAILED' | 'AUTH_FAILED' | 'INVALID_RECIPIENT';
    message: string;
  } | null = null;

  /** Force the next `send()` to fail. */
  failOnce(error: {
    code: 'TRANSPORT_FAILED' | 'AUTH_FAILED' | 'INVALID_RECIPIENT';
    message: string;
  }): void {
    this.failNext = error;
  }

  /** Returns the most recent message, or undefined. */
  last(): CapturedMessage | undefined {
    return this.outbox[this.outbox.length - 1];
  }

  /** Clears the outbox + failure flag. */
  reset(): void {
    this.outbox.length = 0;
    this.failNext = null;
  }

  async send(input: SendInput): Promise<MailerResult<SendOk>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    const messageId = `<${randomUUID()}@fake.local>`;
    this.outbox.push({ ...input, messageId, sentAt: new Date() });
    return { ok: true, value: { messageId } };
  }
}
