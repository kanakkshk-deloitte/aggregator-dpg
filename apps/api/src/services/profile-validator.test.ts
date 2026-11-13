/**
 * Unit tests for the profile-schema Ajv validator loader.
 *
 * Most tests load the real `config/schemas/aggregator/profile.v1.json` (no
 * mocking) to exercise the genuine Ajv 2020-12 compile path and schema
 * content, matching how `schema-registry.test.ts` exercises its real YAML
 * file. A separate suite mocks `node:fs` to exercise the "schema file not
 * found on any candidate path" failure branch, which cannot be reached
 * against the real repo layout.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getProfileValidator, _resetProfileValidator } from './profile-validator.js';

describe('getProfileValidator', () => {
  beforeEach(() => {
    _resetProfileValidator();
  });

  it('compiles a callable Ajv validator from the real schema', () => {
    const validate = getProfileValidator();
    expect(typeof validate).toBe('function');
  });

  it('rejects an empty payload as missing required top-level sections', () => {
    const validate = getProfileValidator();
    const ok = validate({});
    expect(ok).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });

  it('caches the compiled validator across calls', () => {
    const a = getProfileValidator();
    const b = getProfileValidator();
    expect(a).toBe(b);
  });

  it('_resetProfileValidator forces a fresh compile on the next call', () => {
    const a = getProfileValidator();
    _resetProfileValidator();
    const b = getProfileValidator();
    expect(a).not.toBe(b);
  });
});

describe('getProfileValidator schema-not-found failure', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }));
  });

  it('throws a descriptive error listing every candidate path tried', async () => {
    const { getProfileValidator: getValidatorFresh } = await import('./profile-validator.js');
    expect(() => getValidatorFresh()).toThrow(/profile schema not found; tried:/);
    vi.doUnmock('node:fs');
  });
});
