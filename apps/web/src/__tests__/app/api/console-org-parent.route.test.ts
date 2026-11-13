import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { PATCH } from '@/app/api/console/org/parent/[id]/route';
import { GET } from '@/app/api/console/org/parent/options/[id]/route';
import { callApi } from '@/lib/upstream-client';

const ID = '00000000-0000-4000-8000-0000000000e1';
const same = { 'content-type': 'application/json', origin: 'http://portal.test' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function patch(id: string, headers: Record<string, string>, body = '{"parent_id":"p"}') {
  const req = new NextRequest(`http://portal.test/api/console/org/parent/${id}`, {
    method: 'PATCH',
    headers,
    body,
  });
  return PATCH(req, { params: Promise.resolve({ id }) });
}

function get(id: string) {
  const req = new NextRequest(`http://portal.test/api/console/org/parent/options/${id}`);
  return GET(req, { params: Promise.resolve({ id }) });
}

describe('PATCH /api/console/org/parent/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it('forwards the move with the caller token', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: ID }));
    const res = await patch(ID, same);
    expect(res.status).toBe(200);
    expect(callApi).toHaveBeenCalledWith(`/v1/org/parent/update/${ID}`, {
      method: 'PATCH',
      body: { parent_id: 'p' },
    });
  });

  it('passes a 409 through unchanged', async () => {
    const envelope = { error: { code: 'CONFLICT', fields: { reason: 'busy' } } };
    vi.mocked(callApi).mockResolvedValue(json(envelope, 409));
    const res = await patch(ID, same);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(envelope);
  });

  it('refuses a cross-site request without calling upstream', async () => {
    const res = await patch(ID, {
      'content-type': 'application/json',
      origin: 'https://evil.test',
    });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id without calling upstream', async () => {
    const res = await patch('..%2Fadmin', same);
    expect(res.status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('GET /api/console/org/parent/options/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the options with the caller token', async () => {
    const body = { subtree_size: 1, options: [] };
    vi.mocked(callApi).mockResolvedValue(json(body));
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(callApi).toHaveBeenCalledWith(`/v1/org/parent/options/${ID}`, { method: 'GET' });
  });

  it('answers 404 for a malformed id without calling upstream', async () => {
    const res = await get('nope');
    expect(res.status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('answers 401 when the session is gone', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('no active session'));
    const res = await get(ID);
    expect(res.status).toBe(401);
  });
});
