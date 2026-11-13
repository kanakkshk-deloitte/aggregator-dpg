'use client';

/**
 * Reads the deployment's brand and domain config from the BFF (web app).
 *
 * The sidebar, topbar and dashboard tabs read from here, so one web image
 * serves any network. Returns a Blue Dots default while loading, and also
 * after a failed fetch, which is logged to the console.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { jsonFetch } from '../services/http';

/**
 * One dashboard tile: the rollup key to read and its label.
 *
 * Mirrors network-config `DashboardTileDef`.
 */
export interface DashboardTileDef {
  field: string;
  label: string;
}

/**
 * Per-domain dashboard tiles, split into profile and user groups.
 * Both are optional; the UI uses default tiles when absent.
 */
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
  /** Optional group-heading overrides; UI falls back to localised "Profiles" / "Users". */
  profile_title?: string;
  user_title?: string;
}

/**
 * Network-wide bucket-label overrides from network.json.
 * Keys are Signals bucket names; values are the network's labels.
 */
export interface DashboardBuckets {
  by_status?: {
    new?: string;
    active?: string;
    at_risk?: string;
    inactive?: string;
  };
  by_initiated_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
  by_received_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
}

/**
 * One entry of a domain's `status_rules` from network.json. `label` and
 * `description` are optional UI copy rendered on the dashboard status cards.
 */
export interface StatusRule {
  status: string;
  label?: string;
  description?: string;
}

export interface AggregatorConfigDomain {
  id: string;
  label: string;
  plural_label: string;
  item_type: string;
  /**
   * Mirrors network.json `guardian_consent_required`. When true, the
   * registration form collects a birth year. Treated as `false` when absent.
   */
  guardian_consent_required?: boolean;
  /**
   * Mirrors network.json `go_live_required`. The registration form shows the
   * consent step only if this includes `consent_required`. Treated as `[]` when absent.
   */
  go_live_required?: string[];
  dashboardTiles?: DashboardTiles;
  status_rules?: StatusRule[];
}

/**
 * One declared per-link registration mode from network config. `label_i18n_key`
 * names the admin dropdown label; `submission_shape` drives the public form;
 * `public_hint_i18n_key` (nullable) is rendered beneath the public form.
 */
export interface RegistrationModeConfig {
  label_i18n_key: string;
  submission_shape: 'account_only' | 'account_and_profile';
  public_hint_i18n_key: string | null;
  /**
   * Whether links in this mode offer the Signals UI hand-off. Resolved
   * server-side, so the client reads it directly.
   */
  signals_cta?: boolean;
}

/**
 * Brand palette swatch. The brand types mirror `@aggregator-dpg/network-config/interface`.
 *
 * They are copied here to keep the Zod schemas out of the client bundle.
 * Keep them in sync with `BrandConfigSchema`.
 */
export interface BrandPaletteSwatch {
  name: string;
  hex: string;
}

export interface BrandGradient {
  name: string;
  from: string;
  to: string;
}

export interface BrandPalette {
  primary?: BrandPaletteSwatch[];
  secondary?: BrandPaletteSwatch[];
  accent?: BrandPaletteSwatch[];
  gradients?: BrandGradient[];
}

export interface BrandTypographyFace {
  family: string;
  weight: string;
  sampleCopy?: string;
}

export interface BrandTypography {
  primaryFont: string;
  headings?: BrandTypographyFace;
  body?: BrandTypographyFace;
}

export interface BrandLogo {
  default?: string;
  light?: string;
  withStrapline?: string;
  withStraplineLight?: string;
  onBrand?: string;
}

/**
 * One "Owned by <party>" row on the login hero. Mirrors `BrandAttributionSchema`.
 * Each entry is a different organisation, unlike {@link BrandLogo}.
 */
export interface BrandAttribution {
  label: string;
  name: string;
  logo?: string;
  /** Dark-mode variant of `logo`; falls back to `logo` when absent. */
  logoLight?: string;
}

export interface AggregatorConfigPayload {
  aggregator: {
    name: string;
    legal_name?: string;
    contact_email?: string;
  };
  brand: {
    short_name: string;
    long_name: string;
    tagline?: string;
    strapline?: string;
    url_slug: string;
    primary_color?: string;
    accent_color?: string;
    logo_url?: string;
    favicon_url?: string;
    palette?: BrandPalette;
    typography?: BrandTypography;
    logo?: BrandLogo;
    attribution?: BrandAttribution[];
  };
  network: {
    id: string;
    display_name?: string;
  };
  domains: AggregatorConfigDomain[];
  /**
   * Deploy-time capability flags from the api. `custom_roles` gates the
   * console Roles admin UI and its BFF proxies.
   */
  features: { custom_roles: boolean };
  dashboardBuckets?: DashboardBuckets;
  /** Per-link registration modes declared by the network (admin dropdown source). */
  registration_modes?: Record<string, RegistrationModeConfig>;
  /** Per-domain Signals UI login URLs. A domain without a URL has no Signals hand-off. */
  signals_ui_urls?: Record<string, string>;
}

/** Fallback config used while loading and after a failed fetch. */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfigPayload = {
  aggregator: { name: 'Aggregator' },
  brand: {
    short_name: 'Blue Dots',
    long_name: 'Blue Dots Aggregator Portal',
    tagline: 'Track every participant in your network — at a glance.',
    url_slug: 'dashboard',
    primary_color: '#2563EB',
  },
  network: { id: 'blue_dot' },
  domains: [
    { id: 'seeker', label: 'Seekers', plural_label: 'Seekers', item_type: 'profile_1.0' },
    { id: 'provider', label: 'Providers', plural_label: 'Providers', item_type: 'job_posting_1.0' },
  ],
  // Custom roles stay off unless the api turns them on.
  features: { custom_roles: false },
};

export function useAggregatorConfig() {
  const query = useQuery({
    queryKey: ['aggregator-config'],
    queryFn: () => jsonFetch<AggregatorConfigPayload>('/api/aggregator-config'),
    // Config rarely changes between deploys.
    staleTime: 5 * 60 * 1000,
  });
  const { error } = query;
  // On failure callers fall back to the default config, which turns off
  // config-gated surfaces. Log it so the failure is visible.
  useEffect(() => {
    if (!error) return;
    console.error(
      '[aggregator-config] fetch failed — falling back to default branding; config-gated surfaces (Signals hand-off, consent gates) will not render',
      {
        operation: 'aggregator-config.fetch',
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }, [error]);
  return query;
}
