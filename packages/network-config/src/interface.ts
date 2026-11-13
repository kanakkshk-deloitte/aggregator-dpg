/**
 * Network-config contract for the aggregator.
 *
 * The aggregator runs against any signalstack network. Each deployment
 * provides one `aggregator.config.yaml` that points at the upstream
 * signalstack `network.json`. Business logic has no hardcoded domain ids,
 * item types, or schema field names.
 *
 * This module defines the shapes. {@link NetworkConfigLoader}
 * implementations do the loading.
 *
 * @module @aggregator-dpg/network-config/interface
 */

import { z } from 'zod';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

// ─── Coordinator YAML schema ──────────────────────────────────────────────────

/**
 * Per-domain identity selectors.
 *
 * Maps the schema's field names to the `name`, `phone` and `email` the
 * aggregator uses for dedup, Keycloak linking and the signalstack user
 * payload. When absent, the sniffer derives defaults from the schema.
 */
export const IdentitySelectorsSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  // Some domain schemas have no email field. Dedup then uses phone only.
  email: z.string().min(1).optional(),
});
export type IdentitySelectors = z.infer<typeof IdentitySelectorsSchema>;

/**
 * Optional UI labels for a single signalstack domain. Falls back to
 * the domain id from network.json when unset.
 */
export const DomainLabelsSchema = z.object({
  singular: z.string().optional(),
  plural: z.string().optional(),
  tab_label: z.string().optional(),
});
export type DomainLabels = z.infer<typeof DomainLabelsSchema>;

/**
 * Hex colour `#RRGGBB`. Lower or upper case accepted.
 */
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #RRGGBB');

/**
 * Named palette swatch (`{ name, hex }`). Sourced from `brand.json`.
 */
export const PaletteSwatchSchema = z.object({
  name: z.string().min(1),
  hex: HexColorSchema,
});
export type PaletteSwatch = z.infer<typeof PaletteSwatchSchema>;

/**
 * Named gradient (`{ name, from, to }`). Sourced from `brand.json`.
 */
export const GradientSchema = z.object({
  name: z.string().min(1),
  from: HexColorSchema,
  to: HexColorSchema,
});
export type Gradient = z.infer<typeof GradientSchema>;

/**
 * Design-token palette loaded from a sibling `brand.json`.
 *
 * All groups are optional, so a missing file is valid.
 */
export const BrandPaletteSchema = z.object({
  primary: z.array(PaletteSwatchSchema).optional(),
  secondary: z.array(PaletteSwatchSchema).optional(),
  accent: z.array(PaletteSwatchSchema).optional(),
  gradients: z.array(GradientSchema).optional(),
});
export type BrandPalette = z.infer<typeof BrandPaletteSchema>;

/**
 * One typography face (heading or body) from `brand.json`.
 */
export const BrandTypographyFaceSchema = z.object({
  family: z.string().min(1),
  weight: z.string().min(1),
  sampleCopy: z.string().optional(),
});
export type BrandTypographyFace = z.infer<typeof BrandTypographyFaceSchema>;

/**
 * Typography tokens loaded from `brand.json`.
 *
 * `primaryFont` sets the default font stack. `headings` and `body`
 * override it per face.
 */
export const BrandTypographySchema = z.object({
  primaryFont: z.string().min(1),
  headings: BrandTypographyFaceSchema.optional(),
  body: BrandTypographyFaceSchema.optional(),
});
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

/**
 * Logo variant paths.
 *
 * Values are absolute web paths under `apps/web/public/`
 * (e.g. `/brand/blue-dot/logo.png`) or full URLs.
 */
export const BrandLogoSchema = z.object({
  default: z.string().min(1).optional(),
  light: z.string().min(1).optional(),
  withStrapline: z.string().min(1).optional(),
  withStraplineLight: z.string().min(1).optional(),
  onBrand: z.string().min(1).optional(),
});
export type BrandLogo = z.infer<typeof BrandLogoSchema>;

/**
 * One labelled organisation in the login page attribution block, e.g. "Owned by X".
 *
 * Separate from `BrandLogoSchema`, which holds variants of one mark. Only
 * brands that declare it render anything. `logo` paths resolve like
 * `BrandLogoSchema` paths.
 */
export const BrandAttributionSchema = z.object({
  /** Caption above the mark, e.g. `Owned by`. */
  label: z.string().min(1),
  /** Organisation name. Used as the image's accessible name. */
  name: z.string().min(1),
  /** Mark to render. Omit to fall back to the name as text. */
  logo: z.string().min(1).optional(),
  /**
   * Dark-mode variant of {@link logo}.
   *
   * Use it when the mark lacks contrast on a dark background. Falls back to
   * `logo` when absent.
   */
  logoLight: z.string().min(1).optional(),
});
export type BrandAttribution = z.infer<typeof BrandAttributionSchema>;

/**
 * Brand settings read by the sidebar, top bar and email templates.
 *
 * The flat fields (`short_name`, `primary_color`, ...) come from
 * `aggregator.config.yaml`. `palette`, `typography` and `logo` come from the
 * sibling `brand.json` when present; the loader merges them in before
 * validation.
 */
export const BrandConfigSchema = z.object({
  short_name: z.string().min(1),
  long_name: z.string().min(1),
  tagline: z.string().optional(),
  url_slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'url_slug must be kebab-case alphanumeric'),
  primary_color: HexColorSchema.optional(),
  accent_color: HexColorSchema.optional(),
  logo_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
  palette: BrandPaletteSchema.optional(),
  typography: BrandTypographySchema.optional(),
  logo: BrandLogoSchema.optional(),
  strapline: z.string().optional(),
  /** Ordered "Owned by" / "Managed by" rows for the login page. Optional. */
  attribution: z.array(BrandAttributionSchema).optional(),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

/**
 * Network binding — where to fetch the signalstack `network.json` and
 * how to bridge it to the aggregator's identity model.
 */
export const NetworkBindingSchema = z.object({
  /**
   * URL of the upstream signalstack `network.json`.
   *
   * Can be set by `AGGREGATOR_NETWORK_SOURCE` instead. `load()` fails when
   * neither is set.
   */
  source: z.string().url().optional(),
  /**
   * URL of the upstream participant `consent.json` (Terms, Privacy, profile creation).
   *
   * Fetched like {@link source}, with the same timeout and cache. Can be set
   * by `AGGREGATOR_PARTICIPANT_CONSENT_SOURCE` instead. When unset, the web
   * app uses the on-disk participant `consent.json`.
   */
  consent_source: z.string().url().optional(),
  field_overrides: z.record(z.string(), IdentitySelectorsSchema).optional(),
  csv_array_delimiter: z.string().min(1).default('|'),
});
export type NetworkBinding = z.infer<typeof NetworkBindingSchema>;

/** One title+content version entry of a participant consent document. */
export const ConsentDocVersionSchema = z
  .object({
    version: z.number(),
    title: z.string(),
    content: z.string(),
    effective_from: z.string().optional(),
  })
  .passthrough();

/** One statement-only version entry (profile-creation consent). */
export const ConsentStatementVersionSchema = z
  .object({
    version: z.number(),
    statement: z.string(),
    effective_from: z.string().optional(),
  })
  .passthrough();

/**
 * Participant `consent.json` fetched from {@link NetworkBindingSchema.consent_source}.
 *
 * The schema is lenient. It rejects a non-JSON or wrong-shape body, such as
 * an HTML 404 page, but does not fully model the Signals schema.
 */
export const ParticipantConsentDocSchema = z
  .object({
    documents: z
      .object({
        terms: z
          .object({
            current_version: z.number(),
            versions: z.array(ConsentDocVersionSchema),
          })
          .passthrough()
          .optional(),
        privacy: z
          .object({
            current_version: z.number(),
            versions: z.array(ConsentDocVersionSchema),
          })
          .passthrough()
          .optional(),
        profile_creation: z
          .object({
            current_version: z.number(),
            versions: z.array(ConsentStatementVersionSchema),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type ParticipantConsentDoc = z.infer<typeof ParticipantConsentDocSchema>;

/**
 * Onboarding settings.
 *
 * `presume_consent` applies to bulk upload only. When true, adult rows are
 * sent to Signals with all consents asserted, so the profile goes live at
 * once. Minors are never presumed. When false, rows stay `draft` until the
 * participant accepts. Defaults to false; each network must opt in.
 */
export const OnboardingConfigSchema = z.object({
  presume_consent: z.boolean().default(false),
  bulk_max_rows: z.coerce.number().int().positive().default(10000),
});
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>;

/**
 * Validated key for a registration mode entry. Must be a snake_case
 * identifier starting with a lowercase letter.
 */
const RegistrationModeKey = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * One entry in the per-network `registration_modes` config block.
 * Maps an admin-facing channel name (e.g. `voice`, `form`) to a
 * rendering shape and an optional public hint.
 */
export const RegistrationModeSchema = z.object({
  label_i18n_key: z.string().min(1),
  submission_shape: z.enum(['account_only', 'account_and_profile']),
  public_hint_i18n_key: z.string().min(1).nullable(),
  /**
   * Whether links in this mode show the "Already Registered — Sign In" link to Signals.
   *
   * When omitted, it is true only for `submission_shape === 'account_and_profile'`.
   */
  signals_cta: z.boolean().optional(),
});
export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;

/** Tree limits. Pending and active orgs count; the root and the Default org do not. */
export const HierarchyConfigSchema = z.object({
  /** The deepest an aggregator org can be; 1 keeps every org directly under the network. */
  max_depth: z.number().int().min(1).max(10).default(1),
  /** The most direct children of any org, the network included. Unset means no limit. */
  max_children: z.number().int().min(1).optional(),
  /** The most aggregator orgs in the instance. */
  max_total_orgs: z.number().int().min(1).default(50),
});
export type HierarchyConfig = z.infer<typeof HierarchyConfigSchema>;

/**
 * Organisation settings: tree limits.
 *
 * The schema is not strict, so unknown keys in the block are ignored.
 */
export const OrganisationConfigSchema = z.object({
  hierarchy: HierarchyConfigSchema.default({}),
  /**
   * Not used. Kept so the API can warn at boot that the block is ignored;
   * "known as" values are set in the console.
   */
  known_as: z.unknown().optional(),
});
export type OrganisationConfig = z.infer<typeof OrganisationConfigSchema>;

/** The organisation settings used when an instance declares none. */
export const DEFAULT_ORGANISATION: OrganisationConfig = {
  hierarchy: { max_depth: 1, max_total_orgs: 50 },
};

/**
 * Root aggregator config — the YAML the operator edits per deployment.
 */
export const AggregatorYamlSchema = z.object({
  aggregator: z.object({
    name: z.string().min(1),
    legal_name: z.string().optional(),
    contact_email: z.string().email().optional(),
    network: NetworkBindingSchema,
    brand: BrandConfigSchema,
    domain_labels: z.record(z.string(), DomainLabelsSchema).optional(),
    onboarding: OnboardingConfigSchema.default({}),
    admin_emails: z.array(z.string().email()).default([]),
    registration_modes: z.record(RegistrationModeKey, RegistrationModeSchema).default({
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    }),
    organisation: OrganisationConfigSchema.default({}),
  }),
});
export type AggregatorYaml = z.infer<typeof AggregatorYamlSchema>;

/**
 * Alias for `AggregatorYamlSchema`.
 */
export const AggregatorConfigSchema = AggregatorYamlSchema;

// ─── Signalstack network.json (the subset the aggregator cares about) ────────

/**
 * One dashboard tile: the rollup key to read and its label.
 *
 * `field` is a key on the signalstack rollup (e.g. `total_users`). The
 * aggregator reads the precomputed value. An unknown `field` skips the tile
 * and logs a warning.
 */
export interface DashboardTileDef {
  field: string;
  label: string;
}

/**
 * Per-domain dashboard tiles, split into profile and user groups.
 *
 * Copied from `network.json`. All fields are optional; the UI uses defaults
 * for missing groups and titles.
 */
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
  profile_title?: string;
  user_title?: string;
}

/**
 * Network-wide label overrides for the dashboard status and action buckets.
 *
 * Keys are fixed Signals values; values are the network's labels. Action
 * labels are split into initiated and received. All optional; the UI uses
 * English defaults.
 */
export interface DashboardBuckets {
  by_status?: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', string>>;
  by_initiated_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
  by_received_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
}

/**
 * One entry of a domain's `status_rules` array from `network.json`.
 *
 * `when` is the metrics-service condition, passed through unchanged.
 * `label` and `description` are shown on the dashboard status cards.
 */
export interface StatusRule {
  status: string;
  label?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: any;
}

/**
 * One domain inside a signalstack network.
 *
 * Holds the JSON Schemas keyed by `item_type`.
 */
export interface NetworkDomain {
  id: string;
  description?: string;
  /** Dashboard tile groups. Optional, copied from `network.json`. */
  dashboard_tiles?: DashboardTiles;
  /** Status rules and their UI labels. Optional, copied from `network.json`. */
  status_rules?: StatusRule[];
  /**
   * When true, minors need guardian consent, so the form collects a birth year.
   *
   * Absent means `false`.
   */
  guardian_consent_required?: boolean;
  /**
   * Go-live gate tokens, e.g. `schema_required`, `consent_required`.
   *
   * Decides whether the form shows the profile-creation consent step. Absent means `[]`.
   */
  go_live_required?: string[];
  item_schemas: Record<string, Record<string, unknown>>;
}

/**
 * Parsed signalstack `network.json`.
 *
 * Unknown keys are kept unchanged.
 */
export interface SignalstackNetwork {
  id: string;
  display_name?: string;
  description?: string;
  domains: NetworkDomain[];
  /** Shared dashboard bucket labels. Optional, copied from `network.json`. */
  dashboard_buckets?: DashboardBuckets;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

// ─── Resolved config (what callers read) ─────────────────────────────────────

/**
 * One domain after merging `network.json` with the aggregator config.
 *
 * Gives callers the item type, schema and identity fields for a domain.
 */
export interface ResolvedDomain {
  id: string;
  /** Display label. Defaults to the title-cased id. */
  label: string;
  /** Plural label for tab + sidebar text. */
  pluralLabel: string;
  /** Default item type for this domain (first key of `item_schemas`). */
  itemType: string;
  /** JSON Schema for the default item type. */
  schema: Record<string, unknown>;
  /** Identity selectors (sniffer-derived, overridden by config). */
  identity: IdentitySelectors;
  /** Dashboard tile groups from the domain's `dashboard_tiles`. */
  dashboardTiles?: DashboardTiles;
  /** Status rules from the domain's `status_rules`. */
  statusRules?: StatusRule[];
  /**
   * From `guardian_consent_required`. Defaults to `false`.
   *
   * When true, the form collects a birth year.
   */
  guardianConsentRequired: boolean;
  /**
   * From `go_live_required`. Defaults to `[]`.
   *
   * The form shows the profile-creation consent step only if this includes `consent_required`.
   */
  goLiveRequired: string[];
}

/**
 * Resolved configuration the aggregator runs against.
 *
 * Built once at boot and not changed after. Tests inject a stub via the
 * {@link NetworkConfigStore}.
 */
export interface ResolvedNetworkConfig {
  aggregator: AggregatorYaml['aggregator'];
  network: SignalstackNetwork;
  domains: Record<string, ResolvedDomain>;
  /** Domain ids in declaration order. Sets the UI tab order. */
  domainIds: string[];
  /** Copy of `network.dashboard_buckets`. Undefined when `network.json` has none. */
  dashboardBuckets?: DashboardBuckets;
  /**
   * Participant consent document fetched from {@link NetworkBindingSchema.consent_source}.
   *
   * Undefined when no source is set, or the fetch failed with no cached copy.
   * The web app then uses its on-disk participant `consent.json`.
   */
  participantConsent?: ParticipantConsentDoc;
}

// ─── Loader port ─────────────────────────────────────────────────────────────

export type NetworkConfigError =
  | { code: 'CONFIG_FILE_MISSING'; message: string }
  | { code: 'CONFIG_PARSE_FAILED'; message: string; cause?: Error }
  | { code: 'NETWORK_FETCH_FAILED'; message: string; cause?: Error }
  | { code: 'NETWORK_PARSE_FAILED'; message: string; cause?: Error }
  | { code: 'DOMAIN_RESOLUTION_FAILED'; message: string };

/**
 * Port for loading the aggregator network config.
 *
 * {@link FileNetworkConfigLoader} reads YAML from disk and fetches
 * `network.json` over HTTPS with a last-known-good cache.
 * {@link InMemoryNetworkConfigLoader} returns a fixed config for tests.
 * Never throws.
 */
export abstract class NetworkConfigLoaderBase {
  /**
   * Loads and resolves the active config.
   *
   * Later calls in the same process return the cached result.
   *
   * @returns The resolved config, or a config error.
   */
  abstract load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>>;
}

// ─── Registration-form gate predicates (reusable) ────────────────────────────

/**
 * Go-live gate token meaning a profile needs profile-creation consent to go live.
 *
 * Shared by the api and web.
 */
export const CONSENT_REQUIRED_GATE = 'consent_required';

/**
 * Returns whether the registration form shows the profile-creation consent step.
 *
 * True only if the gates include {@link CONSENT_REQUIRED_GATE}.
 *
 * @param goLiveRequired - The domain's resolved `goLiveRequired` tokens.
 * @returns True when a consent step is required.
 */
export function domainRequiresConsent(goLiveRequired: readonly string[] | undefined): boolean {
  return (goLiveRequired ?? []).includes(CONSENT_REQUIRED_GATE);
}

/**
 * Returns whether the registration form collects a birth year.
 *
 * True only if the domain requires guardian consent for minors.
 *
 * @param guardianConsentRequired - The domain's resolved flag.
 * @returns True when a birth year must be collected.
 */
export function domainRequiresBirthYear(guardianConsentRequired: boolean | undefined): boolean {
  return guardianConsentRequired === true;
}
