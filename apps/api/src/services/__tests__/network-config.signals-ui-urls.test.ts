/**
 * Covers the `SIGNALS_UI_URLS` ↔ declared-domains cross-check.
 *
 * The env var is parsed at module load, when no network config exists yet, so
 * a key is only validated for *format* there — `seekr=…` parses clean and then
 * silently disables the `seeker` hand-off. `getNetworkConfig`'s success path is
 * the first point in the process where both halves are known, so the warning
 * is emitted there. Kept in its own file (with its own logger mock) so the
 * sibling `network-config.test.ts` is untouched.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoad, mockLoggerWarn } = vi.hoisted(() => {
  process.env.SIGNALS_UI_URLS =
    'seeker=https://signals-seeker.example/auth/login,seekr=https://typo.example/auth/login';
  return { mockLoad: vi.fn(), mockLoggerWarn: vi.fn() };
});

vi.mock('@aggregator-dpg/network-config/loader', () => ({
  FileNetworkConfigLoader: class {
    load = mockLoad;
  },
}));

vi.mock('@aggregator-dpg/network-config/paths', () => ({
  resolveConfigPath: () => '/app/config/aggregator.config.yaml',
}));

vi.mock('../../logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, debug: vi.fn() },
}));

const sampleConfig = {
  network: { id: 'blue_dot' },
  domainIds: ['seeker', 'provider'],
  aggregator: { brand: { short_name: 'Blue Dots' } },
};

describe('getNetworkConfig SIGNALS_UI_URLS domain cross-check', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoad.mockReset();
    mockLoggerWarn.mockReset();
  });

  it('warns once, naming the key that matches no declared domain', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();

    const calls = mockLoggerWarn.mock.calls.filter(
      (c) => (c[0] as { operation?: string }).operation === 'config.signalsUiUrls.domainCheck',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ status: 'unknown_domain', domain: 'seekr' });
    // The correctly spelled key must not be flagged.
    expect(JSON.stringify(calls[0])).not.toContain('"domain":"seeker"');
    expect(calls[0]![1]).toContain('seekr');
  });

  it('leaves the parsed map untouched — the check is log-only', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();
    const { signalsUiUrls } = await import('../../config.js');
    // Both entries survive, including the unknown one: a domain added to
    // network.json after the ConfigMap (or before it) must not lose its URL.
    expect(signalsUiUrls).toEqual({
      seeker: 'https://signals-seeker.example/auth/login',
      seekr: 'https://typo.example/auth/login',
    });
  });

  it('does not warn when every key matches a declared domain', async () => {
    mockLoad.mockResolvedValue({
      success: true,
      value: { ...sampleConfig, domainIds: ['seeker', 'seekr'] },
    });
    const { getNetworkConfig } = await import('../network-config.js');
    await getNetworkConfig();
    expect(
      mockLoggerWarn.mock.calls.filter(
        (c) => (c[0] as { operation?: string }).operation === 'config.signalsUiUrls.domainCheck',
      ),
    ).toHaveLength(0);
  });

  it('never rejects the load over an unknown key', async () => {
    mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
    const { getNetworkConfig } = await import('../network-config.js');
    await expect(getNetworkConfig()).resolves.toBe(sampleConfig);
  });
});
