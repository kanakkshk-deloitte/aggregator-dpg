/**
 * Unit tests for the process-local network-config singleton.
 *
 * `@aggregator-dpg/network-config/loader` and `/paths` are mocked so no real
 * YAML file is read and no signalstack `network.json` fetch happens. Covers
 * the success/cache path, the in-flight de-dupe for concurrent callers, the
 * failure → thrown-Error path (including the `unknown error` fallbacks), and
 * the test-only override hook.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoad, mockLoaderCtor, mockLoggerError, mockLoggerInfo } = vi.hoisted(() => ({
  mockLoad: vi.fn(),
  mockLoaderCtor: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@aggregator-dpg/network-config/loader', () => ({
  FileNetworkConfigLoader: class {
    constructor(opts: unknown) {
      mockLoaderCtor(opts);
    }
    load = mockLoad;
  },
}));

vi.mock('@aggregator-dpg/network-config/paths', () => ({
  resolveConfigPath: () => '/app/config/aggregator.config.yaml',
}));

vi.mock('../../logger.js', () => ({
  logger: { error: mockLoggerError, info: mockLoggerInfo, warn: vi.fn(), debug: vi.fn() },
}));

const sampleConfig = {
  network: { id: 'blue_dot' },
  domainIds: ['seeker', 'provider'],
  aggregator: { brand: { short_name: 'Blue Dots' } },
};

describe('getNetworkConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoad.mockReset();
    mockLoaderCtor.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
    delete process.env.NETWORK_CONFIG_CACHE_DIR;
  });

  it('returns the resolved config on success and caches it across calls', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    const a = await getNetworkConfig();
    const b = await getNetworkConfig();
    expect(a).toBe(sampleConfig);
    expect(b).toBe(sampleConfig);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'network-config.load', status: 'success' }),
      expect.any(String),
    );
  });

  it('derives cacheDir from the config path dirname when NETWORK_CONFIG_CACHE_DIR is unset', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();
    expect(mockLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: '/app/config/aggregator.config.yaml',
        cacheDir: '/app/config/.cache',
      }),
    );
  });

  it('honours NETWORK_CONFIG_CACHE_DIR when set', async () => {
    process.env.NETWORK_CONFIG_CACHE_DIR = '/custom/cache';
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();
    expect(mockLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ cacheDir: '/custom/cache' }),
    );
  });

  it('de-dupes concurrent callers onto a single in-flight load', async () => {
    let resolveLoad: (v: unknown) => void = () => undefined;
    mockLoad.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { getNetworkConfig } = await import('../network-config.js');
    const p1 = getNetworkConfig();
    const p2 = getNetworkConfig();
    resolveLoad({ success: true, value: sampleConfig });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(sampleConfig);
    expect(b).toBe(sampleConfig);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoaderCtor).toHaveBeenCalledTimes(1);
  });

  it('throws with the loader-reported message on failure and logs it', async () => {
    mockLoad.mockResolvedValue({ success: false, error: { message: 'schema invalid' } });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).rejects.toThrow('network-config load failed: schema invalid');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'network-config.load',
        status: 'failure',
        error: 'schema invalid',
      }),
    );
  });

  it('falls back to "unknown error" when the error has no message', async () => {
    mockLoad.mockResolvedValue({ success: false, error: {} });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).rejects.toThrow('network-config load failed: unknown error');
  });

  it('falls back to "unknown error" when the error field is not an object', async () => {
    mockLoad.mockResolvedValue({ success: false, error: 'plain string error' });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).rejects.toThrow('network-config load failed: unknown error');
  });

  it('falls back to "unknown error" when the failure result has no error field at all', async () => {
    mockLoad.mockResolvedValue({ success: false });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).rejects.toThrow('network-config load failed: unknown error');
  });

  it('a subsequent call after a failure retries the load (not cached)', async () => {
    mockLoad.mockResolvedValueOnce({ success: false, error: { message: 'boom' } });
    mockLoad.mockResolvedValueOnce({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).rejects.toThrow(/boom/);
    const result = await getNetworkConfig();
    expect(result).toBe(sampleConfig);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('_setNetworkConfig injects a fixed config, bypassing the loader entirely', async () => {
    const { getNetworkConfig, _setNetworkConfig } = await import('../network-config.js');
    _setNetworkConfig(sampleConfig as never);
    const result = await getNetworkConfig();
    expect(result).toBe(sampleConfig);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('_setNetworkConfig(null) forces a fresh load on the next call', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig, _setNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();
    _setNetworkConfig(null);
    await getNetworkConfig();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});
