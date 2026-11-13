import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectedOrigin, rejectCrossSite } from '@/lib/same-origin';

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://portal.test/api/console/user/invite', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('rejectCrossSite (C11)', () => {
  const original = process.env.PUBLIC_PORTAL_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = original;
  });

  it('admits a same-origin JSON request', () => {
    delete process.env.PUBLIC_PORTAL_URL;
    expect(
      rejectCrossSite(req({ 'content-type': 'application/json', origin: 'http://portal.test' })),
    ).toBeNull();
  });

  it('admits a JSON request without Origin when Sec-Fetch-Site is same-origin', () => {
    expect(
      rejectCrossSite(req({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' })),
    ).toBeNull();
  });

  it('refuses another origin with 403', () => {
    const res = rejectCrossSite(
      req({ 'content-type': 'application/json', origin: 'https://evil.example' }),
    );
    expect(res?.status).toBe(403);
  });

  it('refuses a request with neither Origin nor a same-origin fetch site', () => {
    const res = rejectCrossSite(
      req({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }),
    );
    expect(res?.status).toBe(403);
  });

  it('refuses a form post (non-JSON) with 415', () => {
    const res = rejectCrossSite(
      req({ 'content-type': 'application/x-www-form-urlencoded', origin: 'http://portal.test' }),
    );
    expect(res?.status).toBe(415);
  });

  it('checks against PUBLIC_PORTAL_URL when set', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.example.org/some/path';
    const r = req({ 'content-type': 'application/json', origin: 'http://portal.test' });
    expect(expectedOrigin(r)).toBe('https://portal.example.org');
    expect(rejectCrossSite(r)?.status).toBe(403);
  });

  it('falls back to the request origin when PUBLIC_PORTAL_URL is malformed', () => {
    process.env.PUBLIC_PORTAL_URL = 'not a url';
    const r = req({ 'content-type': 'application/json', origin: 'http://portal.test' });
    expect(expectedOrigin(r)).toBe('http://portal.test');
    expect(rejectCrossSite(r)).toBeNull();
  });

  it('treats a missing content-type as non-JSON (415)', () => {
    const r = req({ origin: 'http://portal.test' });
    expect(rejectCrossSite(r)?.status).toBe(415);
  });
});
