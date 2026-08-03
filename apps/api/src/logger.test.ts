/**
 * Verifies the API logger redacts participant PII (email/phone) and secrets,
 * and — crucially — that the *shared* `loggerOptions` (the config the Fastify
 * request logger in `app.ts` is now built from) carries those same redactions.
 * Guards PLAN 1.11: the request-scoped `req.log` previously used a drifted
 * inline config that omitted email/phone, so the error handler logged
 * registration PII (`err.fields.email` / `.phone`) in plaintext.
 *
 * @module @aggregator-dpg/api
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_PATHS, loggerOptions } from './logger.js';

/** Captures one log line written by a pino logger using the given redact paths. */
function capture(paths: string[], obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact: { paths, censor: '[REDACTED]' } }, sink);
  log.info(obj, 'test');
  return out;
}

describe('api logger redaction', () => {
  it('masks email/phone at the nestings the error handler logs them', () => {
    // Shape mirrors `toLogPayload`: `fields` sits at the log root, so the
    // registration PII lands at `fields.email` / `fields.phone` (one level).
    const out = capture(REDACT_PATHS, {
      email: 'top@x.io',
      phone: '1112223333',
      fields: { email: 'reg@x.io', phone: '4445556666' },
      keepMe: 'visible',
    });

    expect(out).not.toContain('@x.io');
    expect(out).not.toContain('1112223333');
    expect(out).not.toContain('4445556666');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('visible');
  });

  it('masks secret-bearing fields', () => {
    // Use sentinel values that are not substrings of any redacted key name.
    const out = capture(REDACT_PATHS, {
      req: { headers: { authorization: 'Bearer AAA111', cookie: 'sid=BBB222' } },
      session: { access_token: 'CCC333', refresh_token: 'DDD444', password: 'EEE555' },
    });
    expect(out).not.toContain('AAA111');
    expect(out).not.toContain('BBB222');
    expect(out).not.toContain('CCC333');
    expect(out).not.toContain('DDD444');
    expect(out).not.toContain('EEE555');
    expect(out).toContain('[REDACTED]');
  });

  it('shared loggerOptions (used by the Fastify request logger) carries the PII redactions', () => {
    // Regression guard for the drift bug: the request logger must redact
    // `fields.email` / `fields.phone`, not just auth headers.
    const paths = (loggerOptions.redact as pino.redactOptions).paths;
    const out = capture([...paths], { fields: { email: 'req@x.io', phone: '9998887777' } });
    expect(out).not.toContain('req@x.io');
    expect(out).not.toContain('9998887777');
    expect(out).toContain('[REDACTED]');
  });
});
