/**
 * Unit tests for the worker's lazy SignalStack writer factory.
 *
 * `HttpSignalStackWriter` is mocked so no real HTTP client is constructed —
 * only the opt-in enable/disable wiring and singleton caching in
 * `getSignalStackWriter()` is under test. Each test re-imports the module
 * fresh (`vi.resetModules()`) since the enabled/disabled decision is made
 * once at first call and cached at module scope.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const writerCtorCalls: unknown[] = [];
vi.mock('@aggregator-dpg/signalstack-writer/http', () => ({
  // vitest 4 requires a *constructible* implementation for a mock invoked with
  // `new` — an arrow function throws "is not a constructor".
  HttpSignalStackWriter: vi.fn(function (opts: unknown) {
    writerCtorCalls.push(opts);
    return { __fakeWriter: true, opts };
  }),
}));

const warnLog = vi.fn();
vi.mock('../logger.js', () => ({ logger: { warn: warnLog, info: vi.fn(), error: vi.fn() } }));

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
  writerCtorCalls.length = 0;
  warnLog.mockClear();
  configMock = {
    SIGNALSTACK_BASE_URL: undefined,
    SIGNALSTACK_ADMIN_KEY: undefined,
    SIGNALSTACK_TIMEOUT_MS: 10_000,
  };
});

describe('getSignalStackWriter', () => {
  it('returns null when both SIGNALSTACK_BASE_URL and SIGNALSTACK_ADMIN_KEY are unset (push disabled)', async () => {
    const { getSignalStackWriter } = await import('./signalstack.js');

    expect(getSignalStackWriter()).toBeNull();
    expect(writerCtorCalls).toHaveLength(0);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('warns and returns null when base URL is set but the admin key is missing', async () => {
    configMock.SIGNALSTACK_BASE_URL = 'https://signalstack.example.org';
    const { getSignalStackWriter } = await import('./signalstack.js');

    expect(getSignalStackWriter()).toBeNull();
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'warn', sub: 'signalstack.init' }),
    );
  });

  it('constructs a writer with baseUrl/apiKey/timeoutMs when both are set', async () => {
    configMock.SIGNALSTACK_BASE_URL = 'https://signalstack.example.org';
    configMock.SIGNALSTACK_ADMIN_KEY = 'admin-key-1';
    configMock.SIGNALSTACK_TIMEOUT_MS = 5_000;
    const { getSignalStackWriter } = await import('./signalstack.js');

    const writer = getSignalStackWriter();

    expect(writer).not.toBeNull();
    expect(writerCtorCalls).toEqual([
      { baseUrl: 'https://signalstack.example.org', apiKey: 'admin-key-1', timeoutMs: 5_000 },
    ]);
  });

  it('caches the writer — a second call reuses the same instance', async () => {
    configMock.SIGNALSTACK_BASE_URL = 'https://signalstack.example.org';
    configMock.SIGNALSTACK_ADMIN_KEY = 'admin-key-1';
    const { getSignalStackWriter } = await import('./signalstack.js');

    const first = getSignalStackWriter();
    const second = getSignalStackWriter();

    expect(second).toBe(first);
    expect(writerCtorCalls).toHaveLength(1);
  });

  it('caches a disabled (null) decision too — a second call does not re-check config', async () => {
    const { getSignalStackWriter } = await import('./signalstack.js');

    expect(getSignalStackWriter()).toBeNull();
    // Flip config after the first (cached) decision — should have no effect.
    configMock.SIGNALSTACK_BASE_URL = 'https://signalstack.example.org';
    configMock.SIGNALSTACK_ADMIN_KEY = 'admin-key-1';

    expect(getSignalStackWriter()).toBeNull();
    expect(writerCtorCalls).toHaveLength(0);
  });
});

describe('_setSignalStackWriter', () => {
  it('injects a fake writer, overriding the config-derived decision', async () => {
    const { getSignalStackWriter, _setSignalStackWriter } = await import('./signalstack.js');
    const fake = { __testFake: true } as unknown as ReturnType<typeof getSignalStackWriter>;

    _setSignalStackWriter(fake);

    expect(getSignalStackWriter()).toBe(fake);
    expect(writerCtorCalls).toHaveLength(0);
  });

  it('injects null to force-disable regardless of config', async () => {
    configMock.SIGNALSTACK_BASE_URL = 'https://signalstack.example.org';
    configMock.SIGNALSTACK_ADMIN_KEY = 'admin-key-1';
    const { getSignalStackWriter, _setSignalStackWriter } = await import('./signalstack.js');

    _setSignalStackWriter(null);

    expect(getSignalStackWriter()).toBeNull();
    expect(writerCtorCalls).toHaveLength(0);
  });
});
