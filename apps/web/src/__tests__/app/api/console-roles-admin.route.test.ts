import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
vi.mock('@/lib/features.server', () => ({ customRolesEnabled: vi.fn() }));

import { POST as create } from '@/app/api/console/roles/create/route';
import { PATCH as update } from '@/app/api/console/roles/update/[key]/route';
import { POST as remove } from '@/app/api/console/roles/delete/[key]/route';
import { callApi } from '@/lib/upstream-client';
import { customRolesEnabled } from '@/lib/features.server';

const same = { 'content-type': 'application/json', origin: 'http://portal.test' };
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const req = (method: string, body = '{}', headers: Record<string, string> = same) =>
  new NextRequest('http://portal.test/api/console/roles/x', { method, headers, body });
const params = (key: string) => ({ params: Promise.resolve({ key }) });

describe('console custom-role BFF routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
    // Custom roles on by default; the disabled path overrides this.
    vi.mocked(customRolesEnabled).mockResolvedValue(true);
  });

  it('forwards create, update and delete with the caller token', async () => {
    // A fresh Response per call: a body can be read once.
    vi.mocked(callApi).mockImplementation(async () => ok({ ok: true }));
    expect((await create(req('POST', '{"key":"v"}'))).status).toBe(200);
    expect(callApi).toHaveBeenLastCalledWith('/v1/roles/create', {
      method: 'POST',
      body: { key: 'v' },
    });
    expect((await update(req('PATCH', '{"name":"V"}'), params('verifier'))).status).toBe(200);
    expect(callApi).toHaveBeenLastCalledWith('/v1/roles/update/verifier', {
      method: 'PATCH',
      body: { name: 'V' },
    });
    expect((await remove(req('POST'), params('verifier'))).status).toBe(200);
    expect(callApi).toHaveBeenLastCalledWith('/v1/roles/delete/verifier', {
      method: 'POST',
      body: {},
    });
  });

  it('answers 404 for a malformed role key without calling upstream', async () => {
    expect((await update(req('PATCH'), params('../admin'))).status).toBe(404);
    expect((await remove(req('POST'), params('Bad Key'))).status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a cross-site request', async () => {
    const res = await create(
      req('POST', '{}', { 'content-type': 'application/json', origin: 'https://evil.test' }),
    );
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('answers 404 without calling upstream when custom roles are off', async () => {
    vi.mocked(customRolesEnabled).mockResolvedValue(false);
    expect((await create(req('POST', '{"key":"v"}'))).status).toBe(404);
    expect((await update(req('PATCH', '{"name":"V"}'), params('verifier'))).status).toBe(404);
    expect((await remove(req('POST'), params('verifier'))).status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });
});
