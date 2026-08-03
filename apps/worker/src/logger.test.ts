/**
 * Verifies the worker logger redacts participant PII (email/phone) and secrets
 * at the nestings the pipeline actually logs them (top level, and under
 * `payload`/`fields`/`err`). Guards PLAN 1.11 — the worker previously logged
 * unredacted.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_PATHS } from './logger.js';

/** Captures one log line written by a pino logger using REDACT_PATHS. */
function capture(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
  log.info(obj, 'test');
  return out;
}

describe('worker logger redaction', () => {
  it('masks email/phone at top level, one level, and two levels deep', () => {
    const out = capture({
      email: 'top@x.io',
      phone: '1112223333',
      payload: { email: 'row@x.io', phone: '4445556666', name: 'Asha' },
      err: { fields: { email: 'deep@x.io' } },
      keepMe: 'visible',
    });

    // No PII value survives.
    expect(out).not.toContain('@x.io');
    expect(out).not.toContain('1112223333');
    expect(out).not.toContain('4445556666');
    // Redaction happened and non-PII is preserved.
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('visible');
    expect(out).toContain('Asha');
  });

  it('masks secret-bearing fields', () => {
    const out = capture({ session: { access_token: 'abc', refresh_token: 'def', password: 'pw' } });
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
    expect(out).not.toContain('pw');
    expect(out).toContain('[REDACTED]');
  });
});
