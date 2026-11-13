/**
 * Tests for the shared hex-colour helpers.
 *
 * Extracted from `theme-provider.tsx` and `BrandPanel.tsx`, which both derive
 * their palettes from deploy-time brand config — so malformed input must
 * degrade rather than throw.
 */

import { describe, it, expect } from 'vitest';
import { mix, parseHex } from '../../lib/hex-color';

describe('parseHex', () => {
  it('parses a #rrggbb value', () => {
    expect(parseHex('#4f46e5')).toEqual([0x4f, 0x46, 0xe5]);
  });

  it('parses without the leading #', () => {
    expect(parseHex('4f46e5')).toEqual([0x4f, 0x46, 0xe5]);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(parseHex('  #4F46E5 ')).toEqual([0x4f, 0x46, 0xe5]);
  });

  it('returns null for a three-digit shorthand', () => {
    expect(parseHex('#abc')).toBeNull();
  });

  it('returns null for a non-colour string', () => {
    expect(parseHex('rebeccapurple')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('mix', () => {
  it('returns the first colour at weight 0', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
  });

  it('returns the second colour at weight 1', () => {
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends the midpoint', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps a weight above 1', () => {
    expect(mix('#000000', '#ffffff', 5)).toBe('#ffffff');
  });

  it('clamps a negative weight', () => {
    expect(mix('#000000', '#ffffff', -3)).toBe('#000000');
  });

  it('zero-pads single-digit channels', () => {
    expect(mix('#000000', '#0a0a0a', 1)).toBe('#0a0a0a');
  });

  it('falls back to the first colour when either input is malformed', () => {
    expect(mix('#4f46e5', 'not-a-colour', 0.5)).toBe('#4f46e5');
    expect(mix('nope', '#ffffff', 0.5)).toBe('nope');
  });
});
