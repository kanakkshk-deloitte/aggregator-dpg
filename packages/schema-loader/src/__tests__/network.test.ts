/**
 * Tests for NetworkSchemaLoader — the hybrid loader shared by the API and
 * worker processes.
 *
 * Layout used for the file-delegation cases:
 *   {tmp}/aggregator/registration.v1.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NetworkSchemaLoader, type NetworkSchemaSource } from '../network.js';

const participantSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
} as const;

const aggregatorSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string', format: 'email' } },
  additionalProperties: false,
} as const;

function sourceWith(domains: Record<string, { schema: unknown }>): NetworkSchemaSource {
  return { domains };
}

describe('NetworkSchemaLoader', () => {
  let rootDir: string;
  let calls: number;

  const build = (
    source: NetworkSchemaSource = sourceWith({ seeker: { schema: participantSchema } }),
  ) =>
    new NetworkSchemaLoader({
      rootDir,
      getNetworkConfig: () => {
        calls += 1;
        return Promise.resolve(source);
      },
    });

  beforeEach(async () => {
    calls = 0;
    rootDir = await mkdtemp(path.join(tmpdir(), 'network-schema-loader-'));
    await mkdir(path.join(rootDir, 'aggregator'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'aggregator', 'registration.v1.json'),
      JSON.stringify(aggregatorSchema),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('getSchema', () => {
    it('resolves a participant id from the network config', async () => {
      const result = await build().getSchema({ id: 'participant-seeker', version: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.value).toEqual(participantSchema);
      expect(calls).toBe(1);
    });

    it('delegates a non-participant id to the file loader', async () => {
      const result = await build().getSchema({ id: 'aggregator-registration', version: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.value).toEqual(aggregatorSchema);
      // The network config is never consulted for file-backed ids.
      expect(calls).toBe(0);
    });

    it('returns SchemaNotFoundError when the domain is absent', async () => {
      const result = await build(sourceWith({})).getSchema({
        id: 'participant-seeker',
        version: 'v1',
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.name).toBe('SchemaNotFoundError');
    });

    it('delegates ids whose participant suffix is not a bare domain token', async () => {
      // `participant-` followed by a path-ish value must not be treated as a
      // domain — it falls through to the file loader, which rejects it.
      const result = await build().getSchema({ id: 'participant-../etc', version: 'v1' });
      expect(result.success).toBe(false);
      expect(calls).toBe(0);
    });
  });

  describe('getValidator', () => {
    it('compiles a validator for a participant schema', async () => {
      const result = await build().getValidator({ id: 'participant-seeker', version: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value({ name: 'Asha' })).toBe(true);
        expect(result.value({ age: 3 })).toBe(false);
      }
    });

    it('caches the compiled validator per (id, version)', async () => {
      const loader = build();
      const first = await loader.getValidator({ id: 'participant-seeker', version: 'v1' });
      const second = await loader.getValidator({ id: 'participant-seeker', version: 'v1' });
      expect(first.success && second.success).toBe(true);
      if (first.success && second.success) expect(second.value).toBe(first.value);
      // Only the first call reaches the network config.
      expect(calls).toBe(1);
    });

    it('delegates a non-participant id to the file loader', async () => {
      const result = await build().getValidator({ id: 'aggregator-registration', version: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.value({ email: 'a@b.com' })).toBe(true);
    });

    it('surfaces SchemaNotFoundError from a missing domain', async () => {
      const result = await build(sourceWith({})).getValidator({
        id: 'participant-seeker',
        version: 'v1',
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.name).toBe('SchemaNotFoundError');
    });

    it('returns SchemaCompileError when the schema will not compile', async () => {
      const broken = sourceWith({ seeker: { schema: { type: 'not-a-real-type' } } });
      const result = await build(broken).getValidator({ id: 'participant-seeker', version: 'v1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.name).toBe('SchemaCompileError');
    });
  });
});
