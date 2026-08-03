/**
 * Liveness and readiness probes consumed by container orchestrators and the
 * compose healthcheck.
 *
 * `/health/live` is pure process-liveness. `/health/ready` actively probes the
 * backing Postgres and Redis so an orchestrator does not route traffic to (or
 * mark healthy) an instance that cannot actually serve requests.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getRedis } from '../services/redis/index.js';

const LiveResponseSchema = z.object({ status: z.literal('ok') });
const ReadyResponseSchema = z.object({ status: z.literal('ready') });
const NotReadyResponseSchema = z.object({
  status: z.literal('not_ready'),
  checks: z.object({ postgres: z.string(), redis: z.string() }),
});

/**
 * Runs a dependency check with a hard timeout, collapsing any failure
 * (rejection or timeout) to `'error'`. Keeps the readiness probe from hanging on
 * a wedged Postgres/Redis connection — satisfies the repo's external-call
 * timeout rule.
 *
 * @param fn - The dependency call to run (e.g. a `select 1` or a Redis `ping`).
 * @param ms - Timeout in milliseconds (default 2000).
 * @returns `'ok'` if it resolved in time, `'error'` otherwise.
 */
async function probe(fn: () => Promise<unknown>, ms = 2000): Promise<'ok' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Returns 200 as long as the process is up — used by Docker healthcheck.',
        response: { 200: LiveResponseSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description: 'Returns 200 only when Postgres and Redis are both reachable; 503 otherwise.',
        response: { 200: ReadyResponseSchema, 503: NotReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const [postgres, redis] = await Promise.all([
        probe(() => getDb().execute(sql`select 1`)),
        probe(() => getRedis().ping()),
      ]);
      if (postgres === 'ok' && redis === 'ok') {
        return reply.code(200).send({ status: 'ready' as const });
      }
      return reply.code(503).send({ status: 'not_ready' as const, checks: { postgres, redis } });
    },
  );
}
