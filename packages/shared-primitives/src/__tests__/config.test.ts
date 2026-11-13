/**
 * Shared SignalStack config fields.
 *
 * These are spread into both the api and worker `ConfigSchema`, so a change
 * here lands in two processes at once. The realm field in particular decides
 * which Keycloak realm the signals service token is minted in — getting it
 * wrong makes signals reject every call — so its optionality and its parsing
 * are pinned here rather than left to the two app-level schemas.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { signalStackConfigFields } from '../config/index.js';

const schema = z.object(signalStackConfigFields);

describe('signalStackConfigFields', () => {
  it('parses with no signals config at all', () => {
    const parsed = schema.parse({});
    expect(parsed.SIGNALSTACK_KEYCLOAK_REALM).toBeUndefined();
  });

  it('keeps SIGNALSTACK_KEYCLOAK_REALM when supplied', () => {
    const parsed = schema.parse({ SIGNALSTACK_KEYCLOAK_REALM: 'bluedots' });
    expect(parsed.SIGNALSTACK_KEYCLOAK_REALM).toBe('bluedots');
  });

  it('keeps the signals realm independent of the portal realm', () => {
    // The whole point of the field: the two realms may differ, and neither
    // value may overwrite the other.
    const parsed = schema.parse({
      SIGNALSTACK_KEYCLOAK_REALM: 'bluedots',
      SIGNALSTACK_CLIENT_ID: 'aggregator-dpg',
      SIGNALSTACK_ORG_SLUG: 'aggregator-dpg',
    });
    expect(parsed.SIGNALSTACK_KEYCLOAK_REALM).toBe('bluedots');
    expect(parsed.SIGNALSTACK_CLIENT_ID).toBe('aggregator-dpg');
  });

  it('rejects a non-string realm', () => {
    expect(() => schema.parse({ SIGNALSTACK_KEYCLOAK_REALM: 42 })).toThrow();
  });
});
