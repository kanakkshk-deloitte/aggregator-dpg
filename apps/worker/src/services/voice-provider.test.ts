/**
 * Unit tests for the worker's lazy voice-provider factory.
 *
 * `@aggregator-dpg/voice-provider`'s `getVoiceProvider`/`acquireRayaSlot` and
 * `./redis.js`'s `getRedis` are mocked so no real HTTP/Redis client is
 * constructed — only the lazy-init, `RAYA_API_KEY` guard, and singleton
 * caching in this module's `getVoiceProvider()` is under test. Each test
 * re-imports the module fresh (`vi.resetModules()`) since the singleton is
 * cached at module scope.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildCalls: unknown[] = [];
const buildVoiceProviderMock = vi.fn().mockImplementation((opts: unknown) => {
  buildCalls.push(opts);
  return { __fakeProvider: true };
});
const acquireRayaSlotMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@aggregator-dpg/voice-provider', () => ({
  getVoiceProvider: buildVoiceProviderMock,
  acquireRayaSlot: acquireRayaSlotMock,
}));

const fakeRedis = { __fakeRedis: true };
const getRedisMock = vi.fn().mockReturnValue(fakeRedis);
vi.mock('./redis.js', () => ({ getRedis: getRedisMock }));

let configMock: Record<string, unknown>;
vi.mock('../config.js', () => ({
  config: new Proxy(
    {},
    {
      get(_t, prop: string) {
        return configMock[prop];
      },
    },
  ),
}));

beforeEach(() => {
  vi.resetModules();
  buildCalls.length = 0;
  buildVoiceProviderMock.mockClear();
  acquireRayaSlotMock.mockClear();
  getRedisMock.mockClear();
  configMock = {
    CAMPAIGN_VOICE_PROVIDER: 'raya',
    RAYA_BASE_URL: 'https://raya.example.com/api',
    RAYA_API_KEY: 'test-key',
    RAYA_TIMEOUT_MS: 15_000,
    RAYA_EGRESS_WINDOW_SECONDS: 20,
    RAYA_EGRESS_MAX: 1,
  };
});

describe('getVoiceProvider', () => {
  it('throws ConfigError when RAYA_API_KEY is unset', async () => {
    configMock.RAYA_API_KEY = undefined;
    const { getVoiceProvider } = await import('./voice-provider.js');

    expect(() => getVoiceProvider()).toThrow(/RAYA_API_KEY/);
    expect(buildVoiceProviderMock).not.toHaveBeenCalled();
  });

  it('builds the raya provider from config on first call', async () => {
    const { getVoiceProvider } = await import('./voice-provider.js');

    const provider = getVoiceProvider();

    expect(provider).toEqual({ __fakeProvider: true });
    expect(buildVoiceProviderMock).toHaveBeenCalledTimes(1);
    const opts = buildCalls[0] as Record<string, unknown>;
    expect(opts['provider']).toBe('raya');
    expect(opts['baseUrl']).toBe('https://raya.example.com/api');
    expect(opts['apiKey']).toBe('test-key');
    expect(opts['timeoutMs']).toBe(15_000);
    expect(typeof opts['acquireSlot']).toBe('function');
  });

  it('caches the provider — a second call does not rebuild it', async () => {
    const { getVoiceProvider } = await import('./voice-provider.js');

    const first = getVoiceProvider();
    const second = getVoiceProvider();

    expect(second).toBe(first);
    expect(buildVoiceProviderMock).toHaveBeenCalledTimes(1);
  });

  it('wires acquireSlot to acquireRayaSlot with the configured window/max over the shared Redis connection', async () => {
    const { getVoiceProvider } = await import('./voice-provider.js');

    getVoiceProvider();
    const opts = buildCalls[0] as { acquireSlot: () => Promise<void> };
    await opts.acquireSlot();

    expect(getRedisMock).toHaveBeenCalledTimes(1);
    expect(acquireRayaSlotMock).toHaveBeenCalledWith({
      redis: fakeRedis,
      windowSeconds: 20,
      max: 1,
    });
  });

  it('_setVoiceProvider injects a fake, and resetting to undefined forces reconstruction', async () => {
    const { getVoiceProvider, _setVoiceProvider } = await import('./voice-provider.js');

    const fake = { __injected: true } as never;
    _setVoiceProvider(fake);
    expect(getVoiceProvider()).toBe(fake);
    expect(buildVoiceProviderMock).not.toHaveBeenCalled();

    _setVoiceProvider(undefined);
    const rebuilt = getVoiceProvider();
    expect(rebuilt).toEqual({ __fakeProvider: true });
    expect(buildVoiceProviderMock).toHaveBeenCalledTimes(1);
  });
});
