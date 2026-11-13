/**
 * Public config routes of the api app.
 *
 *   GET /v1/aggregator-config
 *     Returns the public part of the aggregator and network config. The web
 *     app reads it to render brand, domain labels and dashboard settings.
 *
 * No auth: every value is already public. Secrets are never included.
 *
 * @module apps/api/routes/aggregator-config
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  BrandLogo,
  BrandPalette,
  BrandTypography,
  DashboardBuckets,
  DashboardTiles,
  RegistrationMode,
  StatusRule,
} from '@aggregator-dpg/network-config/interface';
import { errorResponses } from '../errors/openapi.js';
import { getNetworkConfig } from '../services/network-config.js';
import { config, enabledRegistrationModes, signalsUiUrls } from '../config.js';
import { signalsCtaEnabled } from '../services/registration-mode/index.js';

/**
 * Wire shape of a `registration_modes` entry, with `signals_cta` always resolved to a boolean.
 */
type PublicRegistrationMode = RegistrationMode & { signals_cta: boolean };

/**
 * Public part of the resolved network config. Leaves out JSON Schemas and the full `network.json`.
 */
interface PublicAggregatorConfig {
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
  };
  network: {
    id: string;
    display_name?: string;
  };
  domains: Array<{
    id: string;
    label: string;
    plural_label: string;
    item_type: string;
    /** From network.json; drives the registration birth-year field. */
    guardian_consent_required: boolean;
    /** From network.json; drives the registration consent step. */
    go_live_required: string[];
    dashboardTiles?: DashboardTiles;
    status_rules?: StatusRule[];
  }>;
  dashboardBuckets?: DashboardBuckets;
  /** Registration modes this deployment offers; the create-link dropdown uses these keys. */
  registration_modes: Record<string, PublicRegistrationMode>;
  /** Per-domain Signals UI login URLs from `SIGNALS_UI_URLS`. Empty when unset. */
  signals_ui_urls: Readonly<Record<string, string>>;
  /** Feature flags, always present. `custom_roles` is `RBAC_CUSTOM_ROLES_ENABLED`. */
  features: { custom_roles: boolean };
}

const AggregatorConfigResponseSchema = z
  .object({
    aggregator: z
      .object({
        name: z.string(),
        legal_name: z.string().optional(),
        contact_email: z.string().optional(),
      })
      .passthrough(),
    brand: z
      .object({
        short_name: z.string(),
        long_name: z.string(),
        tagline: z.string().optional(),
        strapline: z.string().optional(),
        url_slug: z.string(),
        primary_color: z.string().optional(),
        accent_color: z.string().optional(),
        logo_url: z.string().optional(),
        favicon_url: z.string().optional(),
        attribution: z
          .array(
            z.object({
              label: z.string(),
              name: z.string(),
              logo: z.string().optional(),
              logoLight: z.string().optional(),
            }),
          )
          .optional(),
      })
      .passthrough(),
    network: z
      .object({
        id: z.string(),
        display_name: z.string().optional(),
      })
      .passthrough(),
    domains: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          plural_label: z.string(),
          item_type: z.string(),
          guardian_consent_required: z.boolean(),
          go_live_required: z.array(z.string()),
        })
        .passthrough(),
    ),
    dashboardBuckets: z
      .object({
        by_status: z.record(z.string(), z.string()).optional(),
        by_action_status: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
    registration_modes: z.record(
      z.string(),
      z.object({ label: z.string().optional(), signals_cta: z.boolean() }).passthrough(),
    ),
    // Checked at boot with `new URL()`. A plain string here, since `z.string().url()`
    // could reject a value that boot accepted and cause a 500.
    signals_ui_urls: z.record(z.string(), z.string()),
    // Always present.
    features: z.object({ custom_roles: z.boolean() }).passthrough(),
  })
  .passthrough();

export async function registerAggregatorConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/aggregator-config',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['aggregator-config'],
        summary: 'Public brand + network config',
        description:
          'Brand palette/logo + per-domain labels (tab name, plural, tiles, status_rules) + dashboard bucket labels. Web BFF reads this at boot to theme the portal and render the dashboard config-driven.',
        response: { 200: AggregatorConfigResponseSchema, ...errorResponses(500, 503) },
      },
    },
    async (_req, reply) => {
      const cfg = await getNetworkConfig();
      // Same helper as the create-link check, so the dropdown matches what creation accepts.
      const enabledModes = new Set(
        enabledRegistrationModes(Object.keys(cfg.aggregator.registration_modes ?? {})),
      );
      const payload: PublicAggregatorConfig = {
        aggregator: {
          name: cfg.aggregator.name,
          ...(cfg.aggregator.legal_name ? { legal_name: cfg.aggregator.legal_name } : {}),
          ...(cfg.aggregator.contact_email ? { contact_email: cfg.aggregator.contact_email } : {}),
        },
        brand: {
          short_name: cfg.aggregator.brand.short_name,
          long_name: cfg.aggregator.brand.long_name,
          ...(cfg.aggregator.brand.tagline ? { tagline: cfg.aggregator.brand.tagline } : {}),
          ...(cfg.aggregator.brand.strapline ? { strapline: cfg.aggregator.brand.strapline } : {}),
          url_slug: cfg.aggregator.brand.url_slug,
          ...(cfg.aggregator.brand.primary_color
            ? { primary_color: cfg.aggregator.brand.primary_color }
            : {}),
          ...(cfg.aggregator.brand.accent_color
            ? { accent_color: cfg.aggregator.brand.accent_color }
            : {}),
          ...(cfg.aggregator.brand.logo_url ? { logo_url: cfg.aggregator.brand.logo_url } : {}),
          ...(cfg.aggregator.brand.favicon_url
            ? { favicon_url: cfg.aggregator.brand.favicon_url }
            : {}),
          ...(cfg.aggregator.brand.palette ? { palette: cfg.aggregator.brand.palette } : {}),
          ...(cfg.aggregator.brand.typography
            ? { typography: cfg.aggregator.brand.typography }
            : {}),
          ...(cfg.aggregator.brand.logo ? { logo: cfg.aggregator.brand.logo } : {}),
          // Sent only when the brand declares `attribution`.
          ...(cfg.aggregator.brand.attribution?.length
            ? { attribution: cfg.aggregator.brand.attribution }
            : {}),
        },
        network: {
          id: cfg.network.id,
          ...(cfg.network.display_name ? { display_name: cfg.network.display_name } : {}),
        },
        domains: cfg.domainIds.map((id) => {
          const d = cfg.domains[id]!;
          return {
            id: d.id,
            label: d.label,
            plural_label: d.pluralLabel,
            item_type: d.itemType,
            guardian_consent_required: d.guardianConsentRequired,
            go_live_required: d.goLiveRequired,
            ...(d.dashboardTiles ? { dashboardTiles: d.dashboardTiles } : {}),
            ...(d.statusRules ? { status_rules: d.statusRules } : {}),
          };
        }),
        ...(cfg.dashboardBuckets ? { dashboardBuckets: cfg.dashboardBuckets } : {}),
        registration_modes: Object.fromEntries(
          Object.entries(cfg.aggregator.registration_modes ?? {})
            // Drop modes withheld by `AGGREGATOR_ONBOARDING_ENABLED`.
            .filter(([key]) => enabledModes.has(key))
            .map(([key, mode]) => [
              key,
              // Resolve the `signals_cta` default with the rule shared with the web app.
              { ...mode, signals_cta: signalsCtaEnabled(key, cfg) },
            ]),
        ),
        signals_ui_urls: signalsUiUrls,
        features: { custom_roles: config.RBAC_CUSTOM_ROLES_ENABLED },
      };
      return reply.header('Cache-Control', 'public, max-age=60').send(payload);
    },
  );

  app.get(
    '/v1/participant-consent',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['aggregator-config'],
        summary: 'Participant registration-link consent document',
        description:
          'The participant `consent.json` (Terms / Privacy / profile-creation) fetched from `aggregator.network.consent_source` — the same cache-backed pull as network.json. `participant_consent` is null when no `consent_source` is configured (the web app then falls back to its on-disk copy). No auth — operator-controlled content shown on the public registration form.',
        response: {
          200: z
            .object({ participant_consent: z.record(z.string(), z.unknown()).nullable() })
            .passthrough(),
          ...errorResponses(500, 503),
        },
      },
    },
    async (_req, reply) => {
      const cfg = await getNetworkConfig();
      return reply
        .header('Cache-Control', 'public, max-age=60')
        .send({ participant_consent: cfg.participantConsent ?? null });
    },
  );
}
