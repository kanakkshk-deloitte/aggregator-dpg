/**
 * Unit tests for the PII-mask heuristic.
 *
 * This guards the one place a masked value could leak to a third-party
 * geocoder. It is a heuristic, so both directions matter: missing a mask sends
 * "***" to Google, while over-matching silently disables autocomplete for real
 * addresses — and the second failure is the quieter of the two.
 */
import { describe, it, expect } from 'vitest';
import { looksLikePIIMask } from '@/lib/geo/pii-mask';

describe('looksLikePIIMask', () => {
  it.each([
    ['***', 'a bare asterisk run'],
    ['M***', 'a partially masked name'],
    ['+91-XX-XXXX-X123', 'a phone-style mask'],
    ['****ate Street', 'a mask run inside a longer string'],
  ])('flags %j — %s', (value) => {
    expect(looksLikePIIMask(value)).toBe(true);
  });

  it.each([
    ['Jayanagar, Bengaluru', 'an ordinary address'],
    ['MG Road', 'initials that are not a mask run'],
    ['Xavier Street, Mumbai', 'a real name beginning with X'],
    ['Plot 42, Sector 9', 'an address with digits'],
  ])('allows %j — %s', (value) => {
    expect(looksLikePIIMask(value)).toBe(false);
  });

  it('treats an empty or whitespace-only value as not a mask', () => {
    // Nothing to protect, and the caller already skips empty queries — so
    // reporting `true` here would be a confusing lie rather than a safe default.
    expect(looksLikePIIMask('')).toBe(false);
    expect(looksLikePIIMask('   ')).toBe(false);
  });

  it('flags a short string that is mostly mask characters', () => {
    // The density rule: 40% or more mask characters, which catches masks too
    // short to contain a three-character run.
    expect(looksLikePIIMask('XX1')).toBe(true);
  });
});
