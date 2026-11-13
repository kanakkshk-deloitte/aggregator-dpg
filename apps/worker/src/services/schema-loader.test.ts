/**
 * Unit tests for the worker's hybrid schema loader (`NetworkSchemaLoader`).
 *
 * `getNetworkConfig()` and `FileSchemaLoader` are mocked so no real network
 * fetch or disk read happens; Ajv itself is the real library (a pure,
 * synchronous validation engine — not an external system, so no mock is
 * warranted per error-handling.md's "external systems" scope).
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SchemaRef } from '@aggregator-dpg/schema-loader/interface';

const getNetworkConfig = vi.fn();
vi.mock('./network-config.js', () => ({ getNetworkConfig }));

const fileGetSchema = vi.fn();
const fileGetValidator = vi.fn();
vi.mock('@aggregator-dpg/schema-loader/file', () => ({
  // vitest 4 requires a *constructible* implementation for a mock invoked with
  // `new` — an arrow function throws "is not a constructor".
  FileSchemaLoader: vi.fn(function () {
    return { getSchema: fileGetSchema, getValidator: fileGetValidator };
  }),
}));

vi.mock('./config.js', () => ({ config: { SCHEMA_ROOT_DIR: './config/schemas' } }));

const { getSchemaLoader } = await import('./schema-loader.js');

const SEEKER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { name: { type: 'string' }, email: { type: 'string' } },
  required: ['name', 'email'],
};

beforeEach(() => {
  getNetworkConfig.mockReset();
  fileGetSchema.mockReset();
  fileGetValidator.mockReset();
});

describe('getSchemaLoader (singleton)', () => {
  it('returns the same loader instance on repeated calls', () => {
    expect(getSchemaLoader()).toBe(getSchemaLoader());
  });
});

describe('NetworkSchemaLoader.getSchema — participant-* refs', () => {
  it('resolves from the network config domains map', async () => {
    getNetworkConfig.mockResolvedValueOnce({
      domains: { seeker: { schema: SEEKER_SCHEMA } },
    });
    const loader = getSchemaLoader();

    const result = await loader.getSchema({ id: 'participant-seeker', version: 'v1' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(SEEKER_SCHEMA);
    expect(fileGetSchema).not.toHaveBeenCalled();
  });

  it('returns a SchemaNotFoundError when the domain is absent from the resolved network config', async () => {
    getNetworkConfig.mockResolvedValueOnce({ domains: {} });
    const loader = getSchemaLoader();

    const result = await loader.getSchema({ id: 'participant-unknown_domain', version: 'v1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/schema not found/i);
    }
  });
});

describe('NetworkSchemaLoader.getSchema — non-participant refs fall back to the file loader', () => {
  it('delegates to FileSchemaLoader.getSchema', async () => {
    const fileSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' };
    fileGetSchema.mockResolvedValueOnce({ success: true, value: fileSchema });
    const loader = getSchemaLoader();

    const result = await loader.getSchema({ id: 'aggregator-registration', version: 'v1' });

    expect(result).toEqual({ success: true, value: fileSchema });
    expect(getNetworkConfig).not.toHaveBeenCalled();
  });

  it('treats "participant-" with an empty/invalid domain suffix as a non-participant ref', async () => {
    fileGetSchema.mockResolvedValueOnce({ success: true, value: {} });
    const loader = getSchemaLoader();

    // domain = '' after slicing "participant-" — fails the [a-z0-9_]+ regex,
    // so this must fall through to the file loader, not the network config.
    await loader.getSchema({ id: 'participant-', version: 'v1' } as SchemaRef);

    expect(fileGetSchema).toHaveBeenCalledOnce();
    expect(getNetworkConfig).not.toHaveBeenCalled();
  });
});

describe('NetworkSchemaLoader.getValidator — participant-* refs', () => {
  it('compiles and returns a working validator', async () => {
    getNetworkConfig.mockResolvedValue({ domains: { seeker: { schema: SEEKER_SCHEMA } } });
    const loader = getSchemaLoader();

    const result = await loader.getValidator({ id: 'participant-seeker', version: 'v2' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value({ name: 'Asha', email: 'a@x.io' })).toBe(true);
      expect(result.value({ name: 'Asha' })).toBe(false);
    }
  });

  it('caches the compiled validator per (id, version) — a second call skips recompilation', async () => {
    getNetworkConfig.mockResolvedValue({ domains: { seeker: { schema: SEEKER_SCHEMA } } });
    const loader = getSchemaLoader();

    const first = await loader.getValidator({ id: 'participant-seeker', version: 'v3' });
    const second = await loader.getValidator({ id: 'participant-seeker', version: 'v3' });

    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      // Same compiled function instance — proves the cache hit, not just
      // equivalent behaviour.
      expect(second.value).toBe(first.value);
    }
    // The validator cache is checked before getSchema()/getNetworkConfig()
    // is ever reached, so a cache hit must not trigger a second lookup.
    expect(getNetworkConfig).toHaveBeenCalledTimes(1);
  });

  it('propagates a SchemaNotFoundError instead of attempting to compile', async () => {
    getNetworkConfig.mockResolvedValueOnce({ domains: {} });
    const loader = getSchemaLoader();

    const result = await loader.getValidator({ id: 'participant-missing_domain', version: 'v1' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/schema not found/i);
  });

  it('returns a SchemaCompileError when Ajv fails to compile the resolved schema', async () => {
    getNetworkConfig.mockResolvedValueOnce({
      domains: { broken: { schema: { $ref: '#/definitions/does-not-exist' } } },
    });
    const loader = getSchemaLoader();

    const result = await loader.getValidator({ id: 'participant-broken', version: 'v1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/failed to compile schema/i);
    }
  });
});

describe('NetworkSchemaLoader.getValidator — non-participant refs fall back to the file loader', () => {
  it('delegates to FileSchemaLoader.getValidator', async () => {
    const validate = ((): boolean => true) as unknown;
    fileGetValidator.mockResolvedValueOnce({ success: true, value: validate });
    const loader = getSchemaLoader();

    const result = await loader.getValidator({ id: 'aggregator-registration', version: 'v1' });

    expect(result).toEqual({ success: true, value: validate });
    expect(getNetworkConfig).not.toHaveBeenCalled();
  });
});
