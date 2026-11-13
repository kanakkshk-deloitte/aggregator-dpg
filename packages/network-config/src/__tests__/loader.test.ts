import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileNetworkConfigLoader } from '../loader.js';
import { AggregatorConfigSchema, DEFAULT_ORGANISATION } from '../interface.js';
import { URL_PATTERN } from '../uri-fields.js';

const BLUE_DOT_YAML = `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
  brand:
    short_name: Blue Dots
    long_name: Blue Dots Aggregator Portal
    url_slug: blue-dots
`;

const BLUE_DOT_NETWORK = {
  id: 'blue_dot',
  display_name: 'Blue Dot',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          properties: {
            name: { type: 'string' },
            phone: { type: 'string', format: 'tel' },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
    {
      id: 'provider',
      item_schemas: {
        'job_posting_1.0': {
          properties: {
            jobProviderName: { type: 'string' },
            hiringManagerPhoneNumber: { type: 'string', format: 'tel' },
            hiringManagerEmail: { type: 'string', format: 'email' },
          },
        },
      },
    },
  ],
};

describe('FileNetworkConfigLoader', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves both blue_dot domains with sniffed identity selectors', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify(BLUE_DOT_NETWORK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const resolved = result.value;
    expect(resolved.network.id).toBe('blue_dot');
    expect(resolved.domainIds).toEqual(['seeker', 'provider']);
    expect(resolved.domains['seeker']?.itemType).toBe('profile_1.0');
    expect(resolved.domains['seeker']?.identity).toEqual({
      name: 'name',
      phone: 'phone',
      email: 'email',
    });
    expect(resolved.domains['provider']?.itemType).toBe('job_posting_1.0');
    expect(resolved.domains['provider']?.identity).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
  });

  it('gives every link field the Signals URL rule in the resolved schema (#904)', async () => {
    const network = structuredClone(BLUE_DOT_NETWORK);
    Object.assign(network.domains[0]!.item_schemas['profile_1.0']!.properties, {
      website: { type: 'string', 'x-uri': true },
      catalog_url: { type: 'string', format: 'uri' },
    });
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify(network), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const props = (
      result.value.domains['seeker']?.schema as { properties: Record<string, unknown> }
    ).properties;
    expect(props['website']).toEqual({ type: 'string', 'x-uri': true, pattern: URL_PATTERN });
    expect(props['catalog_url']).toEqual({ type: 'string', 'x-uri': true, pattern: URL_PATTERN });
    // Identity sniffing still sees the untouched contact fields.
    expect(result.value.domains['seeker']?.identity.email).toBe('email');
  });

  it('returns CONFIG_FILE_MISSING when the YAML is absent', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath: path.join(tmpDir, 'missing.yaml'),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_FILE_MISSING');
  });

  it('falls back to cached network.json on upstream failure', async () => {
    const cacheDir = path.join(tmpDir, 'cache');
    let calls = 0;
    const fetchOk: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
    };
    const fetchFail: typeof fetch = async () => {
      calls += 1;
      return new Response('upstream down', { status: 503 });
    };
    // First boot — fetches + writes cache.
    const first = new FileNetworkConfigLoader({ configPath, cacheDir, fetchImpl: fetchOk });
    const r1 = await first.load();
    expect(r1.success).toBe(true);
    // Second boot — upstream is down; cache rescues us.
    const second = new FileNetworkConfigLoader({ configPath, cacheDir, fetchImpl: fetchFail });
    const r2 = await second.load();
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.value.network.id).toBe('blue_dot');
    expect(calls).toBe(2);
  });

  it('caches the resolved config — second load() returns the same singleton', async () => {
    let calls = 0;
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const r1 = await loader.load();
    const r2 = await loader.load();
    expect(r1.success && r2.success).toBe(true);
    if (r1.success && r2.success) expect(r1.value).toBe(r2.value);
    expect(calls).toBe(1);
  });

  it('rejects a network.json missing required fields', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify({ domains: [] }), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('NETWORK_FETCH_FAILED');
  });

  it('merges a sibling brand.json into the resolved brand block', async () => {
    const brandJson = {
      brand: { strapline: '' },
      logo: { default: '/brand/blue-dot/logo.png' },
      colours: {
        primary: [{ name: 'Blue 500', hex: '#0074ff' }],
        gradients: [{ name: 'Sky', from: '#0074ff', to: '#a4daff' }],
      },
      typography: { primaryFont: 'Arial' },
    };
    await fs.writeFile(path.join(tmpDir, 'brand.json'), JSON.stringify(brandJson), 'utf8');
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const brand = result.value.aggregator.brand;
    expect(brand.strapline).toBe('');
    expect(brand.logo?.default).toBe('/brand/blue-dot/logo.png');
    expect(brand.palette?.primary?.[0]?.hex).toBe('#0074ff');
    expect(brand.palette?.gradients?.[0]?.from).toBe('#0074ff');
    expect(brand.typography?.primaryFont).toBe('Arial');
  });

  it('boots cleanly when brand.json is absent (backward compat)', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const brand = result.value.aggregator.brand;
    expect(brand.palette).toBeUndefined();
    expect(brand.typography).toBeUndefined();
    expect(brand.logo).toBeUndefined();
  });

  it('rejects a malformed brand.json with CONFIG_PARSE_FAILED', async () => {
    await fs.writeFile(path.join(tmpDir, 'brand.json'), '{ not json', 'utf8');
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_PARSE_FAILED');
  });

  it('passes dashboard_tiles and dashboard_buckets through into the resolved config', async () => {
    const networkWithDashboard = {
      id: 'test_net',
      display_name: 'Test',
      domains: [
        {
          id: 'seeker',
          description: 'Seekers',
          item_schemas: {
            'profile_1.0': {
              properties: {
                name: { type: 'string' },
                phone: { type: 'string', format: 'tel' },
                email: { type: 'string', format: 'email' },
              },
            },
          },
          dashboard_tiles: {
            profile: [
              { field: 'total_items', label: 'Profiles' },
              { field: 'complete_profiles', label: 'Complete' },
            ],
            user: [{ field: 'total_users', label: 'Total Seekers' }],
          },
          status_rules: [
            { status: 'new', label: 'New', description: 'Last 7 days' },
            { status: 'active', label: 'Active' },
          ],
        },
      ],
      dashboard_buckets: {
        by_status: { new: 'New', active: 'Active', at_risk: 'At Risk', inactive: 'Inactive' },
        by_initiated_action_status: {
          create: 'Requested',
          accept: 'Accepted',
          reject: 'Declined',
          cancel: 'Cancelled',
        },
        by_received_action_status: {
          create: 'Requests',
          accept: 'Connected',
          reject: 'Declined',
          cancel: 'Cancelled',
        },
      },
    };
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify(networkWithDashboard), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const resolved = result.value;
    expect(resolved.domains['seeker']?.dashboardTiles?.profile?.[0]).toEqual({
      field: 'total_items',
      label: 'Profiles',
    });
    expect(resolved.domains['seeker']?.dashboardTiles?.user?.[0]).toEqual({
      field: 'total_users',
      label: 'Total Seekers',
    });
    expect(resolved.dashboardBuckets?.by_initiated_action_status).toEqual({
      create: 'Requested',
      accept: 'Accepted',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
    expect(resolved.dashboardBuckets?.by_received_action_status).toEqual({
      create: 'Requests',
      accept: 'Connected',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
    expect(resolved.domains['seeker']?.statusRules).toEqual([
      { status: 'new', label: 'New', description: 'Last 7 days' },
      { status: 'active', label: 'Active' },
    ]);
  });

  it('leaves dashboardTiles and dashboardBuckets undefined when network.json omits them', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify(BLUE_DOT_NETWORK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const resolved = result.value;
    expect(resolved.domains['seeker']?.dashboardTiles).toBeUndefined();
    expect(resolved.dashboardBuckets).toBeUndefined();
  });
});

describe('AggregatorConfigSchema.registration_modes', () => {
  const baseAggregator = {
    name: 'Test',
    contact_email: 'a@x.com',
    network: { source: 'http://x', csv_array_delimiter: '|', field_overrides: {} },
    brand: {
      short_name: 'T',
      long_name: 'Test',
      url_slug: 't',
      primary_color: '#000000',
      accent_color: '#111111',
    },
    domain_labels: {},
    onboarding: { presume_consent: true },
  };

  it('accepts a declared mode with required fields', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          voice: {
            label_i18n_key: 'registration_mode.voice.label',
            submission_shape: 'account_only',
            public_hint_i18n_key: 'registration_mode.voice.hint',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown submission_shape', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          weird: {
            label_i18n_key: 'x',
            submission_shape: 'BOGUS',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts null public_hint_i18n_key', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          form: {
            label_i18n_key: 'registration_mode.form.label',
            submission_shape: 'account_and_profile',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('defaults organisation to a flat tree when the block is absent', () => {
    const result = AggregatorConfigSchema.safeParse({ aggregator: baseAggregator });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.aggregator.organisation).toEqual(DEFAULT_ORGANISATION);
    expect(DEFAULT_ORGANISATION).toEqual({
      hierarchy: { max_depth: 1, max_total_orgs: 50 },
    });
  });

  it('accepts tree limits', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        organisation: {
          hierarchy: { max_depth: 3, max_children: 50, max_total_orgs: 200 },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.aggregator.organisation.hierarchy).toEqual({
      max_depth: 3,
      max_children: 50,
      max_total_orgs: 200,
    });
  });

  it('fills hierarchy defaults inside a partial block', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: { ...baseAggregator, organisation: { hierarchy: { max_depth: 2 } } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.aggregator.organisation).toEqual({
      hierarchy: { max_depth: 2, max_total_orgs: 50 },
    });
  });

  it('loads a config that still has a known_as block, and ignores the block', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        organisation: {
          hierarchy: { max_depth: 2 },
          known_as: {
            values: [{ key: 'state', name: 'State', depths: [5] }],
            suggest: [{ depth: 1, key: 'state' }],
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.aggregator.organisation.hierarchy).toEqual({
      max_depth: 2,
      max_total_orgs: 50,
    });
    expect(result.data.aggregator.organisation.known_as).toBeDefined();
  });

  it.each([
    ['max_depth 0', { max_depth: 0 }],
    ['max_depth 11', { max_depth: 11 }],
    ['a fractional max_depth', { max_depth: 1.5 }],
    ['max_children 0', { max_children: 0 }],
    ['max_total_orgs 0', { max_total_orgs: 0 }],
  ])('rejects organisation with %s', (_case, hierarchy) => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: { ...baseAggregator, organisation: { hierarchy } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-snake_case mode keys', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          'Bad-Key': {
            label_i18n_key: 'x',
            submission_shape: 'account_only',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('FileNetworkConfigLoader — AGGREGATOR_NETWORK_SOURCE override (#512)', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-override-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
    delete process.env.AGGREGATOR_NETWORK_SOURCE;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.AGGREGATOR_NETWORK_SOURCE;
  });

  it('fetches network.json from the explicit override instead of the YAML source', async () => {
    const seen: string[] = [];
    const loader = new FileNetworkConfigLoader({
      configPath,
      networkSourceOverride: 'https://schemas.example.org/blue_dot/network.json',
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(seen).toEqual(['https://schemas.example.org/blue_dot/network.json']);
  });

  it('defaults the override from the AGGREGATOR_NETWORK_SOURCE env var', async () => {
    process.env.AGGREGATOR_NETWORK_SOURCE = 'https://schemas.example.org/from-env/network.json';
    const seen: string[] = [];
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(seen).toEqual(['https://schemas.example.org/from-env/network.json']);
  });

  it('uses the YAML source when no override is set', async () => {
    const seen: string[] = [];
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(seen).toEqual(['https://example.invalid/blue_dot/network.json']);
  });

  it('fails load() with CONFIG_PARSE_FAILED on a malformed override URL', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      networkSourceOverride: 'not-a-url',
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code?: string }).code).toBe('CONFIG_PARSE_FAILED');
  });

  it('boots from the env override alone when the YAML omits network.source (#512)', async () => {
    const noSourceYaml = BLUE_DOT_YAML.replace(/^\s*source:.*$/m, "    csv_array_delimiter: '|'");
    const noSourcePath = path.join(tmpDir, 'no-source.yaml');
    await fs.writeFile(noSourcePath, noSourceYaml, 'utf8');
    const seen: string[] = [];
    const loader = new FileNetworkConfigLoader({
      configPath: noSourcePath,
      networkSourceOverride: 'https://schemas.example.org/blue_dot/network.json',
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(seen).toEqual(['https://schemas.example.org/blue_dot/network.json']);
  });

  it('fails load() with CONFIG_PARSE_FAILED when neither YAML source nor override is set', async () => {
    const noSourceYaml = BLUE_DOT_YAML.replace(/^\s*source:.*$/m, "    csv_array_delimiter: '|'");
    const noSourcePath = path.join(tmpDir, 'no-source.yaml');
    await fs.writeFile(noSourcePath, noSourceYaml, 'utf8');
    const loader = new FileNetworkConfigLoader({
      configPath: noSourcePath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code?: string }).code).toBe('CONFIG_PARSE_FAILED');
    expect((result.error as { message?: string }).message).toContain('AGGREGATOR_NETWORK_SOURCE');
  });

  it('treats a blank env value as absent (falls back to the YAML source)', async () => {
    process.env.AGGREGATOR_NETWORK_SOURCE = '   ';
    const seen: string[] = [];
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(seen).toEqual(['https://example.invalid/blue_dot/network.json']);
  });
});

describe('FileNetworkConfigLoader — YAML / brand.json failure paths', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-errs-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns CONFIG_PARSE_FAILED when the YAML is syntactically invalid', async () => {
    // Tabs are illegal indentation in YAML — this always throws in the `yaml` parser.
    await fs.writeFile(configPath, 'aggregator:\n\tname: BBMP\n', 'utf8');
    const loader = new FileNetworkConfigLoader({ configPath });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_PARSE_FAILED');
    expect((result.error as { message: string }).message).toContain('YAML parse failed');
  });

  it('returns CONFIG_PARSE_FAILED when parsed YAML fails schema validation', async () => {
    // Valid YAML syntax, but `brand.short_name` (required) is missing.
    await fs.writeFile(
      configPath,
      `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
  brand:
    long_name: Missing short_name
    url_slug: blue-dots
`,
      'utf8',
    );
    const loader = new FileNetworkConfigLoader({ configPath });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_PARSE_FAILED');
    expect((result.error as { message: string }).message).toContain('failed schema validation');
  });

  it('returns CONFIG_PARSE_FAILED when a sibling brand.json fails schema validation', async () => {
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
    // `logo` must be an object per BrandLogoSchema — a bare string fails validation.
    await fs.writeFile(
      path.join(tmpDir, 'brand.json'),
      JSON.stringify({ logo: 'not-an-object' }),
      'utf8',
    );
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_PARSE_FAILED');
    expect((result.error as { message: string }).message).toContain(
      'brand.json failed schema validation',
    );
  });
});

describe('FileNetworkConfigLoader — network fetch / cache edge cases', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-fetch-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns NETWORK_FETCH_FAILED when the fetch transport itself throws and no cache is configured', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('NETWORK_FETCH_FAILED');
    expect((result.error as { message: string }).message).toContain('transport failure');
  });

  it('returns NETWORK_FETCH_FAILED with a cache-miss reason when upstream fails and no cache file exists yet', async () => {
    const cacheDir = path.join(tmpDir, 'cache-empty');
    const loader = new FileNetworkConfigLoader({
      configPath,
      cacheDir,
      fetchImpl: async () => new Response('down', { status: 503 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('NETWORK_FETCH_FAILED');
    expect((result.error as { message: string }).message).toContain('cache miss');
  });

  it('boots successfully even when writing the last-known-good cache fails (best-effort)', async () => {
    // `blocker` is a regular file, so treating it as a directory segment of the
    // cache path makes `fs.mkdir` fail — the write must be swallowed silently.
    const blockerFile = path.join(tmpDir, 'blocker');
    await fs.writeFile(blockerFile, 'x', 'utf8');
    const cacheDir = path.join(blockerFile, 'cache');
    const loader = new FileNetworkConfigLoader({
      configPath,
      cacheDir,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
  });
});

describe('FileNetworkConfigLoader — network.json structural validation', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-netval-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a network.json payload that is not an object', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response('null', { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { message: string }).message).toContain(
      'network.json must be an object',
    );
  });

  it('rejects a network.json with zero domains', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'blue_dot', domains: [] }), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { message: string }).message).toContain(
      'must declare at least one domain',
    );
  });

  it('rejects a domain entry missing `id`', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'blue_dot', domains: [{ item_schemas: {} }] }), {
          status: 200,
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { message: string }).message).toContain(
      'each domain must declare `id`',
    );
  });

  it('rejects a domain entry missing item_schemas', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'blue_dot', domains: [{ id: 'seeker' }] }), {
          status: 200,
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { message: string }).message).toContain('missing item_schemas');
  });
});

describe('FileNetworkConfigLoader — domain resolution failures', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-domres-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns DOMAIN_RESOLUTION_FAILED when a domain declares an empty item_schemas map', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ id: 'blue_dot', domains: [{ id: 'seeker', item_schemas: {} }] }),
          { status: 200 },
        ),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('DOMAIN_RESOLUTION_FAILED');
    expect((result.error as { message: string }).message).toContain('has no item_schemas');
  });

  it('returns DOMAIN_RESOLUTION_FAILED when identity selectors cannot be sniffed and no override exists', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'blue_dot',
            domains: [
              {
                id: 'seeker',
                item_schemas: { 'profile_1.0': { properties: { age: { type: 'integer' } } } },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('DOMAIN_RESOLUTION_FAILED');
    expect((result.error as { message: string }).message).toContain(
      'could not resolve identity selectors',
    );
  });

  it('uses an explicit field_overrides entry instead of sniffing when the schema has no recognisable identity fields', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'blue_dot',
            domains: [
              {
                id: 'seeker',
                item_schemas: { 'profile_1.0': { properties: { age: { type: 'integer' } } } },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    // Rewrite the YAML with a field_overrides block for `seeker` — the
    // schema alone has no phone/email/name-shaped fields.
    await fs.writeFile(
      configPath,
      `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
    field_overrides:
      seeker:
        name: applicant_id
        phone: contact_number
        email: contact_email_addr
  brand:
    short_name: Blue Dots
    long_name: Blue Dots Aggregator Portal
    url_slug: blue-dots
`,
      'utf8',
    );
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.domains['seeker']?.identity).toEqual({
      name: 'applicant_id',
      phone: 'contact_number',
      email: 'contact_email_addr',
    });
  });
});

describe('FileNetworkConfigLoader — domain_labels overrides', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-labels-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses configured domain_labels (tab_label / singular / plural) instead of the titleCase default', async () => {
    await fs.writeFile(
      configPath,
      `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
  brand:
    short_name: Blue Dots
    long_name: Blue Dots Aggregator Portal
    url_slug: blue-dots
  domain_labels:
    seeker:
      tab_label: Job Seekers
      singular: Job Seeker
      plural: Job Seekers List
`,
      'utf8',
    );
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.domains['seeker']?.label).toBe('Job Seekers');
    expect(result.value.domains['seeker']?.pluralLabel).toBe('Job Seekers List');
    // provider has no override — falls back to the titleCase default.
    expect(result.value.domains['provider']?.label).toBe('Provider');
    expect(result.value.domains['provider']?.pluralLabel).toBe('Providers');
  });
});

describe('FileNetworkConfigLoader — default global fetch', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-globalfetch-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('falls back to the global fetch when no fetchImpl override is supplied', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // No `fetchImpl` supplied — the loader must use the stubbed global fetch.
    const loader = new FileNetworkConfigLoader({ configPath });
    const result = await loader.load();
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.invalid/blue_dot/network.json',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});

describe('FileNetworkConfigLoader — brand.json present but empty', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-emptybrand-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('leaves the brand block untouched when brand.json parses but declares none of the mergeable fields', async () => {
    await fs.writeFile(path.join(tmpDir, 'brand.json'), JSON.stringify({}), 'utf8');
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const brand = result.value.aggregator.brand;
    expect(brand.palette).toBeUndefined();
    expect(brand.typography).toBeUndefined();
    expect(brand.logo).toBeUndefined();
    expect(brand.strapline).toBeUndefined();
  });

  describe('participant consent fetch', () => {
    const CONSENT_SOURCE = 'https://example.invalid/blue_dot/consent.json';
    const CONSENT_DOC = {
      documents: {
        terms: { current_version: 1, versions: [{ version: 1, title: 'Terms', content: 'body' }] },
        privacy: {
          current_version: 1,
          versions: [{ version: 1, title: 'Privacy', content: 'body' }],
        },
      },
    };

    /** Routes the consent URL to `consent`; everything else returns network.json. */
    function makeFetch(consent: () => Response | Promise<Response>): typeof fetch {
      return (async (input: RequestInfo | URL) => {
        if (String(input) === CONSENT_SOURCE) return consent();
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      }) as unknown as typeof fetch;
    }

    beforeEach(() => {
      delete process.env.AGGREGATOR_PARTICIPANT_CONSENT_SOURCE;
    });

    it('fetches + attaches the participant consent document from consent_source', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => new Response(JSON.stringify(CONSENT_DOC), { status: 200 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toEqual(CONSENT_DOC);
    });

    it('reads consent_source from the YAML when no override is set', async () => {
      const yamlWithConsent = `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
    consent_source: ${CONSENT_SOURCE}
  brand:
    short_name: Blue Dots
    long_name: Blue Dots Aggregator Portal
    url_slug: blue-dots
`;
      await fs.writeFile(configPath, yamlWithConsent, 'utf8');
      const loader = new FileNetworkConfigLoader({
        configPath,
        fetchImpl: makeFetch(() => new Response(JSON.stringify(CONSENT_DOC), { status: 200 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toEqual(CONSENT_DOC);
    });

    it('leaves participantConsent undefined when no consent_source is configured', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        fetchImpl: makeFetch(() => new Response('unused', { status: 200 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toBeUndefined();
    });

    it('is non-fatal: a consent fetch 4xx leaves participantConsent undefined but load succeeds', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => new Response('missing', { status: 404 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toBeUndefined();
    });

    it('is non-fatal: a consent fetch transport throw leaves participantConsent undefined', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => Promise.reject(new Error('boom'))),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toBeUndefined();
    });

    it('rejects a consent document with the wrong shape (no documents block)', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toBeUndefined();
    });

    it('recovers the last-known-good consent from cache when a later fetch fails', async () => {
      const cacheDir = path.join(tmpDir, 'cache');
      const good = new FileNetworkConfigLoader({
        configPath,
        cacheDir,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => new Response(JSON.stringify(CONSENT_DOC), { status: 200 })),
      });
      await good.load(); // writes the last-known-good cache

      const degraded = new FileNetworkConfigLoader({
        configPath,
        cacheDir,
        consentSourceOverride: CONSENT_SOURCE,
        fetchImpl: makeFetch(() => new Response('down', { status: 500 })),
      });
      const result = await degraded.load();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.participantConsent).toEqual(CONSENT_DOC);
    });

    it('fails load() with CONFIG_PARSE_FAILED when the override URL is malformed', async () => {
      const loader = new FileNetworkConfigLoader({
        configPath,
        consentSourceOverride: 'not-a-url',
        fetchImpl: makeFetch(() => new Response('unused', { status: 200 })),
      });
      const result = await loader.load();
      expect(result.success).toBe(false);
      if (result.success) return;
      expect((result.error as { code: string }).code).toBe('CONFIG_PARSE_FAILED');
      expect((result.error as { message: string }).message).toContain(
        'AGGREGATOR_PARTICIPANT_CONSENT_SOURCE',
      );
    });
  });
});
