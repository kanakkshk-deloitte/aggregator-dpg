import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { isUuid, consoleMutation, invalidIdResponse } from '@/lib/console-proxy';
import { callApi } from '@/lib/upstream-client';

const UUID = '11111111-2222-3333-4444-555555555555';

function req(opts: { headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  const headers = {
    'content-type': 'application/json',
    origin: 'http://portal.test',
    ...opts.headers,
  };
  return new NextRequest('http://portal.test/api/console/user/decision/x', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { decision: 'approve' }),
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('isUuid', () => {
  it('accepts a UUID', () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it('rejects a non-UUID', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('invalidIdResponse', () => {
  it('is a 404 NOT_FOUND envelope', async () => {
    const res = invalidIdResponse();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: { code: 'NOT_FOUND', title: 'Not found' } });
  });
});

describe('consoleMutation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the upstream response on success', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ ok: true }, 200));
    const res = await consoleMutation(req(), {
      method: 'POST',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(callApi).toHaveBeenCalledWith(`/v1/user/decision/${UUID}`, {
      method: 'POST',
      body: { decision: 'approve' },
    });
  });

  it('passes a 409 ALREADY_DECIDED envelope through unchanged', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'ALREADY_DECIDED' } }, 409));
    const res = await consoleMutation(req(), {
      method: 'PATCH',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: { code: 'ALREADY_DECIDED' } });
  });

  it('refuses a cross-site request before calling upstream', async () => {
    const res = await consoleMutation(req({ headers: { origin: 'https://evil.example' } }), {
      method: 'POST',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a non-JSON request with 415', async () => {
    const r = new NextRequest('http://portal.test/api/console/user/decision/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://portal.test' },
      body: 'nope',
    });
    const res = await consoleMutation(r, {
      method: 'POST',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(415);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('returns a 400 when the JSON body is malformed', async () => {
    const r = new NextRequest('http://portal.test/api/console/user/decision/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://portal.test' },
      body: '{bad',
    });
    const res = await consoleMutation(r, {
      method: 'POST',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(400);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('maps a thrown upstream error to the proxy failure response', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('socket hang up'));
    const res = await consoleMutation(req(), {
      method: 'POST',
      path: `/v1/user/decision/${UUID}`,
      service: 'user',
    });
    expect(res.status).toBe(503);
  });
});
