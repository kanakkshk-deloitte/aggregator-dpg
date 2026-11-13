import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { POST as assign } from '@/app/api/console/user/role/assign/[id]/route';
import { POST as revoke } from '@/app/api/console/user/role/revoke/[id]/route';
import { callApi } from '@/lib/upstream-client';

const ID = '00000000-0000-4000-8000-0000000000c1';
const ORG = '00000000-0000-4000-8000-00000000000a';
const same = { 'content-type': 'application/json', origin: 'http://portal.test' };
const BODY = JSON.stringify({ role_key: 'pii_access', org_id: ORG });

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function call(handler: Handler, id: string, headers: Record<string, string> = same) {
  const req = new NextRequest(`http://portal.test/api/console/x/${id}`, {
    method: 'POST',
    headers,
    body: BODY,
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const cases: Array<[string, Handler, string]> = [
  ['assign', assign, `/v1/user/role/assign/${ID}`],
  ['revoke', revoke, `/v1/user/role/revoke/${ID}`],
];

describe('console role BFF routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it.each(cases)('%s forwards with the caller token', async (_n, h, path) => {
    vi.mocked(callApi).mockResolvedValue(ok({ ok: true }));
    const res = await call(h, ID);
    expect(res.status).toBe(200);
    expect(callApi).toHaveBeenCalledWith(path, { method: 'POST', body: JSON.parse(BODY) });
  });

  it.each(cases)('%s refuses a cross-site request', async (_n, h) => {
    const res = await call(h, ID, {
      'content-type': 'application/json',
      origin: 'https://evil.test',
    });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it.each(cases)('%s answers 404 for a malformed id', async (_n, h) => {
    const res = await call(h, 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('passes a 409 refusal through unchanged', async () => {
    const envelope = { error: { code: 'ROLE_ASSIGNMENT_NOT_ALLOWED', fields: { reason: 'self' } } };
    vi.mocked(callApi).mockResolvedValue(ok(envelope, 409));
    const res = await call(assign, ID);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(envelope);
  });
});
