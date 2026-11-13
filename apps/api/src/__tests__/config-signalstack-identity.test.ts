/**
 * Boot-time guard on the Phase C bearer credential's identity.
 *
 * Signals resolves the acting organisation from the calling client id, so a
 * wrong `SIGNALSTACK_CLIENT_ID` authenticates successfully and then writes as
 * the wrong org. These cases pin the fail-at-boot behaviour.
 *
 * @module @aggregator-dpg/api
 */

import { describe, it, expect } from 'vitest';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { assertSignalStackClientIdentity } from '@aggregator-dpg/shared-primitives/config';
import { type Config } from '../config.js';

// The guard reads only the four SIGNALSTACK_* keys below.
const cfg = (over: Partial<Config>): Config => over as Config;

describe('assertSignalStackClientIdentity (api)', () => {
  it('no-ops in apikey mode even with no client id', () => {
    expect(() =>
      assertSignalStackClientIdentity(cfg({ SIGNALSTACK_AUTH_MODE: 'apikey' })),
    ).not.toThrow();
  });

  it('does NOT hard-fail boot when bearer mode has no client id', () => {
    // Incomplete bearer config stays a "push disabled" warn in the signalstack
    // factory; this guard must not escalate it to a crash.
    expect(() =>
      assertSignalStackClientIdentity(cfg({ SIGNALSTACK_AUTH_MODE: 'bearer' })),
    ).not.toThrow();
  });

  it('throws when the client id does not match the expected org slug', () => {
    try {
      assertSignalStackClientIdentity(
        cfg({
          SIGNALSTACK_AUTH_MODE: 'bearer',
          SIGNALSTACK_CLIENT_ID: 'aggregator-api',
          SIGNALSTACK_ORG_SLUG: 'aggregator-dpg',
        }),
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('SIGNALSTACK_CLIENT_ID_MISMATCH');
    }
  });

  it('passes when the client id matches the expected org slug', () => {
    expect(() =>
      assertSignalStackClientIdentity(
        cfg({
          SIGNALSTACK_AUTH_MODE: 'bearer',
          SIGNALSTACK_CLIENT_ID: 'aggregator-dpg',
          SIGNALSTACK_ORG_SLUG: 'aggregator-dpg',
        }),
      ),
    ).not.toThrow();
  });

  it('is opt-in: no slug configured means no equality check', () => {
    expect(() =>
      assertSignalStackClientIdentity(
        cfg({ SIGNALSTACK_AUTH_MODE: 'bearer', SIGNALSTACK_CLIENT_ID: 'anything' }),
      ),
    ).not.toThrow();
  });

  it('does not hardcode a slug — any deployment-specific value is accepted', () => {
    expect(() =>
      assertSignalStackClientIdentity(
        cfg({
          SIGNALSTACK_AUTH_MODE: 'bearer',
          SIGNALSTACK_CLIENT_ID: 'some-other-network-aggregator',
          SIGNALSTACK_ORG_SLUG: 'some-other-network-aggregator',
        }),
      ),
    ).not.toThrow();
  });
});
