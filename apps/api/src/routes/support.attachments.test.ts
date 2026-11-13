// Attachment + rate-limit behaviour of the contact-support endpoint (#551).
// SUPPORT_EMAIL must be set before any import that pulls in `config` (parsed
// once, at first import) — same constraint as `support.test.ts`.
process.env.SUPPORT_EMAIL = 'support@org.com';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSupportRateChecker } from '../services/support-rate.js';

/** Base64 payload of a given decoded size. */
const payload = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');

const png = (bytes = 1024, over: Record<string, unknown> = {}) => ({
  filename: 'evidence.png',
  contentType: 'image/png',
  data: payload(bytes),
  ...over,
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Asha K',
    email: 'asha@example.com',
    phone: '+919000000000',
    type: 'complaint',
    details: 'It broke',
    consent: true,
    ...overrides,
  };
}

describe('POST /v1/support — attachments', () => {
  let app: FastifyInstance;
  let mailer: FakeMailer;

  const post = (payloadBody: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: payloadBody,
    });

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good-token') {
        return { sub: 'u1', aggregator_id: 'agg-9', email: 'asha@example.com' };
      }
      throw new Error('invalid token');
    });
    // Allow by default: the real limiter needs Redis, and every test here that
    // isn't about rate limiting should be unaffected by it.
    _setSupportRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));

    mailer = new FakeMailer();
    _setMailer(mailer);
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSupportRateChecker(null);
    delete process.env.SUPPORT_ATTACHMENT_MAX_FILES;
    delete process.env.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES;
  });

  it('attaches the decoded file to the outgoing mail and lists it in the body', async () => {
    const res = await post(validBody({ attachments: [png(1024)] }));
    expect(res.statusCode).toBe(201);

    const sent = mailer.outbox[0]!;
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe('evidence.png');
    expect(sent.attachments![0]!.contentType).toBe('image/png');
    // Decoded, not the base64 string — the transports expect bytes.
    expect(sent.attachments![0]!.content.byteLength).toBe(1024);
    expect(sent.html).toContain('Attachments (1)');
    expect(sent.html).toContain('evidence.png');
    expect(sent.text).toContain('evidence.png');
  });

  it('omits attachments entirely when none are submitted', async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(201);
    expect(mailer.outbox[0]!.attachments).toBeUndefined();
    expect(mailer.outbox[0]!.html).not.toContain('Attachments (');
  });

  it('sanitises a path out of the submitted filename', async () => {
    const res = await post(validBody({ attachments: [png(64, { filename: '../../secret.png' })] }));
    expect(res.statusCode).toBe(201);
    expect(mailer.outbox[0]!.attachments![0]!.filename).toBe('secret.png');
  });

  it('carries several files at once', async () => {
    const res = await post(
      validBody({
        attachments: [
          png(64),
          { filename: 'clip.mp4', contentType: 'video/mp4', data: payload(64) },
          { filename: 'note.mp3', contentType: 'audio/mpeg', data: payload(64) },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(mailer.outbox[0]!.attachments).toHaveLength(3);
    expect(mailer.outbox[0]!.html).toContain('Attachments (3)');
  });

  it('rejects more files than SUPPORT_ATTACHMENT_MAX_FILES with its own code', async () => {
    process.env.SUPPORT_ATTACHMENT_MAX_FILES = '2';
    const res = await post(validBody({ attachments: [png(16), png(16), png(16)] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ATTACHMENT_COUNT_EXCEEDED' } });
    expect(mailer.outbox).toHaveLength(0);
  });

  it('rejects a total over SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES, naming the limit', async () => {
    process.env.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES = '4096';
    const res = await post(validBody({ attachments: [png(3000), png(3000)] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ATTACHMENT_TOO_LARGE' } });
    expect(JSON.stringify(res.json())).toContain('4.0 KB');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('rejects a content type outside the allowlist, naming the file', async () => {
    const res = await post(
      validBody({
        attachments: [
          { filename: 'run.exe', contentType: 'application/x-msdownload', data: payload(16) },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ATTACHMENT_TYPE_NOT_ALLOWED' } });
    expect(JSON.stringify(res.json())).toContain('run.exe');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('rejects a body past the derived limit with a 413', async () => {
    // 64KB budget ⇒ ~85KB base64 + 256KB headroom; 512KB is comfortably over.
    process.env.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES = String(64 * 1024);
    const over = await buildApp();
    try {
      const res = await over.inject({
        method: 'POST',
        url: '/v1/support',
        headers: { authorization: 'Bearer good-token' },
        payload: validBody({ attachments: [png(512 * 1024)] }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
      expect(mailer.outbox).toHaveLength(0);
    } finally {
      await over.close();
    }
  });

  it('still rejects unknown body keys (the schema stays strict)', async () => {
    const res = await post(validBody({ attachment: [png(16)] }));
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('counts an invalid submission against the quota, not just accepted ones', async () => {
    // The body is already buffered and parsed by the time the handler runs, so a
    // rejected submission costs the same as an accepted one. If only accepted
    // ones counted, a caller could post oversized rubbish without limit.
    const keys: string[] = [];
    _setSupportRateChecker(async (key) => {
      keys.push(key);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    const res = await post(
      validBody({
        attachments: [
          { filename: 'run.exe', contentType: 'application/x-msdownload', data: payload(16) },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ATTACHMENT_TYPE_NOT_ALLOWED' } });
    expect(keys).toEqual(['u1']);
  });

  it('429s an over-quota caller before it even looks at the attachments', async () => {
    _setSupportRateChecker(async () => ({ allowed: false, retryAfterSeconds: 60 }));
    const res = await post(
      validBody({
        attachments: [
          { filename: 'run.exe', contentType: 'application/x-msdownload', data: payload(16) },
        ],
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('accepts a request exactly at the budget without a 413', async () => {
    // The derived body limit must leave room for a max-legal payload: base64
    // inflation plus the rest of the form. Only the far-over case was covered.
    const exact = payload(5 * 1024 * 1024);
    const res = await post(
      validBody({ attachments: [{ filename: 'max.png', contentType: 'image/png', data: exact }] }),
    );
    expect(res.statusCode).toBe(201);
  });

  it('rejects an attachment whose data is not base64', async () => {
    const res = await post(
      validBody({
        attachments: [
          { filename: 'a.png', contentType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ATTACHMENT_INVALID_ENCODING' } });
    expect(mailer.outbox).toHaveLength(0);
  });
});

describe('POST /v1/support — rate limit', () => {
  let app: FastifyInstance;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    _setAccessTokenVerifier(async () => ({
      sub: 'u1',
      aggregator_id: 'agg-9',
      email: 'asha@example.com',
    }));
    mailer = new FakeMailer();
    _setMailer(mailer);
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSupportRateChecker(null);
  });

  it('returns 429 with a retry hint once the window is exhausted', async () => {
    _setSupportRateChecker(async () => ({ allowed: false, retryAfterSeconds: 120 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(JSON.stringify(res.json())).toContain('120');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('keys the bucket on the authenticated user', async () => {
    const keys: string[] = [];
    _setSupportRateChecker(async (key) => {
      keys.push(key);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody(),
    });
    expect(keys).toEqual(['u1']);
  });
});
