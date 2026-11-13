import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  default: { readFile: readFileMock },
}));

const { resolveAggregatorSchemaPath, patchTypeFromNetwork, loadRegistrationSchema } =
  await import('@/lib/aggregator-schema.server');

describe('resolveAggregatorSchemaPath', () => {
  const origNetwork = process.env.AGGREGATOR_NETWORK;
  const origBrand = process.env.AGGREGATOR_BRAND;

  afterEach(() => {
    if (origNetwork === undefined) delete process.env.AGGREGATOR_NETWORK;
    else process.env.AGGREGATOR_NETWORK = origNetwork;
    if (origBrand === undefined) delete process.env.AGGREGATOR_BRAND;
    else process.env.AGGREGATOR_BRAND = origBrand;
  });

  it('resolves the network-level schema for the default network', () => {
    delete process.env.AGGREGATOR_BRAND;
    const p = resolveAggregatorSchemaPath('registration.v1.json');
    // `config/blue_dot/schemas/aggregator` is a symlink to the shared
    // `config/schemas/aggregator`, so this is the same file the flat path
    // resolved to before override support existed.
    expect(p).toBe(
      path.resolve(
        process.cwd(),
        '../../config/blue_dot/schemas/aggregator',
        'registration.v1.json',
      ),
    );
  });

  it('prefers a brand override when the brand ships its own schema', () => {
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    process.env.AGGREGATOR_BRAND = 'up-gzb';
    const p = resolveAggregatorSchemaPath('registration.v1.json');
    expect(p).toBe(
      path.resolve(
        process.cwd(),
        '../../config/blue_dot/up-gzb/schemas/aggregator',
        'registration.v1.json',
      ),
    );
  });

  it('falls back to the shared default when the network has no schema dir', () => {
    process.env.AGGREGATOR_NETWORK = 'no_such_network';
    delete process.env.AGGREGATOR_BRAND;
    const p = resolveAggregatorSchemaPath('registration.v1.json');
    expect(p).toBe(
      path.resolve(process.cwd(), '../../config/schemas/aggregator', 'registration.v1.json'),
    );
  });
});

describe('patchTypeFromNetwork', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('patches the type enum + ui:enumNames from the live network config', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          domains: [
            { id: 'seeker', label: 'Seekers' },
            { id: 'provider', label: 'Providers' },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const schema = { properties: { type: { enum: ['old'] } } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);

    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker', 'provider']);
    expect(props.type!.oneOf).toEqual([
      { const: 'seeker', title: 'Seekers' },
      { const: 'provider', title: 'Providers' },
    ]);
    expect(uiSchema.type).toEqual({ 'ui:enumNames': ['Seekers', 'Providers'] });
  });

  it('falls back to the id when a domain has no label', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [{ id: 'tourist' }] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: { type: {} } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.oneOf).toEqual([{ const: 'tourist', title: 'tourist' }]);
  });

  it('leaves the schema untouched when the response is not ok', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
    expect(uiSchema.type).toBeUndefined();
  });

  it('leaves the schema untouched when domains is empty', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    await patchTypeFromNetwork(schema, {});
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
  });

  it('falls back silently when the fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    await expect(patchTypeFromNetwork(schema, {})).resolves.toBeUndefined();
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
  });

  it('no-ops when the schema has no `type` property', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [{ id: 'seeker' }] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: {} } as never;
    await expect(patchTypeFromNetwork(schema, {})).resolves.toBeUndefined();
  });
});

describe('loadRegistrationSchema', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    readFileMock.mockReset();
  });

  it('loads schema + uiSchema and patches the type enum', async () => {
    readFileMock
      .mockResolvedValueOnce(
        JSON.stringify({ type: 'object', properties: { type: { enum: ['old'] } } }),
      )
      .mockResolvedValueOnce(JSON.stringify({ type: {} }));
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ domains: [{ id: 'seeker', label: 'Seekers' }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await loadRegistrationSchema();
    expect(result.schema.properties).toHaveProperty('type');
    expect(
      (result.schema.properties as Record<string, Record<string, unknown>>).type!.enum,
    ).toEqual(['seeker']);
    expect(result.uiSchema.type).toEqual({ 'ui:enumNames': ['Seekers'] });
  });
});
