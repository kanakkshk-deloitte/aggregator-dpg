import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileNetworkConfigLoader } from '../loader.js';
import { AggregatorConfigSchema } from '../interface.js';

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
