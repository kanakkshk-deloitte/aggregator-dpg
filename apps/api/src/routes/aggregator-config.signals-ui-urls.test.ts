/**
 * Proves `GET /v1/aggregator-config` really serves the parsed
 * `SIGNALS_UI_URLS` map rather than a hardcoded `{}`.
 *
 * The sibling `aggregator-config.test.ts` can only assert the empty case — the
 * suite runs with the env var unset — and an empty object is exactly what a
 * broken wiring would also return. So this file sets the env var *before*
 * `config.ts` snapshots it (hence `vi.hoisted`, which runs ahead of the
 * hoisted ESM imports) and asserts the real values arrive on the wire, with
 * one deliberately malformed entry to show the route serves the survivors.
 *
 * @module apps/api/routes/aggregator-config.signals-ui-urls.test
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.SIGNALS_UI_URLS =
    'seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login,broken=not-a-url';
});

const { buildApp } = await import('../app.js');
const { _setNetworkConfig } = await import('../services/network-config.js');
const { buildBlueDotConfig } = await import('@aggregator-dpg/network-config/testing');

describe('GET /v1/aggregator-config — signals_ui_urls wiring', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    _setNetworkConfig(buildBlueDotConfig());
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setNetworkConfig(null);
    delete process.env.SIGNALS_UI_URLS;
  });

  it('serves every parsed domain=url pair from the env var', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { signals_ui_urls: Record<string, string> };
    expect(body.signals_ui_urls).toEqual({
      seeker: 'https://signals-seeker.example/auth/login',
      provider: 'https://signals-provider.example/auth/login',
    });
  });

  it('omits the malformed entry instead of serving an unvalidated URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as { signals_ui_urls: Record<string, string> };
    // `broken=not-a-url` was skipped at boot; the client must never see a
    // value it would put straight into an href.
    expect(body.signals_ui_urls.broken).toBeUndefined();
  });
});
