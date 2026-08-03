import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * OpenAPI generation smoke test. Guards the documented contract surface:
 * the spec must build without serializer/transform errors, cover every
 * operation, carry request bodies on the body-taking routes, and keep the
 * intentional non-JSON exemptions (CSV/HTML replies) schema-free. A
 * regression here means the Scalar reference silently degrades.
 */
describe('OpenAPI spec generation', () => {
  let app: FastifyInstance;
  let spec: {
    paths: Record<
      string,
      Record<string, { requestBody?: unknown; responses?: Record<string, { content?: unknown }> }>
    >;
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    spec = app.swagger() as typeof spec;
  });

  afterAll(async () => {
    await app?.close();
  });

  const ops = () => {
    const out: Array<{
      method: string;
      path: string;
      op: { requestBody?: unknown; responses?: Record<string, { content?: unknown }> };
    }> = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          out.push({ method, path, op });
        }
      }
    }
    return out;
  };

  it('generates the full operation surface', () => {
    expect(ops().length).toBeGreaterThanOrEqual(28);
  });

  it('documents a request body on every body-taking route', () => {
    const expectBody = [
      ['post', '/v1/aggregator-registrations/create'],
      ['patch', '/v1/aggregators/profile/me'],
      ['post', '/v1/bulk-uploads'],
      ['post', '/v1/links/create'],
      ['patch', '/v1/links/{id}'],
      ['post', '/public/v1/aggregators/{orgSlug}/registrations/{slug}'],
    ] as const;
    for (const [method, path] of expectBody) {
      const op = spec.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path} missing`).toBeTruthy();
      expect(op?.requestBody, `${method.toUpperCase()} ${path} has no requestBody`).toBeTruthy();
    }
  });

  it('keeps non-JSON replies schema-free (CSV/HTML exemptions)', () => {
    const exempt = [
      ['get', '/v1/bulk-uploads/template'],
      ['get', '/v1/dashboard/export'],
      ['get', '/admin/v1/aggregator-registrations/read/{id}'],
      ['post', '/admin/v1/aggregator-registrations/decision/{id}'],
    ] as const;
    for (const [method, path] of exempt) {
      const op = spec.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path} missing`).toBeTruthy();
      const twoHundred = op?.responses?.['200'];
      expect(
        twoHundred?.content,
        `${method.toUpperCase()} ${path} must not declare a 200 JSON schema`,
      ).toBeFalsy();
    }
  });

  it('documents error envelopes on the dashboard + config routes', () => {
    for (const path of ['/v1/dashboard', '/v1/dashboard/items', '/v1/aggregator-config']) {
      const op = spec.paths[path]?.['get'];
      expect(op, `GET ${path} missing`).toBeTruthy();
      const codes = Object.keys(op?.responses ?? {});
      expect(
        codes.some((c) => c.startsWith('4') || c.startsWith('5')),
        `GET ${path} documents no error responses`,
      ).toBe(true);
    }
  });

  it('carries package version and a public server URL', async () => {
    const meta = spec as unknown as {
      info: { version: string };
      servers?: Array<{ url: string }>;
    };
    expect(meta.info.version).toBe(pkg.version);
    expect(meta.servers?.[0]?.url).toBeTruthy();
  });

  it('serves no docs surface when API_REFERENCE_ENABLED is false', async () => {
    const originalEnv = process.env.API_REFERENCE_ENABLED;
    process.env.API_REFERENCE_ENABLED = 'false';
    vi.resetModules();
    try {
      const { buildApp: buildAppGated } = await import('./app.js');
      const gatedApp = await buildAppGated();
      await gatedApp.ready();
      try {
        expect((gatedApp as unknown as { swagger?: unknown }).swagger).toBeUndefined();
        const res = await gatedApp.inject({ method: 'GET', url: '/api/reference' });
        expect(res.statusCode).toBe(404);
      } finally {
        await gatedApp.close();
      }
    } finally {
      if (originalEnv === undefined) {
        delete process.env.API_REFERENCE_ENABLED;
      } else {
        process.env.API_REFERENCE_ENABLED = originalEnv;
      }
      vi.resetModules();
    }
  });
});
