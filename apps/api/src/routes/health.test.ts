import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Hoisted so the vi.mock factories can reference them (mocks are hoisted above
// module code).
const { dbExecute, redisPing } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  redisPing: vi.fn(),
}));

vi.mock('../db/client.js', () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock('../services/redis/index.js', () => ({ getRedis: () => ({ ping: redisPing }) }));

async function buildApp() {
  const { registerHealthRoutes } = await import('./health.js');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerHealthRoutes(app);
  await app.ready();
  return app;
}

describe('health routes', () => {
  beforeEach(() => {
    vi.resetModules();
    dbExecute.mockReset();
    redisPing.mockReset();
  });

  it('GET /health/live returns 200 ok without touching dependencies', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(dbExecute).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /health/ready returns 200 ready when Postgres + Redis are healthy', async () => {
    dbExecute.mockResolvedValue([{ ok: 1 }]);
    redisPing.mockResolvedValue('PONG');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('GET /health/ready returns 503 naming the failing dependency', async () => {
    dbExecute.mockResolvedValue([{ ok: 1 }]);
    redisPing.mockRejectedValue(new Error('redis down'));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'error' } });
    await app.close();
  });
});
