/**
 * Unit tests for the shared `signals_cta` default rule.
 *
 * This function exists because the rule was written twice — once in the api
 * (`services/registration-mode`) and once in the web app (`SignalsSignInCta`,
 * as a back-compat fallback for an api build that predates the field on the
 * wire). Both now call this, so these cases pin the behaviour both inherit.
 *
 * @module @aggregator-dpg/network-config
 */
import { describe, it, expect } from 'vitest';
import { resolveSignalsCta } from '../signals-cta.js';

describe('resolveSignalsCta', () => {
  it('honours an explicit true regardless of the submission shape', () => {
    expect(resolveSignalsCta(true, 'account_and_profile')).toBe(true);
    // The interesting half: an identity-only mode the operator turned ON.
    expect(resolveSignalsCta(true, 'account_only')).toBe(true);
  });

  it('honours an explicit false regardless of the submission shape', () => {
    // The interesting half: a full-profile mode the operator turned OFF, which
    // the shape-based default would otherwise have switched on.
    expect(resolveSignalsCta(false, 'account_and_profile')).toBe(false);
    expect(resolveSignalsCta(false, 'account_only')).toBe(false);
  });

  it('defaults to on for full-profile links when the flag is absent', () => {
    expect(resolveSignalsCta(undefined, 'account_and_profile')).toBe(true);
  });

  it('defaults to off for identity-only links when the flag is absent', () => {
    expect(resolveSignalsCta(undefined, 'account_only')).toBe(false);
  });

  it('never returns a non-boolean, so callers can use it directly in a branch', () => {
    for (const explicit of [true, false, undefined]) {
      for (const shape of ['account_only', 'account_and_profile'] as const) {
        expect(typeof resolveSignalsCta(explicit, shape)).toBe('boolean');
      }
    }
  });
});
