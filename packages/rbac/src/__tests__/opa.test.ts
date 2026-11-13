import { describe, expect, it } from 'vitest';
import { OpaAuthorizer } from '../opa/index.js';
import { buildActor } from '../testing/index.js';
import type { DecisionInput } from '../interface.js';

const input: DecisionInput = { capability: 'profiles.view', actor: buildActor(), org: null };

function engine(responses: Array<Response | Error>, retries = 1) {
  const seen: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(init);
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const authz = new OpaAuthorizer({
    baseUrl: 'http://opa:8181/',
    timeoutMs: 50,
    retries,
    backoffMs: 1,
    fetchImpl,
  });
  return { authz, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OpaAuthorizer', () => {
  it('returns the decision and sends the input', async () => {
    const { authz, seen } = engine([json({ result: { allow: true, reasons: [] } })]);
    const res = await authz.decide(input);
    expect(res).toEqual({ success: true, value: { allow: true, reasons: [] } });
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ input });
  });

  it('retries a 503 and then succeeds', async () => {
    const { authz, seen } = engine([
      new Response('', { status: 503 }),
      json({ result: { allow: false, reasons: ['no_reach'] } }),
    ]);
    const res = await authz.decide(input);
    expect(res.success && res.value.reasons).toEqual(['no_reach']);
    expect(seen).toHaveLength(2);
  });

  it('returns OPA_UNAVAILABLE after network errors exhaust the retries', async () => {
    const { authz, seen } = engine([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
    const res = await authz.decide(input);
    expect(res.success).toBe(false);
    expect(!res.success && res.error.code).toBe('OPA_UNAVAILABLE');
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 400 and returns OPA_REJECTED', async () => {
    const { authz, seen } = engine([new Response('', { status: 400 })]);
    const res = await authz.decide(input);
    expect(!res.success && res.error.code).toBe('OPA_REJECTED');
    expect(seen).toHaveLength(1);
  });

  it('returns OPA_BAD_RESPONSE when the policy is not loaded', async () => {
    const { authz } = engine([json({})]);
    const res = await authz.decide(input);
    expect(!res.success && res.error.code).toBe('OPA_BAD_RESPONSE');
  });

  it('returns OPA_BAD_RESPONSE for a non-JSON body', async () => {
    const { authz } = engine([new Response('not json', { status: 200 })]);
    const res = await authz.decide(input);
    expect(!res.success && res.error.code).toBe('OPA_BAD_RESPONSE');
  });

  it('times out a hung sidecar', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const authz = new OpaAuthorizer({
      baseUrl: 'http://opa',
      timeoutMs: 10,
      retries: 0,
      backoffMs: 1,
      fetchImpl,
    });
    const res = await authz.decide(input);
    expect(!res.success && res.error.code).toBe('OPA_UNAVAILABLE');
  });

  it('lists capabilities from the capabilities rule, sorted', async () => {
    const { authz, seen } = engine([json({ result: ['profiles.view', 'org.manage'] })]);
    const res = await authz.listCapabilities({
      actor: buildActor(),
      candidates: ['profiles.view'],
      org: null,
    });
    expect(res).toEqual({ success: true, value: ['org.manage', 'profiles.view'] });
    expect(JSON.parse(String(seen[0]?.body)).input.candidates).toEqual(['profiles.view']);
  });

  it('rejects an unknown capability in the list', async () => {
    const { authz } = engine([json({ result: ['profiles.teleport'] })]);
    const res = await authz.listCapabilities({ actor: buildActor(), candidates: [], org: null });
    expect(!res.success && res.error.code).toBe('OPA_BAD_RESPONSE');
  });
});
