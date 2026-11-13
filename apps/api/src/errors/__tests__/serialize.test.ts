import { describe, it, expect } from 'vitest';
import { ERR } from '../codes.js';
import { HttpError, httpError } from '../http-error.js';
import { coerceToHttpError, toEnvelope, toLogPayload } from '../serialize.js';

describe('errors/serialize', () => {
  describe('toEnvelope', () => {
    it('builds the canonical wire envelope from an HttpError', () => {
      const err = httpError('PHONE_EXISTS', { fields: { phone: '+919876543210' } });
      const env = toEnvelope(err, 'req-abc');

      expect(env.error.code).toBe('PHONE_EXISTS');
      expect(env.error.title).toBe('Phone already in use');
      expect(env.error.detail).toContain('mobile number');
      expect(env.error.fields).toEqual({ phone: '+919876543210' });
      expect(env.error.requestId).toBe('req-abc');
      expect(env.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('omits hint, stack, and cause from the wire envelope', () => {
      const err = httpError('IDP_UNAVAILABLE', { cause: new Error('connection reset') });
      const env = toEnvelope(err, 'req-1');
      const flat = JSON.stringify(env);
      expect(flat).not.toContain('hint');
      expect(flat).not.toContain('connection reset');
      expect(flat).not.toContain('cause');
      expect(flat).not.toContain('stack');
    });

    it('honours an overridden detail', () => {
      const err = httpError('NOT_FOUND', { detail: 'Aggregator record not found.' });
      const env = toEnvelope(err, 'r');
      expect(env.error.detail).toBe('Aggregator record not found.');
    });
  });

  describe('toLogPayload', () => {
    it('always includes the hint', () => {
      const err = httpError('PHONE_EXISTS');
      const log = toLogPayload(err, false);
      expect(log.code).toBe('PHONE_EXISTS');
      expect(log.status).toBe(409);
      expect(log.hint).toContain('OTP login');
    });

    it('includes the stack only when includeStack=true', () => {
      const err = httpError('INTERNAL');
      expect(toLogPayload(err, false).stack).toBeUndefined();
      expect(toLogPayload(err, true).stack).toBeDefined();
    });

    it('flattens cause to a string', () => {
      const root = new Error('underlying');
      const err = httpError('IDP_UNAVAILABLE', { cause: root });
      const log = toLogPayload(err, false);
      expect(log.cause).toContain('underlying');
    });
  });

  describe('coerceToHttpError', () => {
    it('passes HttpError through unchanged', () => {
      const original = httpError('USER_EXISTS');
      const coerced = coerceToHttpError(original);
      expect(coerced).toBe(original);
    });

    it('wraps a plain Error as ERR.INTERNAL with the original as cause', () => {
      const root = new Error('boom');
      const coerced = coerceToHttpError(root);
      expect(coerced).toBeInstanceOf(HttpError);
      expect(coerced.code).toBe(ERR.INTERNAL.code);
      expect(coerced.status).toBe(500);
      expect(coerced.cause).toBe(root);
    });

    it('wraps a non-Error throwable as ERR.INTERNAL', () => {
      const coerced = coerceToHttpError('string thrown');
      expect(coerced.code).toBe('INTERNAL');
      expect(coerced.cause).toBe('string thrown');
    });
  });

  describe('HttpError shape', () => {
    it('carries every catalogue field', () => {
      const err = httpError('PHONE_EXISTS');
      expect(err.code).toBe('PHONE_EXISTS');
      expect(err.status).toBe(409);
      expect(err.title).toBeTruthy();
      expect(err.detail).toBeTruthy();
      expect(err.hint).toBeTruthy();
    });

    it('preserves `instanceof HttpError`', () => {
      const err = httpError('NOT_FOUND');
      expect(err instanceof HttpError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });
  });
});
