/**
 * Boot-time guard on the Phase C bearer credential's identity (worker copy).
 *
 * The worker mints the same service token as the API, so it must refuse to boot
 * on the same misconfiguration — otherwise bulk onboards would write as the
 * wrong signals organisation.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import { type ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { assertSignalStackClientIdentity } from '@aggregator-dpg/shared-primitives/config';
import { type Config } from './config.js';

const cfg = (over: Partial<Config>): Config => over as Config;

describe('assertSignalStackClientIdentity (worker)', () => {
  it('no-ops in apikey mode', () => {
    expect(() =>
      assertSignalStackClientIdentity(cfg({ SIGNALSTACK_AUTH_MODE: 'apikey' })),
    ).not.toThrow();
  });

  it('does NOT hard-fail boot in bearer mode with no client id', () => {
    // Must stay compatible with the factory's "push disabled" warn path.
    expect(() =>
      assertSignalStackClientIdentity(cfg({ SIGNALSTACK_AUTH_MODE: 'bearer' })),
    ).not.toThrow();
  });

  it('throws SIGNALSTACK_CLIENT_ID_MISMATCH on a client id / slug divergence', () => {
    try {
      assertSignalStackClientIdentity(
        cfg({
          SIGNALSTACK_AUTH_MODE: 'bearer',
          SIGNALSTACK_CLIENT_ID: 'aggregator-worker',
          SIGNALSTACK_ORG_SLUG: 'aggregator-dpg',
        }),
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ConfigError).code).toBe('SIGNALSTACK_CLIENT_ID_MISMATCH');
    }
  });

  it('passes on a match, and no-ops when no slug is configured', () => {
    expect(() =>
      assertSignalStackClientIdentity(
        cfg({
          SIGNALSTACK_AUTH_MODE: 'bearer',
          SIGNALSTACK_CLIENT_ID: 'aggregator-dpg',
          SIGNALSTACK_ORG_SLUG: 'aggregator-dpg',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertSignalStackClientIdentity(
        cfg({ SIGNALSTACK_AUTH_MODE: 'bearer', SIGNALSTACK_CLIENT_ID: 'aggregator-dpg' }),
      ),
    ).not.toThrow();
  });
});
