import { describe, it, expect } from 'vitest';
import { resolveLifecycle, type LifecycleStatus } from '../lifecycle.js';

describe('resolveLifecycle', () => {
  it('returns draft when lifecycle_status absent (#613 pessimistic default)', () => {
    expect(resolveLifecycle({})).toBe<'draft'>('draft');
  });

  it('returns the explicit value when present', () => {
    const cases: LifecycleStatus[] = ['draft', 'live', 'paused'];
    for (const v of cases) {
      expect(resolveLifecycle({ lifecycle_status: v })).toBe(v);
    }
  });

  it('clamps unknown strings to draft', () => {
    expect(resolveLifecycle({ lifecycle_status: 'bogus' as LifecycleStatus })).toBe('draft');
  });

  it('returns null for null input', () => {
    expect(resolveLifecycle(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(resolveLifecycle(undefined)).toBeNull();
  });
});
