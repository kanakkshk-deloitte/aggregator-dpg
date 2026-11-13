import { describe, it, expect } from 'vitest';
import { refusedNameCharacters } from '../person-name/index.js';

describe('refusedNameCharacters', () => {
  it('accepts ordinary names, including apostrophes, dots, hyphens and non-Latin scripts', () => {
    for (const name of ['Ravi Kumar', "D'Souza", 'A. K. Sharma', 'Mary-Jane', 'रवि कुमार', 'ರವಿ']) {
      expect(refusedNameCharacters(name)).toEqual([]);
    }
  });

  it('lists each refused character once, in order', () => {
    expect(refusedNameCharacters('Ravi Kumar (Ops)')).toEqual(['(', ')']);
    expect(refusedNameCharacters('<b>Owner</b>')).toEqual(['<', '>', '/']);
    expect(refusedNameCharacters('Ram & Sons #1')).toEqual(['&', '#']);
  });

  it('shows control characters by code', () => {
    expect(refusedNameCharacters('Ravi\tKumar')).toEqual(['\\u0009']);
  });

  it('returns nothing for an empty name', () => {
    expect(refusedNameCharacters('')).toEqual([]);
  });
});
