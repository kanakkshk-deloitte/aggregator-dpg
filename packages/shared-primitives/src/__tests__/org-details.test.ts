/**
 * Unit tests for the organisation detail format rules
 * (`@aggregator-dpg/shared-primitives/org-details`): the GSTIN format and
 * check character.
 */
import { describe, expect, it } from 'vitest';
import { isValidGstin, normaliseGstin } from '../org-details/index.js';

describe('isValidGstin', () => {
  const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '29ABCDE1234F1ZW'];

  it.each(VALID)('accepts %s', (value) => {
    expect(isValidGstin(value)).toBe(true);
  });

  it('accepts lower case and surrounding spaces', () => {
    expect(isValidGstin('  27aapfu0939f1zv ')).toBe(true);
  });

  it('refuses every single-character change of a valid GSTIN', () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const gstin of VALID) {
      for (let i = 0; i < gstin.length; i += 1) {
        for (const c of alphabet) {
          if (c === gstin[i]) continue;
          const changed = gstin.slice(0, i) + c + gstin.slice(i + 1);
          expect(isValidGstin(changed), changed).toBe(false);
        }
      }
    }
  });

  it('refuses two swapped neighbouring characters', () => {
    // PAN digits 0939 → 9039.
    expect(isValidGstin('27AAPFU9039F1ZV')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['free text', 'hello'],
    ['14 characters', '27AAPFU0939F1Z'],
    ['16 characters', '27AAPFU0939F1ZVX'],
    ['no Z in position 14', '27AAPFU0939F1AV'],
    ['entity number 0', '27AAPFU0939F0ZV'],
    ['letters in the state code', 'AAAAPFU0939F1ZV'],
    ['an invalid check character', '27AAAAA0000A1Z5'],
  ])('refuses %s', (_label, value) => {
    expect(isValidGstin(value)).toBe(false);
  });
});

describe('normaliseGstin', () => {
  it('trims and upper-cases', () => {
    expect(normaliseGstin('  29abcde1234f1zw ')).toBe('29ABCDE1234F1ZW');
  });

  it('keeps an empty value empty', () => {
    expect(normaliseGstin('   ')).toBe('');
  });
});
