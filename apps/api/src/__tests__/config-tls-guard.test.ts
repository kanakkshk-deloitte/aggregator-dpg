import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { assertTlsPosture, type Config } from '../config.js';

// assertTlsPosture only reads NODE_TLS_REJECT_UNAUTHORIZED, INSTANCE_ENV, and
// NODE_ENV — build a minimal Config for those three and cast the rest.
const cfg = (over: Partial<Config>): Config => over as Config;

afterEach(() => vi.restoreAllMocks());

describe('assertTlsPosture (api)', () => {
  it('throws ConfigError (INSECURE_TLS_IN_PROD) when TLS off + NODE_ENV=production', () => {
    try {
      assertTlsPosture(cfg({ NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_ENV: 'production' }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('INSECURE_TLS_IN_PROD');
    }
  });

  it('throws when INSTANCE_ENV=production overrides a non-prod NODE_ENV', () => {
    expect(() =>
      assertTlsPosture(
        cfg({
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          INSTANCE_ENV: 'production',
          NODE_ENV: 'development',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('warns once (does not throw) when TLS off in staging', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(() =>
      assertTlsPosture(
        cfg({
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          INSTANCE_ENV: 'staging',
          NODE_ENV: 'development',
        }),
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does nothing when verified ("1") or unset', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(() =>
      assertTlsPosture(cfg({ NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_ENV: 'production' })),
    ).not.toThrow();
    expect(() => assertTlsPosture(cfg({ NODE_ENV: 'production' }))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats benign non-"0" values as safe (no crash, no throw)', () => {
    for (const v of ['', 'true', '2']) {
      expect(() =>
        assertTlsPosture(cfg({ NODE_TLS_REJECT_UNAUTHORIZED: v, NODE_ENV: 'production' })),
      ).not.toThrow();
    }
  });
});
