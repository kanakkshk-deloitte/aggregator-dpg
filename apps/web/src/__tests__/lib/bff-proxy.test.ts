/**
 * Tests for the shared authenticated-BFF proxy plumbing.
 *
 * These helpers were extracted from twelve route files, so a regression here
 * would silently change the contract of every session-backed BFF route.
 */

import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { passthrough, isNoSession, proxyFailureResponse, readJsonBody } from '../../lib/bff-proxy';

describe('passthrough', () => {
  it('forwards a JSON body and its status', async () => {
    const upstream = new Response(JSON.stringify({ items: [1, 2] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await passthrough(upstream);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [1, 2] });
  });

  it('preserves a non-2xx upstream status', async () => {
    const upstream = new Response(JSON.stringify({ error: 'Conflict' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
    const res = await passthrough(upstream);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Conflict' });
  });

  it('relays a non-JSON body with its original content type', async () => {
    const upstream = new Response('id,name\n1,a', {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
    const res = await passthrough(upstream);
    expect(res.headers.get('content-type')).toBe('text/csv');
    await expect(res.text()).resolves.toBe('id,name\n1,a');
  });

  it('defaults a missing content type to text/plain', async () => {
    const upstream = new Response('plain', { status: 200, headers: {} });
    upstream.headers.delete('content-type');
    const res = await passthrough(upstream);
    expect(res.headers.get('content-type')).toBe('text/plain');
  });
});

describe('isNoSession', () => {
  it('recognises the no-active-session error', () => {
    expect(isNoSession(new Error('no active session'))).toBe(true);
  });

  it('rejects any other error', () => {
    expect(isNoSession(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isNoSession('no active session')).toBe(false);
    expect(isNoSession(undefined)).toBe(false);
  });
});

describe('proxyFailureResponse', () => {
  it('maps a missing session onto the standard 401', async () => {
    const res = proxyFailureResponse(new Error('no active session'), 'links');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_ACTIVE_SESSION' });
  });

  it('maps any other error onto a 503 carrying the service label', async () => {
    const res = proxyFailureResponse(new Error('socket hang up'), 'bulk-uploads');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: 'BULK_UPLOADS_UPSTREAM_FAILED',
      detail: 'socket hang up',
    });
  });

  it('falls back to "unknown error" for a non-Error throw', async () => {
    const res = proxyFailureResponse('boom', 'links');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ detail: 'unknown error' });
  });
});

describe('readJsonBody', () => {
  it('returns the parsed body on success', async () => {
    const req = { json: () => Promise.resolve({ a: 1 }) } as unknown as NextRequest;
    const result = await readJsonBody(req);
    expect(result).toEqual({ ok: true, body: { a: 1 } });
  });

  it('returns a ready 400 when the body is not JSON', async () => {
    const req = { json: () => Promise.reject(new SyntaxError('bad')) } as unknown as NextRequest;
    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: 'BadRequest',
        message: 'invalid JSON',
      });
    }
  });
});
