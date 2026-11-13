/**
 * Unit tests for publishing the role catalogue to the edge's OPA sidecar
 * (`@aggregator-dpg/api`; docs/rbac/rbac-edge-enforcement.md §3.3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import {
  edgeCatalogue,
  publishEdgeCatalogue,
  publishSnapshotToEdge,
  type EdgeCatalogue,
  type EdgePublishOptions,
} from '../edge-catalogue.js';
import { shippedRoleIndex } from '../testing.js';
import { TEST_EDGE_FETCH_KEY, type EdgeFetchRecorder } from '../edge-test-hook.js';

afterEach(() => vi.restoreAllMocks());

const doc: EdgeCatalogue = {
  mode: 'log',
  revision: 'r1',
  roles: { coordinator: { permissions: ['profiles.view'] } },
};

/** A fetch that answers with `statuses` in turn and records each call. */
function fetchAnswering(...statuses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 500;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function options(fetchImpl: typeof fetch, retries = 1): EdgePublishOptions {
  return { baseUrl: 'http://opa:8181/', timeoutMs: 100, retries, backoffMs: 1, fetchImpl };
}

describe('edgeCatalogue', () => {
  it('lists every role of the snapshot with its permissions, in a stable order', async () => {
    const roles = await shippedRoleIndex([
      buildRole({ key: 'auditor', permissions: ['profiles.view', 'campaigns.run'] }),
    ]);
    const out = edgeCatalogue(roles, 'rev-7', 'enforce');
    expect(out.mode).toBe('enforce');
    expect(out.revision).toBe('rev-7');
    expect(Object.keys(out.roles)).toEqual([...Object.keys(out.roles)].sort());
    expect(out.roles['auditor']).toEqual({ permissions: ['campaigns.run', 'profiles.view'] });
    expect(out.roles['coordinator']?.permissions).toEqual(
      expect.arrayContaining(['profiles.onboard', 'profiles.view']),
    );
    expect(out.roles['network_admin']?.permissions).not.toContain('org.manage');
  });

  it('is empty for an empty snapshot', () => {
    const empty = { byKey: new Map(), base: {} } as unknown as Parameters<typeof edgeCatalogue>[0];
    expect(edgeCatalogue(empty, 'r0', 'log').roles).toEqual({});
  });
});

describe('publishEdgeCatalogue', () => {
  it('PUTs the document to data.catalogue', async () => {
    const { calls, fetchImpl } = fetchAnswering(204);
    const res = await publishEdgeCatalogue(doc, options(fetchImpl));
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://opa:8181/v1/data/catalogue');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(doc);
  });

  it('retries a transient failure, then succeeds', async () => {
    const { calls, fetchImpl } = fetchAnswering(503, 204);
    const res = await publishEdgeCatalogue(doc, options(fetchImpl));
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('gives up with OPA_UNAVAILABLE after the retries on a network error', async () => {
    const { calls, fetchImpl } = fetchAnswering(new Error('ECONNREFUSED'));
    const res = await publishEdgeCatalogue(doc, options(fetchImpl, 2));
    expect(calls).toHaveLength(3);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('OPA_UNAVAILABLE');
      expect(res.error.details).toMatchObject({ attempts: 3, error: 'Error: ECONNREFUSED' });
    }
  });

  it('does not retry a rejection and reports OPA_REJECTED', async () => {
    const { calls, fetchImpl } = fetchAnswering(400);
    const res = await publishEdgeCatalogue(doc, options(fetchImpl, 3));
    expect(calls).toHaveLength(1);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('OPA_REJECTED');
  });
});

describe('publishSnapshotToEdge', () => {
  /** The unit-test setup's recording fetch (src/test-setup.ts). */
  const recorder = () =>
    (globalThis as Record<string, unknown>)[TEST_EDGE_FETCH_KEY] as EdgeFetchRecorder;

  it('publishes nothing with RBAC off', async () => {
    expect(await publishSnapshotToEdge(await shippedRoleIndex(), 'r1', 'off')).toBe('off');
    expect(recorder().bodies).toHaveLength(0);
  });

  it('publishes the snapshot with the mode', async () => {
    expect(await publishSnapshotToEdge(await shippedRoleIndex(), 'r9', 'enforce')).toBe(
      'published',
    );
    const body = recorder().bodies[0] as EdgeCatalogue;
    expect(body.mode).toBe('enforce');
    expect(body.revision).toBe('r9');
  });

  it('reports a failure without throwing', async () => {
    recorder().fetch = (async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    expect(await publishSnapshotToEdge(await shippedRoleIndex(), 'r1', 'log')).toBe('failed');
  });
});
