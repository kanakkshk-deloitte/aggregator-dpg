/**
 * Tests for the onboarding metrics endpoints
 * (`GET /v1/onboarding/summary`, `GET /v1/onboarding/by-source`).
 *
 * Both routes are thin aggregation reads over the `onboarding` rollup table,
 * scoped to the caller's `aggregator_id` and optionally date-bounded by
 * `?from=&to=`. Covers the auth wrapper, the date-range query validation,
 * and both aggregation shapes.
 *
 * @module apps/api/routes/onboarding.test
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

interface SummaryRow {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface BySourceRow extends SummaryRow {
  source: string;
}

let summaryRows: SummaryRow[] = [];
let bySourceRows: BySourceRow[] = [];
let lastWhereCondition: unknown;

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => {
          lastWhereCondition = cond;
          return {
            then(onFulfilled: (v: SummaryRow[]) => unknown, onRejected?: (e: unknown) => unknown) {
              return Promise.resolve(summaryRows).then(onFulfilled, onRejected);
            },
            groupBy(_col: unknown) {
              return Promise.resolve(bySourceRows);
            },
          };
        },
      }),
    }),
  }),
}));

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('onboarding routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    summaryRows = [];
    bySourceRows = [];
    lastWhereCondition = undefined;

    _setAccessTokenVerifier(async (token) => {
      if (token === 'approved') {
        return { sub: 'kc-1', aggregator_id: AGG_A, decision_made: 'approved' };
      }
      if (token === 'pending') {
        return { sub: 'kc-1', aggregator_id: AGG_A, decision_made: 'pending' };
      }
      if (token === 'no-agg-id') {
        return { sub: 'kc-2', decision_made: 'approved' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
  });

  const AUTH = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('GET /v1/onboarding/summary', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/onboarding/summary' });
      expect(res.statusCode).toBe(401);
    });

    it('401s when the token has no aggregator_id claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('no-agg-id'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('403 NOT_APPROVED when decision_made is pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('pending'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_APPROVED');
    });

    it('400 SCHEMA_VALIDATION on a malformed `from` date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?from=not-a-date',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('400 SCHEMA_VALIDATION on a malformed `to` date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?to=2026-13-99',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s with zeroed counters when there are no rows', async () => {
      summaryRows = [];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        aggregator_id: AGG_A,
        from: null,
        to: null,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
      });
    });

    it('200s with the summed counters from the store', async () => {
      summaryRows = [{ total: 42, passed: 30, failed: 10, skipped: 2 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.total).toBe(42);
      expect(body.passed).toBe(30);
      expect(body.failed).toBe(10);
      expect(body.skipped).toBe(2);
    });

    it('echoes back the resolved from/to ISO bounds when supplied', async () => {
      summaryRows = [{ total: 1, passed: 1, failed: 0, skipped: 0 }];
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/onboarding/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { from: string; to: string };
      expect(body.from).toBe(from);
      expect(body.to).toBe(to);
      expect(lastWhereCondition).toBeDefined();
    });
  });

  describe('GET /v1/onboarding/by-source', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/onboarding/by-source' });
      expect(res.statusCode).toBe(401);
    });

    it('401s when the token has no aggregator_id claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('no-agg-id'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('403 NOT_APPROVED when decision_made is pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('pending'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 SCHEMA_VALIDATION on a malformed date range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source?from=nope',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s with an empty by_source array when there are no rows', async () => {
      bySourceRows = [];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { by_source: unknown[] };
      expect(body.by_source).toEqual([]);
    });

    it('200s with the per-source breakdown', async () => {
      bySourceRows = [
        { source: 'bulk', total: 10, passed: 8, failed: 2, skipped: 0 },
        { source: 'link', total: 5, passed: 5, failed: 0, skipped: 0 },
      ];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        aggregator_id: string;
        by_source: Array<{ source: string; total: number }>;
      };
      expect(body.aggregator_id).toBe(AGG_A);
      expect(body.by_source).toHaveLength(2);
      expect(body.by_source.find((r) => r.source === 'bulk')?.total).toBe(10);
      expect(body.by_source.find((r) => r.source === 'link')?.total).toBe(5);
    });

    it('applies the from/to bounds echoed in the response', async () => {
      bySourceRows = [{ source: 'bulk', total: 1, passed: 1, failed: 0, skipped: 0 }];
      const from = '2026-01-01T00:00:00.000Z';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/onboarding/by-source?from=${encodeURIComponent(from)}`,
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { from: string; to: string | null };
      expect(body.from).toBe(from);
      expect(body.to).toBeNull();
    });
  });
});
