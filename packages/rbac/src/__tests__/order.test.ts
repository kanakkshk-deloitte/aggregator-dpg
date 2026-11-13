/**
 * Unit tests for compareCodeUnits: it must order exactly as `sort()` without
 * a compare function, so switching to it changes no output.
 */
import { describe, it, expect } from 'vitest';
import { compareCodeUnits } from '../order.js';

describe('compareCodeUnits', () => {
  it('orders like the default sort, case and punctuation included', () => {
    const keys = [
      'profiles.view_pii',
      'Org.manage',
      'org.manage',
      'org_onboarder',
      'a',
      'B',
      '',
      'é',
      'z.y',
    ];
    expect([...keys].sort(compareCodeUnits)).toEqual([...keys].sort());
  });

  it('returns 0 for equal strings and keeps duplicates', () => {
    expect(compareCodeUnits('x', 'x')).toBe(0);
    expect(['b', 'a', 'b'].sort(compareCodeUnits)).toEqual(['a', 'b', 'b']);
  });

  it('is negative when the first sorts first, positive otherwise', () => {
    expect(compareCodeUnits('a', 'b')).toBeLessThan(0);
    expect(compareCodeUnits('b', 'a')).toBeGreaterThan(0);
  });

  it('handles an empty list', () => {
    expect([].sort(compareCodeUnits)).toEqual([]);
  });
});
