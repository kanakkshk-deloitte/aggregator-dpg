import { describe, it, expect } from 'vitest';
import { configKey, configSchema, configDefaults } from '../config.schema.js';

describe('configKey', () => {
  it('is the unique top-level key for this package in the merged config tree', () => {
    expect(configKey).toBe('template');
  });
});

describe('configSchema', () => {
  it('accepts an empty object (the current scaffold has no required fields)', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it('accepts configDefaults as a valid baseline', () => {
    const result = configSchema.safeParse(configDefaults);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it('strips unknown keys rather than rejecting them (non-strict object)', () => {
    const result = configSchema.safeParse({ someFutureField: 'value' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it('rejects null', () => {
    const result = configSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects undefined', () => {
    const result = configSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  it('rejects an array', () => {
    const result = configSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('rejects a primitive (string)', () => {
    const result = configSchema.safeParse('not-an-object');
    expect(result.success).toBe(false);
  });

  it('rejects a primitive (number)', () => {
    const result = configSchema.safeParse(5);
    expect(result.success).toBe(false);
  });
});

describe('configDefaults', () => {
  it('is itself a valid Config value (parses cleanly)', () => {
    expect(() => configSchema.parse(configDefaults)).not.toThrow();
  });
});
