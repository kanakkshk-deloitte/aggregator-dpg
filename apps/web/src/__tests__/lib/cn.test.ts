import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/cn';

describe('cn', () => {
  it('joins plain string class names', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy/conditional segments', () => {
    expect(cn('a', false && 'b', undefined, null, 0 && 'z', 'c')).toBe('a c');
  });

  it('returns an empty string for no/empty input', () => {
    expect(cn()).toBe('');
    expect(cn('', undefined, false)).toBe('');
  });

  it('dedupes conflicting Tailwind utilities, keeping the last one', () => {
    expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
  });

  it('merges object and array class-value forms', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });
});
