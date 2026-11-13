import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { PATCH as patchKnownAs } from '@/app/api/console/org/known-as/[id]/route';
import { callApi } from '@/lib/upstream-client';

const ID = '00000000-0000-4000-8000-0000000000e1';
const same = { 'content-type': 'application/json', origin: 'http://portal.test' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = typeof patchKnownAs;

function call(handler: Handler, id: string, headers: Record<string, string>, body: string) {
  const req = new NextRequest(`http://portal.test/api/console/org/known-as/${id}`, {
    method: 'PATCH',
    headers,
    body,
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

const cases = [
  {
    name: 'known_as',
    handler: patchKnownAs,
    upstream: `/v1/org/known-as/update/${ID}`,
    body: { known_as: 'district' },
  },
  {
    name: 'known_as_values',
    handler: patchKnownAs,
    upstream: `/v1/org/known-as/update/${ID}`,
    body: {
      known_as_values: [
        { key: 'district', name: 'District' },
        { name: 'Block', default: true },
      ],
    },
  },
] as const;

describe.each(cases)(
  'PATCH /api/console/org/known-as/:id with $name',
  ({ handler, upstream, body }) => {
    beforeEach(() => {
      vi.clearAllMocks();
      delete process.env.PUBLIC_PORTAL_URL;
    });

    it('forwards the body with the caller token', async () => {
      vi.mocked(callApi).mockResolvedValue(json({ id: ID }));
      const res = await call(handler, ID, same, JSON.stringify(body));
      expect(res.status).toBe(200);
      expect(callApi).toHaveBeenCalledWith(upstream, { method: 'PATCH', body });
    });

    it('passes an error envelope through unchanged', async () => {
      const envelope = { error: { code: 'SCHEMA_VALIDATION', fields: { known_as: 'invalid' } } };
      vi.mocked(callApi).mockResolvedValue(json(envelope, 400));
      const res = await call(handler, ID, same, JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(envelope);
    });

    it('refuses a cross-site request without calling upstream', async () => {
      const res = await call(
        handler,
        ID,
        { 'content-type': 'application/json', origin: 'https://evil.test' },
        JSON.stringify(body),
      );
      expect(res.status).toBe(403);
      expect(callApi).not.toHaveBeenCalled();
    });

    it('refuses a body that is not JSON without calling upstream', async () => {
      const res = await call(handler, ID, { origin: 'http://portal.test' }, 'x');
      expect(res.status).toBe(415);
      expect(callApi).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed id without calling upstream', async () => {
      const res = await call(handler, '..%2Fadmin', same, JSON.stringify(body));
      expect(res.status).toBe(404);
      expect(callApi).not.toHaveBeenCalled();
    });
  },
);
