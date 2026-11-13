import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendConsole, errorKey, setOrgKnownAs, setOrgKnownAsValues } from '@/lib/console-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sendConsole (console-client)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends JSON same-origin and returns ok with data', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: 'u1' }));
    const res = await sendConsole('/api/console/user/decision/u1', 'POST', { decision: 'approve' });
    expect(res).toEqual({ ok: true, status: 200, data: { id: 'u1' } });
    expect(global.fetch).toHaveBeenCalledWith('/api/console/user/decision/u1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ decision: 'approve' }),
    });
  });

  it('returns status 0 when fetch throws', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new TypeError('network down'));
    const res = await sendConsole('/api/console/user/x', 'PATCH', {});
    expect(res).toEqual({ ok: false, status: 0, error: {} });
  });

  it('returns the error envelope on a non-ok response', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'ORG_NAME_TAKEN' } }, 409));
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 409, error: { code: 'ORG_NAME_TAKEN' } });
  });

  it('falls back to an empty error when the error field is not an object', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: 'nope' }, 400));
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 400, error: {} });
  });

  it('falls back to an empty error when the body is not JSON', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 500, error: {} });
  });
});

describe('known_as calls (console-client)', () => {
  const ID = '00000000-0000-4000-8000-0000000000e1';
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('setOrgKnownAs sends the key to the known-as route', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ID }));
    const res = await setOrgKnownAs(ID, 'district');
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ID}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ known_as: 'district' }) }),
    );
  });

  it('setOrgKnownAsValues sends the list to the known-as route', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ID }));
    const values = [
      { key: 'district', name: 'District' },
      { name: 'Block', default: true as const },
    ];
    await setOrgKnownAsValues(ID, values);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ known_as_values: values }),
      }),
    );
  });
});

describe('errorKey (console-client)', () => {
  it('maps 429 to rate_limited', () => {
    expect(errorKey({ status: 429, error: {} })).toBe('errors.rate_limited');
  });
  it('maps 404 to not_found', () => {
    expect(errorKey({ status: 404, error: {} })).toBe('errors.not_found');
  });
  it('maps ORG_NAME_TAKEN to name_taken', () => {
    expect(errorKey({ status: 409, error: { code: 'ORG_NAME_TAKEN' } })).toBe('errors.name_taken');
  });
  it.each([
    ['ORG_DEPTH_LIMIT', 409, 'errors.depth_limit'],
    ['ORG_CHILD_LIMIT', 409, 'errors.child_limit'],
    ['ORG_TOTAL_LIMIT', 409, 'errors.total_limit'],
    ['ORG_PARENT_CYCLE', 400, 'errors.parent_cycle'],
  ])('maps %s', (code, status, key) => {
    expect(errorKey({ status, error: { code } })).toBe(key);
  });
  it('maps a CONFLICT by its reason', () => {
    expect(errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'busy' } } })).toBe(
      'errors.busy',
    );
    expect(
      errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'not_movable' } } }),
    ).toBe('errors.not_movable');
    expect(
      errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'moved' } } }),
    ).toBe('errors.org_moved');
    expect(errorKey({ status: 409, error: { code: 'CONFLICT' } })).toBe('errors.generic');
  });
  it('maps an invalid parent or known-as field', () => {
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { parent_id: 'invalid' } },
      }),
    ).toBe('errors.parent_invalid');
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { known_as: 'invalid' } },
      }),
    ).toBe('errors.known_as_invalid');
  });
  it('maps a known-as list key that is not saved to known_as_values_changed', () => {
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { known_as_values: 'unknown_key', index: 1 } },
      }),
    ).toBe('errors.known_as_values_changed');
  });
  it.each([
    [0, 'errors.network'],
    [401, 'errors.signed_out'],
    [403, 'errors.forbidden'],
    [500, 'errors.server'],
    [503, 'errors.server'],
  ])('maps status %i to a plain message', (status, key) => {
    expect(errorKey({ status, error: {} })).toBe(key);
  });

  it('falls back to generic', () => {
    expect(errorKey({ status: 400, error: { code: 'OTHER' } })).toBe('errors.generic');
    expect(errorKey({ status: 400, error: {} })).toBe('errors.generic');
  });
});
