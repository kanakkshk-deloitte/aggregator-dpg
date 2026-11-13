/**
 * Unit tests for the shared token helpers (#700/#701).
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTokenKey, _resetTokenKeyCache, isJwtLike, mapJoseError } from './token-common.js';

describe('token-common', () => {
  const original = process.env.APPROVAL_TOKEN_SECRET;
  beforeEach(() => _resetTokenKeyCache());
  afterEach(() => {
    process.env.APPROVAL_TOKEN_SECRET = original;
    _resetTokenKeyCache();
  });

  it('getTokenKey throws when the secret is unset', () => {
    delete process.env.APPROVAL_TOKEN_SECRET;
    expect(() => getTokenKey()).toThrow(/APPROVAL_TOKEN_SECRET/);
  });

  it('getTokenKey throws when the secret is too short', () => {
    process.env.APPROVAL_TOKEN_SECRET = 'short';
    expect(() => getTokenKey()).toThrow(/at least 32/);
  });

  it('getTokenKey returns a cached key on repeat calls', () => {
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    const first = getTokenKey();
    expect(getTokenKey()).toBe(first);
  });

  it('isJwtLike accepts a dotted string and rejects everything else', () => {
    expect(isJwtLike('a.b.c')).toBe(true);
    expect(isJwtLike('nodots')).toBe(false);
    expect(isJwtLike('')).toBe(false);
    expect(isJwtLike(null)).toBe(false);
    expect(isJwtLike(123)).toBe(false);
  });

  it('mapJoseError falls back to INVALID for an unknown error', () => {
    const f = mapJoseError(new Error('weird'));
    expect(f.code).toBe('INVALID');
    expect(f.message).toBe('weird');
  });
});
