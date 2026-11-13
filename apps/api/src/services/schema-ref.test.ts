/**
 * Tests for the schema/profile_ref resolver.
 *
 * The point of these is the distinction the module exists for: the ref must name
 * the file that actually resolved, never the brand env. An env-derived ref would
 * claim a variant the payload did not come from.
 *
 * Env is passed explicitly rather than assigned to `process.env` — vitest shares
 * a worker across test files, so mutating it here changed which config other
 * suites resolved and broke them.
 */

import { describe, it, expect } from 'vitest';
import { resolveSchema, resolveProfileRef } from './schema-ref.js';

const env = (network: string, brand?: string): Record<string, string> =>
  brand
    ? { AGGREGATOR_NETWORK: network, AGGREGATOR_BRAND: brand }
    : { AGGREGATOR_NETWORK: network };

describe('resolveProfileRef', () => {
  it('names the brand override when the brand ships its own schema', () => {
    expect(resolveProfileRef('registration.v1.json', env('blue_dot', 'up-gzb'))).toBe(
      'blue_dot/up-gzb/registration.v1',
    );
    expect(resolveProfileRef('org-registration.v1.json', env('blue_dot', 'up-gzb'))).toBe(
      'blue_dot/up-gzb/org-registration.v1',
    );
  });

  it('names the network level when no brand is set', () => {
    // config/blue_dot/schemas/aggregator is a symlink to the shared schemas —
    // the ref still reports where resolution landed, which is the network level.
    expect(resolveProfileRef('registration.v1.json', env('blue_dot'))).toBe(
      'blue_dot/registration.v1',
    );
  });

  it('reports the shared default when the network has no schema directory', () => {
    expect(resolveProfileRef('registration.v1.json', env('no_such_network'))).toBe(
      'registration.v1',
    );
  });

  it('does NOT claim a brand whose override is absent', () => {
    // The env says up-gzb, but purple_dot has no up-gzb override — resolution
    // falls back, so the ref must not read `purple_dot/up-gzb/...`. This is the
    // silent mislabelling the module exists to prevent, and the reason the ref
    // is derived from the resolved path rather than from these two vars.
    const ref = resolveProfileRef('registration.v1.json', env('purple_dot', 'up-gzb'));
    expect(ref).not.toBe('purple_dot/up-gzb/registration.v1');
    expect(ref).toBe('purple_dot/registration.v1');
  });

  it('returns null for a schema file that does not exist', () => {
    expect(resolveProfileRef('no-such-schema.v9.json', env('blue_dot', 'up-gzb'))).toBeNull();
  });
});

describe('resolveSchema', () => {
  it('returns a readable path alongside the ref', () => {
    const resolved = resolveSchema('registration.v1.json', env('blue_dot', 'up-gzb'));
    expect(resolved).not.toBeNull();
    expect(resolved?.path).toMatch(
      /config\/blue_dot\/up-gzb\/schemas\/aggregator\/registration\.v1\.json$/,
    );
  });

  it('returns null when nothing resolves', () => {
    expect(resolveSchema('no-such-schema.v9.json', env('blue_dot'))).toBeNull();
  });
});
