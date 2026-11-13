import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signFlowState,
  verifyFlowState,
  sessionCookieOptions,
  oidcFlowCookieOptions,
  clearCookieOptions,
} from '@/lib/cookies';

describe('flow state signing', () => {
  beforeEach(() => {
    process.env.SESSION_KEY = 'a'.repeat(48);
  });

  it('round-trips a valid state', () => {
    const original = {
      state: 'st',
      nonce: 'no',
      codeVerifier: 'verifier',
      returnTo: '/dashboard',
    };
    const signed = signFlowState(original);
    expect(verifyFlowState(signed)).toEqual(original);
  });

  it('rejects undefined input', () => {
    expect(verifyFlowState(undefined)).toBeNull();
  });

  it('rejects malformed payload', () => {
    expect(verifyFlowState('garbage')).toBeNull();
  });

  it('rejects bad signature', () => {
    const signed = signFlowState({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
    });
    const tampered = signed.slice(0, -2) + (signed.endsWith('00') ? 'ff' : '00');
    expect(verifyFlowState(tampered)).toBeNull();
  });

  it('rejects when payload is altered', () => {
    const signed = signFlowState({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
    });
    const dot = signed.lastIndexOf('.');
    const altered = 'eyJzdGF0ZSI6IngifQ' + signed.slice(dot);
    expect(verifyFlowState(altered)).toBeNull();
  });

  it('throws when SESSION_KEY missing', () => {
    delete process.env.SESSION_KEY;
    expect(() =>
      signFlowState({ state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/' }),
    ).toThrow(/SESSION_KEY/);
  });

  it('throws when SESSION_KEY is too short', () => {
    process.env.SESSION_KEY = 'short';
    expect(() =>
      signFlowState({ state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/' }),
    ).toThrow(/SESSION_KEY/);
  });

  it('rejects a payload with no separating dot', () => {
    expect(verifyFlowState('nodothere')).toBeNull();
  });

  it('rejects when the signature segment is not valid hex', () => {
    const signed = signFlowState({ state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/' });
    const dot = signed.lastIndexOf('.');
    const badHex = `${signed.slice(0, dot)}.not-hex-zz`;
    expect(verifyFlowState(badHex)).toBeNull();
  });
});

describe('cookie options', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.SESSION_TTL_SECONDS;
  });

  it('sessionCookieOptions returns the expected shape with maxAge from SESSION_TTL_SECONDS', () => {
    process.env.SESSION_TTL_SECONDS = '3600';
    const opts = sessionCookieOptions();
    expect(opts).toEqual({
      httpOnly: true,
      secure: opts.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
  });

  it('sessionCookieOptions defaults maxAge to 12h when unset', () => {
    delete process.env.SESSION_TTL_SECONDS;
    expect(sessionCookieOptions().maxAge).toBe(60 * 60 * 12);
  });

  it('oidcFlowCookieOptions always uses the 5-minute TTL', () => {
    expect(oidcFlowCookieOptions().maxAge).toBe(60 * 5);
  });

  it('clearCookieOptions sets maxAge 0', () => {
    expect(clearCookieOptions().maxAge).toBe(0);
  });

  it('cookieSecure is true when COOKIE_SECURE=true, regardless of NODE_ENV', () => {
    process.env.COOKIE_SECURE = 'true';
    process.env.NODE_ENV = 'development';
    expect(sessionCookieOptions().secure).toBe(true);
  });

  it('cookieSecure is false when COOKIE_SECURE=false, even in production', () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.NODE_ENV = 'production';
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it('cookieSecure falls back to NODE_ENV when COOKIE_SECURE is unset', () => {
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    expect(sessionCookieOptions().secure).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(sessionCookieOptions().secure).toBe(false);
  });
});
