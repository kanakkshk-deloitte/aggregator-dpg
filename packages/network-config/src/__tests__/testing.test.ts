import { describe, it, expect } from 'vitest';
import {
  InMemoryNetworkConfigLoader,
  buildBlueDotConfig,
  buildPurpleDotConfig,
} from '../testing.js';

describe('buildBlueDotConfig', () => {
  it('returns a fully-resolved blue_dot config with seeker + provider domains', () => {
    const config = buildBlueDotConfig();
    expect(config.network.id).toBe('blue_dot');
    expect(config.domainIds).toEqual(['seeker', 'provider']);
    expect(config.domains['seeker']?.itemType).toBe('profile_1.0');
    expect(config.domains['seeker']?.identity).toEqual({
      name: 'name',
      phone: 'phone',
      email: 'email',
    });
    expect(config.domains['provider']?.itemType).toBe('job_posting_1.0');
    expect(config.domains['provider']?.identity).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
    expect(config.aggregator.registration_modes['form']?.submission_shape).toBe(
      'account_and_profile',
    );
    expect(config.aggregator.registration_modes['voice']?.submission_shape).toBe('account_only');
    expect(config.aggregator.onboarding.bulk_max_rows).toBe(10000);
    expect(config.aggregator.brand.short_name).toBe('Blue Dots');
  });

  it('applies a top-level override without disturbing the rest of the deterministic defaults', () => {
    const config = buildBlueDotConfig({ domainIds: ['seeker'] });
    expect(config.domainIds).toEqual(['seeker']);
    // Overriding domainIds doesn't prune the `domains` map itself — only the
    // ordering list callers iterate over changes.
    expect(config.domains['provider']).toBeDefined();
    expect(config.network.id).toBe('blue_dot');
  });

  it('lets a test override a nested field (aggregator.name) via a full replacement object', () => {
    const base = buildBlueDotConfig();
    const config = buildBlueDotConfig({
      aggregator: { ...base.aggregator, name: 'Custom Aggregator' },
    });
    expect(config.aggregator.name).toBe('Custom Aggregator');
    expect(config.aggregator.brand.short_name).toBe('Blue Dots');
  });

  it('handles an empty-domains override (edge case) without throwing', () => {
    const config = buildBlueDotConfig({ domains: {}, domainIds: [] });
    expect(config.domainIds).toEqual([]);
    expect(config.domains).toEqual({});
    // Network + aggregator blocks are untouched by the override.
    expect(config.network.id).toBe('blue_dot');
  });
});

describe('buildPurpleDotConfig', () => {
  it('returns a fully-resolved purple_dot config with beneficiary/mobile identity naming', () => {
    const config = buildPurpleDotConfig();
    expect(config.network.id).toBe('purple_dot');
    expect(config.domainIds).toEqual(['seeker', 'provider']);
    expect(config.domains['seeker']?.identity).toEqual({
      name: 'beneficiary_name',
      phone: 'mobile_number',
      email: 'email',
    });
    expect(config.domains['provider']?.identity).toEqual({
      name: 'contact_name',
      phone: 'contact_phone',
      email: 'contact_email',
    });
    expect(config.domains['provider']?.label).toBe('Service Providers');
    expect(config.aggregator.brand.short_name).toBe('Purple Dots');
  });

  it('applies overrides on top of the deterministic defaults, distinct from blue_dot', () => {
    const config = buildPurpleDotConfig({ domainIds: ['seeker'] });
    expect(config.domainIds).toEqual(['seeker']);
    expect(config.network.id).toBe('purple_dot');
    expect(config.domains['seeker']?.identity.name).toBe('beneficiary_name');
  });
});

describe('InMemoryNetworkConfigLoader', () => {
  it('resolves load() with the exact pinned config (normal execution)', async () => {
    const pinned = buildBlueDotConfig();
    const loader = new InMemoryNetworkConfigLoader(pinned);
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toBe(pinned);
    expect(result.value.network.id).toBe('blue_dot');
  });

  it('returns the same pinned singleton across repeated calls (idempotent, no re-computation)', async () => {
    const pinned = buildPurpleDotConfig();
    const loader = new InMemoryNetworkConfigLoader(pinned);
    const r1 = await loader.load();
    const r2 = await loader.load();
    expect(r1.success && r2.success).toBe(true);
    if (r1.success && r2.success) {
      expect(r1.value).toBe(r2.value);
      expect(r1.value).toBe(pinned);
    }
  });

  it('never fails — load() always resolves ok() even for a minimal/edge-case pinned config', async () => {
    const minimal = buildBlueDotConfig({ domains: {}, domainIds: [] });
    const loader = new InMemoryNetworkConfigLoader(minimal);
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.domainIds).toEqual([]);
    expect(result.value.domains).toEqual({});
  });
});
