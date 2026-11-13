import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { POST } from '@/app/api/console/user/decision/[id]/route';
import { callApi } from '@/lib/upstream-client';

const ID = '00000000-0000-4000-8000-0000000000c1';

function post(id: string, headers: Record<string, string>, body = '{"decision":"approve"}') {
  const req = new NextRequest(`http://portal.test/api/console/user/decision/${id}`, {
    method: 'POST',
    headers,
    body,
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

const same = { 'content-type': 'application/json', origin: 'http://portal.test' };

describe('POST /api/console/user/decision/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it('forwards the decision with the caller token', async () => {
    vi.mocked(callApi).mockResolvedValue(
      new Response(JSON.stringify({ id: ID, status: 'active', notified: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post(ID, same);
    expect(res.status).toBe(200);
    expect(callApi).toHaveBeenCalledWith(`/v1/user/decision/${ID}`, {
      method: 'POST',
      body: { decision: 'approve' },
    });
  });

  it('passes a 409 ALREADY_DECIDED through unchanged', async () => {
    const envelope = {
      error: { code: 'ALREADY_DECIDED', fields: { status: 'inactive', decided_by: 'link' } },
    };
    vi.mocked(callApi).mockResolvedValue(
      new Response(JSON.stringify(envelope), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post(ID, same);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(envelope);
  });

  it('refuses a cross-site request without calling upstream', async () => {
    const res = await post(ID, { 'content-type': 'application/json', origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id without calling upstream', async () => {
    const res = await post('..%2Fadmin', same);
    expect(res.status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('answers 401 when the session is gone', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('no active session'));
    const res = await post(ID, same);
    expect(res.status).toBe(401);
  });
});
