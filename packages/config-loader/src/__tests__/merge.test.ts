import { describe, it, expect } from 'vitest';
import { deepMerge } from '../merge.js';

describe('deepMerge', () => {
  it('merges flat keys', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('overrides existing scalar with source value', () => {
    const result = deepMerge({ a: 1 }, { a: 99 });
    expect(result).toEqual({ a: 99 });
  });

  it('deep-merges nested objects', () => {
    const result = deepMerge({ db: { host: 'localhost', port: 5432 } }, { db: { port: 5433 } });
    expect(result).toEqual({ db: { host: 'localhost', port: 5433 } });
  });

  it('replaces arrays rather than concatenating', () => {
    const result = deepMerge({ tags: ['a', 'b'] }, { tags: ['c'] });
    expect(result).toEqual({ tags: ['c'] });
  });

  it('sets key when target lacks it', () => {
    const result = deepMerge({}, { x: { y: 1 } });
    expect(result).toEqual({ x: { y: 1 } });
  });

  it('replaces nested object with scalar', () => {
    const result = deepMerge({ a: { b: 1 } }, { a: 'string' });
    expect(result).toEqual({ a: 'string' });
  });

  it('replaces scalar with nested object', () => {
    const result = deepMerge({ a: 'string' }, { a: { b: 1 } });
    expect(result).toEqual({ a: { b: 1 } });
  });

  it('handles null values in source — sets key to null', () => {
    const result = deepMerge({ a: 'value' }, { a: null } as Record<string, unknown>);
    expect(result).toEqual({ a: null });
  });

  it('handles null in target — replaces with source object', () => {
    const result = deepMerge({ a: null } as Record<string, unknown>, { a: { b: 1 } });
    expect(result).toEqual({ a: { b: 1 } });
  });

  it('mutates and returns the target', () => {
    const target = { a: 1 };
    const returned = deepMerge(target, { b: 2 });
    expect(returned).toBe(target);
  });

  it('three-level deep merge', () => {
    const result = deepMerge({ a: { b: { c: 1, d: 2 } } }, { a: { b: { d: 99, e: 3 } } });
    expect(result).toEqual({ a: { b: { c: 1, d: 99, e: 3 } } });
  });
  // A YAML/JSON document can carry `__proto__` as an OWN enumerable property,
  // which Object.keys does surface — unlike an object literal. Config here is
  // assembled from fetched documents, so the source side is not guaranteed to
  // be a literal (CodeQL js/prototype-pollution-utility).
  //
  // Unguarded, `target['__proto__'] = value` invokes the inherited setter and
  // REPLACES the merged object's prototype, so the config object silently
  // inherits attacker-supplied keys. Global Object.prototype is untouched, so
  // asserting on `({}).polluted` would pass either way — the meaningful checks
  // are the result's own prototype and what it resolves.
  it('does not let a source key replace the result prototype', () => {
    const source = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": 1}');

    const result = deepMerge({}, source);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(result).toEqual({ safe: 1 });
  });

  it('skips constructor and prototype keys too', () => {
    const source = JSON.parse('{"constructor": {"x": 1}, "prototype": {"y": 2}, "keep": 3}');

    const result = deepMerge({}, source);

    expect(result).toEqual({ keep: 3 });
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });
});
