/**
 * Tests for GET /v1/aggregator-config.
 *
 * Verifies that the endpoint correctly projects the resolved network config
 * into the public-safe wire format, including the optional `dashboardTiles`
 * per domain and top-level `dashboardBuckets` introduced in Task 5.
 *
 * @module apps/api/routes/aggregator-config.test
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

describe('GET /v1/aggregator-config', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _setNetworkConfig(buildBlueDotConfig());
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setNetworkConfig(null);
  });

  it('returns 200 with brand + network + domains', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.brand).toBeDefined();
    expect(body.network).toBeDefined();
    expect(Array.isArray(body.domains)).toBe(true);
  });

  it('exposes the registration_modes block from the resolved config', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      registration_modes: Record<
        string,
        { label_i18n_key: string; submission_shape: string; public_hint_i18n_key: string | null }
      >;
    };
    expect(body.registration_modes).toBeDefined();
    expect(body.registration_modes.voice?.submission_shape).toBe('account_only');
    expect(body.registration_modes.form?.submission_shape).toBe('account_and_profile');
    expect(body.registration_modes.voice?.public_hint_i18n_key).toBe(
      'registration_mode.voice.hint',
    );
  });

  it('surfaces dashboardTiles per domain when the resolved config has them', async () => {
    const withTiles: ResolvedNetworkConfig = buildBlueDotConfig({
      domains: {
        seeker: {
          id: 'seeker',
          label: 'Seeker',
          pluralLabel: 'Seekers',
          itemType: 'profile_1.0',
          schema: {},
          identity: { name: 'name', phone: 'phone', email: 'email' },
          guardianConsentRequired: false,
          goLiveRequired: [],
          dashboardTiles: {
            profile: [
              { field: 'total_items', label: 'Profiles' },
              { field: 'complete_profiles', label: 'Complete' },
            ],
            user: [{ field: 'total_users', label: 'Total Seekers' }],
          },
        },
        provider: {
          id: 'provider',
          label: 'Provider',
          pluralLabel: 'Providers',
          itemType: 'job_posting_1.0',
          schema: {},
          identity: {
            name: 'jobProviderName',
            phone: 'hiringManagerPhoneNumber',
            email: 'hiringManagerEmail',
          },
          guardianConsentRequired: false,
          goLiveRequired: [],
        },
      },
      dashboardBuckets: {
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
    });
    _setNetworkConfig(withTiles);

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      domains: Array<{
        id: string;
        dashboardTiles?: {
          profile?: Array<{ field: string; label: string }>;
          user?: Array<{ field: string; label: string }>;
        };
      }>;
      dashboardBuckets?: {
        by_initiated_action_status?: Record<string, string>;
        by_received_action_status?: Record<string, string>;
      };
    };

    const seeker = body.domains.find((d) => d.id === 'seeker');
    expect(seeker?.dashboardTiles?.profile?.[0]).toEqual({
      field: 'total_items',
      label: 'Profiles',
    });
    expect(seeker?.dashboardTiles?.user?.[0]).toEqual({
      field: 'total_users',
      label: 'Total Seekers',
    });

    expect(body.dashboardBuckets?.by_initiated_action_status).toEqual({
      create: 'Requested',
      accept: 'Accepted',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
    expect(body.dashboardBuckets?.by_received_action_status).toEqual({
      create: 'Requests',
      accept: 'Connected',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
  });

  it('omits dashboardTiles / dashboardBuckets when resolved config lacks them', async () => {
    // buildBlueDotConfig returns a config without dashboardTiles or dashboardBuckets
    _setNetworkConfig(buildBlueDotConfig());

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      domains: Array<{ id: string; dashboardTiles?: unknown }>;
      dashboardBuckets?: unknown;
    };

    for (const domain of body.domains) {
      expect(domain.dashboardTiles).toBeUndefined();
    }
    expect(body.dashboardBuckets).toBeUndefined();
  });

  it('surfaces optional brand design-token fields when the resolved config carries them', async () => {
    const withBrandTokens: ResolvedNetworkConfig = buildBlueDotConfig({
      aggregator: {
        ...buildBlueDotConfig().aggregator,
        brand: {
          ...buildBlueDotConfig().aggregator.brand,
          primary_color: '#112233',
          accent_color: '#445566',
          favicon_url: 'https://example.invalid/favicon.ico',
          typography: { primaryFont: 'Inter' },
        },
      },
    });
    _setNetworkConfig(withBrandTokens);

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      brand: {
        primary_color?: string;
        accent_color?: string;
        favicon_url?: string;
        typography?: { primaryFont: string };
      };
    };
    expect(body.brand.primary_color).toBe('#112233');
    expect(body.brand.accent_color).toBe('#445566');
    expect(body.brand.favicon_url).toBe('https://example.invalid/favicon.ico');
    expect(body.brand.typography?.primaryFont).toBe('Inter');
  });

  it('always exposes features.custom_roles, false by default (opt-in)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as { features: { custom_roles: boolean } };
    expect(body.features).toEqual({ custom_roles: false });
  });

  it('reports features.custom_roles=true when the flag is on', async () => {
    const prev = config.RBAC_CUSTOM_ROLES_ENABLED;
    config.RBAC_CUSTOM_ROLES_ENABLED = true;
    const withFlag = await buildApp();
    try {
      const res = await withFlag.inject({ method: 'GET', url: '/v1/aggregator-config' });
      const body = res.json() as { features: { custom_roles: boolean } };
      expect(body.features.custom_roles).toBe(true);
    } finally {
      await withFlag.close();
      config.RBAC_CUSTOM_ROLES_ENABLED = prev;
    }
  });

  it('exposes signals_ui_urls (empty when the env var is unset)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as { signals_ui_urls: Record<string, string> };
    expect(body.signals_ui_urls).toEqual({});
  });

  it('passes an explicit signals_cta flag through unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as {
      registration_modes: Record<string, { signals_cta: boolean }>;
    };
    expect(body.registration_modes.form?.signals_cta).toBe(true);
    expect(body.registration_modes.voice?.signals_cta).toBe(false);
  });

  it('resolves signals_cta from the default when the mode omits it', async () => {
    // Modes here deliberately omit `signals_cta` so the only way the wire
    // value can be a boolean is through signalsCtaEnabled's default-fallback
    // branch (submission_shape === 'account_and_profile'), not a fixture
    // literal or raw passthrough of the config object.
    const withDefaultedModes: ResolvedNetworkConfig = buildBlueDotConfig({
      aggregator: {
        ...buildBlueDotConfig().aggregator,
        registration_modes: {
          profile_mode: {
            label_i18n_key: 'registration_mode.profile_mode.label',
            submission_shape: 'account_and_profile',
            public_hint_i18n_key: null,
          },
          account_mode: {
            label_i18n_key: 'registration_mode.account_mode.label',
            submission_shape: 'account_only',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    _setNetworkConfig(withDefaultedModes);

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    const body = res.json() as {
      registration_modes: Record<string, { signals_cta: boolean }>;
    };
    expect(body.registration_modes.profile_mode?.signals_cta).toBe(true);
    expect(body.registration_modes.account_mode?.signals_cta).toBe(false);
  });

  it('GET /v1/participant-consent returns the resolved consent document', async () => {
    const doc = {
      documents: {
        terms: { current_version: 1, versions: [{ version: 1, title: 'T', content: 'c' }] },
        privacy: { current_version: 1, versions: [{ version: 1, title: 'P', content: 'p' }] },
      },
    };
    _setNetworkConfig(buildBlueDotConfig({ participantConsent: doc }));

    const res = await app.inject({ method: 'GET', url: '/v1/participant-consent' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { participant_consent: typeof doc | null };
    expect(body.participant_consent).toEqual(doc);
  });

  it('GET /v1/participant-consent returns null when no consent_source is configured', async () => {
    _setNetworkConfig(buildBlueDotConfig());

    const res = await app.inject({ method: 'GET', url: '/v1/participant-consent' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { participant_consent: unknown };
    expect(body.participant_consent).toBeNull();
  });
});
