/**
 * Unit tests for the lazy SignalStack writer factory.
 *
 * `@aggregator-dpg/signalstack-writer/http` and `../config.js` are mocked so
 * no real HTTP client is constructed and each test controls the
 * `SIGNALSTACK_*` env-derived config directly. Covers the disabled (no
 * base-url/api-key) path, the acting-org-id warning, singleton caching, and
 * the test-only override hook.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHttpWriterCtor, mockLoggerWarn } = vi.hoisted(() => ({
  mockHttpWriterCtor: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@aggregator-dpg/signalstack-writer/http', () => ({
  HttpSignalStackWriter: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      mockHttpWriterCtor(opts);
    }
  },
}));

vi.mock('../logger.js', () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let mockConfig: {
  SIGNALSTACK_BASE_URL: string | undefined;
  SIGNALSTACK_ADMIN_KEY: string | undefined;
  SIGNALSTACK_ACTING_ORG_ID: string | undefined;
  SIGNALSTACK_TIMEOUT_MS: number;
};

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

describe('getSignalStackWriter', () => {
  beforeEach(() => {
    vi.resetModules();
    mockHttpWriterCtor.mockReset();
    mockLoggerWarn.mockReset();
    mockConfig = {
      SIGNALSTACK_BASE_URL: undefined,
      SIGNALSTACK_ADMIN_KEY: undefined,
      SIGNALSTACK_ACTING_ORG_ID: undefined,
      SIGNALSTACK_TIMEOUT_MS: 10_000,
    };
  });

  it('returns null when neither base url nor key is set', async () => {
    const { getSignalStackWriter } = await import('./signalstack.js');
    expect(getSignalStackWriter()).toBeNull();
    expect(mockHttpWriterCtor).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('returns null and warns when base url is set but the admin key is missing', async () => {
    mockConfig.SIGNALSTACK_BASE_URL = 'https://signalstack.example.com';
    const { getSignalStackWriter } = await import('./signalstack.js');
    expect(getSignalStackWriter()).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'signalstack.init' }),
    );
  });

  it('returns null without warning when only the key is set (no base url)', async () => {
    mockConfig.SIGNALSTACK_ADMIN_KEY = 'key-1';
    const { getSignalStackWriter } = await import('./signalstack.js');
    expect(getSignalStackWriter()).toBeNull();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('builds the writer and warns when acting org id is unset', async () => {
    mockConfig.SIGNALSTACK_BASE_URL = 'https://signalstack.example.com';
    mockConfig.SIGNALSTACK_ADMIN_KEY = 'key-1';
    const { getSignalStackWriter } = await import('./signalstack.js');
    const writer = getSignalStackWriter();
    expect(writer).not.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'signalstack.init' }),
    );
    expect(mockHttpWriterCtor).toHaveBeenCalledWith({
      baseUrl: 'https://signalstack.example.com',
      apiKey: 'key-1',
      timeoutMs: 10_000,
    });
  });

  it('builds the writer including actingOrgId when set, without the warning', async () => {
    mockConfig.SIGNALSTACK_BASE_URL = 'https://signalstack.example.com';
    mockConfig.SIGNALSTACK_ADMIN_KEY = 'key-1';
    mockConfig.SIGNALSTACK_ACTING_ORG_ID = 'org-1';
    const { getSignalStackWriter } = await import('./signalstack.js');
    const writer = getSignalStackWriter();
    expect(writer).not.toBeNull();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockHttpWriterCtor).toHaveBeenCalledWith({
      baseUrl: 'https://signalstack.example.com',
      apiKey: 'key-1',
      actingOrgId: 'org-1',
      timeoutMs: 10_000,
    });
  });

  it('caches the singleton (including a null result) across calls', async () => {
    const { getSignalStackWriter } = await import('./signalstack.js');
    const a = getSignalStackWriter();
    const b = getSignalStackWriter();
    expect(a).toBeNull();
    expect(b).toBeNull();

    mockConfig.SIGNALSTACK_BASE_URL = 'https://signalstack.example.com';
    mockConfig.SIGNALSTACK_ADMIN_KEY = 'key-1';
    // Still cached as null even though config "changed" after first read.
    expect(getSignalStackWriter()).toBeNull();
    expect(mockHttpWriterCtor).not.toHaveBeenCalled();
  });

  it('_setSignalStackWriter overrides the singleton for tests', async () => {
    const { getSignalStackWriter, _setSignalStackWriter } = await import('./signalstack.js');
    const fake = { onboard: vi.fn() } as never;
    _setSignalStackWriter(fake);
    expect(getSignalStackWriter()).toBe(fake);
    expect(mockHttpWriterCtor).not.toHaveBeenCalled();
  });

  it('_setSignalStackWriter(null) pins the disabled state without re-evaluating env config', async () => {
    mockConfig.SIGNALSTACK_BASE_URL = 'https://signalstack.example.com';
    mockConfig.SIGNALSTACK_ADMIN_KEY = 'key-1';
    const { getSignalStackWriter, _setSignalStackWriter } = await import('./signalstack.js');
    _setSignalStackWriter(null);
    // Even though config now supports a real writer, the pinned null wins.
    expect(getSignalStackWriter()).toBeNull();
    expect(mockHttpWriterCtor).not.toHaveBeenCalled();
  });
});
