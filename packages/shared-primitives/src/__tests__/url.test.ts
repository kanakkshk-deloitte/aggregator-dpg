/**
 * Tests for the shared URL string helpers.
 */

import { describe, expect, it } from 'vitest';
import { stripTrailingSlashes } from '../url/index.js';

describe('stripTrailingSlashes', () => {
  it('leaves a URL without a trailing slash untouched', () => {
    expect(stripTrailingSlashes('https://kc.example.org')).toBe('https://kc.example.org');
  });

  it('removes a single trailing slash', () => {
    expect(stripTrailingSlashes('https://kc.example.org/')).toBe('https://kc.example.org');
  });

  it('removes a run of trailing slashes', () => {
    expect(stripTrailingSlashes('https://kc.example.org////')).toBe('https://kc.example.org');
  });

  it('preserves interior slashes', () => {
    expect(stripTrailingSlashes('https://kc.example.org/auth//realms/')).toBe(
      'https://kc.example.org/auth//realms',
    );
  });

  it('returns an empty string for an empty input', () => {
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('returns an empty string when the input is only slashes', () => {
    expect(stripTrailingSlashes('///')).toBe('');
  });

  it('handles a long run of trailing slashes in linear time', () => {
    // Regression guard for the `/\/+$/` form this replaced, whose greedy
    // quantifier was retried from every start offset (typescript:S8786).
    const input = `https://kc.example.org${'/'.repeat(100_000)}`;
    const started = performance.now();
    expect(stripTrailingSlashes(input)).toBe('https://kc.example.org');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
