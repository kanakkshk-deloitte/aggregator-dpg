/**
 * Unit tests for the worker's resolved network-config singleton.
 *
 * `FileNetworkConfigLoader` and `resolveConfigPath` are mocked so no real
 * file I/O or network fetch happens — only the load/cache/error-wrapping
 * wiring in `getNetworkConfig()` is under test.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

const loadMock = vi.fn();
const loaderCtorCalls: unknown[] = [];

vi.mock('@aggregator-dpg/network-config/loader', () => ({
  // vitest 4 requires a *constructible* implementation for a mock invoked with
  // `new` — an arrow function throws "is not a constructor". `function` works and
  // still overrides `this` by returning an object.
  FileNetworkConfigLoader: vi.fn(function (opts: unknown) {
    loaderCtorCalls.push(opts);
    return { load: loadMock };
  }),
}));

vi.mock('@aggregator-dpg/network-config/paths', () => ({
  resolveConfigPath: () => '/app/config/blue_dot/aggregator.config.yaml',
}));

const errorLog = vi.fn();
const infoLog = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: infoLog, error: errorLog, warn: vi.fn() },
}));

const { getNetworkConfig, _setNetworkConfig } = await import('./network-config.js');

function fakeConfig(overrides: Partial<ResolvedNetworkConfig> = {}): ResolvedNetworkConfig {
  return {
    network: { id: 'blue_dot' } as ResolvedNetworkConfig['network'],
    domains: {},
    domainIds: [],
    ...overrides,
  } as ResolvedNetworkConfig;
}

beforeEach(() => {
  loadMock.mockReset();
  loaderCtorCalls.length = 0;
  errorLog.mockClear();
  infoLog.mockClear();
  _setNetworkConfig(null);
});

describe('getNetworkConfig', () => {
  it('loads and returns the resolved config on success', async () => {
    const cfg = fakeConfig({ domainIds: ['seeker', 'provider'] });
    loadMock.mockResolvedValueOnce({ success: true, value: cfg });

    const result = await getNetworkConfig();

    expect(result).toBe(cfg);
    expect(loaderCtorCalls[0]).toEqual({
      configPath: '/app/config/blue_dot/aggregator.config.yaml',
      cacheDir: '/app/config/blue_dot/.cache',
    });
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'network-config.load', status: 'success' }),
      expect.any(String),
    );
  });

  it('caches the resolved config — a second call does not reload', async () => {
    const cfg = fakeConfig();
    loadMock.mockResolvedValueOnce({ success: true, value: cfg });

    const first = await getNetworkConfig();
    const second = await getNetworkConfig();

    expect(second).toBe(first);
    expect(loadMock).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent in-flight loads into a single loader.load() call', async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    loadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const cfg = fakeConfig();

    const p1 = getNetworkConfig();
    const p2 = getNetworkConfig();
    resolveLoad({ success: true, value: cfg });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(cfg);
    expect(r2).toBe(cfg);
    expect(loadMock).toHaveBeenCalledOnce();
  });

  it('throws with the upstream error message and logs failure when the loader reports failure', async () => {
    loadMock.mockResolvedValueOnce({ success: false, error: { message: 'network.json 404' } });

    await expect(getNetworkConfig()).rejects.toThrow(
      /network-config load failed: network\.json 404/,
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'network-config.load', status: 'failure' }),
    );
  });

  it('falls back to "unknown error" when the error is not an object at all', async () => {
    loadMock.mockResolvedValueOnce({ success: false, error: 'plain string error' });

    await expect(getNetworkConfig()).rejects.toThrow(/network-config load failed: unknown error/);
  });

  it('falls back to "unknown error" when the error object has no message field', async () => {
    loadMock.mockResolvedValueOnce({ success: false, error: {} });

    await expect(getNetworkConfig()).rejects.toThrow(/network-config load failed: unknown error/);
  });

  it('does not cache a failed load — a subsequent call retries', async () => {
    loadMock.mockResolvedValueOnce({ success: false, error: { message: 'timeout' } });
    await expect(getNetworkConfig()).rejects.toThrow();

    const cfg = fakeConfig();
    loadMock.mockResolvedValueOnce({ success: true, value: cfg });
    const result = await getNetworkConfig();

    expect(result).toBe(cfg);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});

describe('_setNetworkConfig', () => {
  it('injects a fake config so getNetworkConfig() returns it without loading', async () => {
    const cfg = fakeConfig({ domainIds: ['seeker'] });
    _setNetworkConfig(cfg);

    const result = await getNetworkConfig();

    expect(result).toBe(cfg);
    expect(loadMock).not.toHaveBeenCalled();
  });
});
