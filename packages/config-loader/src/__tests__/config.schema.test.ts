/**
 * Unit tests for this package's own runtime config schema
 * (configKey / configSchema / configDefaults).
 *
 * @module @aggregator-dpg/config-loader/__tests__/config.schema
 */

import { describe, it, expect } from 'vitest';
import { configKey, configSchema, configDefaults } from '../config.schema.js';

describe('config-loader config.schema', () => {
  it('exposes a stable, unique configKey', () => {
    expect(configKey).toBe('configLoader');
  });

  it('parses an empty object as valid (no fields declared yet)', () => {
    const result = configSchema.parse({});
    expect(result).toEqual({});
  });

  it('strips unknown keys rather than rejecting them (default object schema)', () => {
    const result = configSchema.parse({ unexpectedKey: 'value' });
    expect(result).toEqual({});
  });

  it('rejects non-object input', () => {
    expect(() => configSchema.parse('not-an-object')).toThrow();
    expect(() => configSchema.parse(null)).toThrow();
    expect(() => configSchema.parse([])).toThrow();
    expect(() => configSchema.parse(42)).toThrow();
  });

  it('exports configDefaults that is itself a valid config slice', () => {
    expect(configDefaults).toEqual({});
    expect(() => configSchema.parse(configDefaults)).not.toThrow();
  });
});
