/**
 * File and HTTP network-config loader for the api and worker.
 *
 * Reads `aggregator.config.yaml` from disk, fetches the upstream
 * signalstack `network.json` over HTTPS, derives identity selectors, and
 * builds one {@link ResolvedNetworkConfig}. A last-known-good cache lets
 * the aggregator start when the upstream is briefly unavailable.
 *
 * @module @aggregator-dpg/network-config/loader
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import {
  AggregatorYamlSchema,
  BrandAttributionSchema,
  BrandLogoSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  NetworkConfigLoaderBase,
  ParticipantConsentDocSchema,
  type AggregatorYaml,
  type IdentitySelectors,
  type NetworkConfigError,
  type NetworkDomain,
  type ParticipantConsentDoc,
  type ResolvedDomain,
  type ResolvedNetworkConfig,
  type SignalstackNetwork,
} from './interface.js';
import { sniffIdentitySelectors } from './sniffer.js';
import { applyUrlRule } from './uri-fields.js';
import { resolveConsentSourceOverride, resolveNetworkSourceOverride } from './paths.js';

/**
 * Shape of the sibling `brand.json` file.
 *
 * Internal. Callers read the merged result on `ResolvedNetworkConfig.aggregator.brand`.
 */
const BrandJsonSchema = z.object({
  brand: z
    .object({
      name: z.string().optional(),
      wordmark: z.string().optional(),
      seededBy: z.string().optional(),
      strapline: z.string().optional(),
    })
    .optional(),
  logo: BrandLogoSchema.optional(),
  attribution: z.array(BrandAttributionSchema).optional(),
  colours: BrandPaletteSchema.optional(),
  typography: BrandTypographySchema.optional(),
});
type BrandJson = z.infer<typeof BrandJsonSchema>;

export interface FileNetworkConfigLoaderOptions {
  /** Absolute path to the aggregator YAML config. */
  configPath: string;
  /**
   * Directory for the last-known-good fetched files.
   *
   * Written on a successful fetch and read when the fetch fails. Unset disables the cache.
   */
  cacheDir?: string;
  /** Fetch implementation. Tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Per-request fetch timeout in milliseconds. */
  fetchTimeoutMs?: number;
  /**
   * Replaces the YAML `aggregator.network.source` URL.
   *
   * Defaults to `AGGREGATOR_NETWORK_SOURCE` (see {@link resolveNetworkSourceOverride}).
   * A malformed URL fails `load()` with `CONFIG_PARSE_FAILED`.
   */
  networkSourceOverride?: string;
  /**
   * Replaces the YAML `aggregator.network.consent_source` URL.
   *
   * Defaults to `AGGREGATOR_PARTICIPANT_CONSENT_SOURCE` (see {@link resolveConsentSourceOverride}).
   * A malformed URL fails `load()` with `CONFIG_PARSE_FAILED`.
   */
  consentSourceOverride?: string;
}

export class FileNetworkConfigLoader extends NetworkConfigLoaderBase {
  private cached: ResolvedNetworkConfig | null = null;
  private readonly opts: Required<
    Pick<FileNetworkConfigLoaderOptions, 'configPath' | 'fetchTimeoutMs'>
  > &
    Pick<
      FileNetworkConfigLoaderOptions,
      'cacheDir' | 'fetchImpl' | 'networkSourceOverride' | 'consentSourceOverride'
    >;

  constructor(opts: FileNetworkConfigLoaderOptions) {
    super();
    const sourceOverride = opts.networkSourceOverride ?? resolveNetworkSourceOverride();
    const consentOverride = opts.consentSourceOverride ?? resolveConsentSourceOverride();
    this.opts = {
      configPath: opts.configPath,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? 5000,
      ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(sourceOverride ? { networkSourceOverride: sourceOverride } : {}),
      ...(consentOverride ? { consentSourceOverride: consentOverride } : {}),
    };
  }

  async load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>> {
    if (this.cached) return ok(this.cached);

    const yaml = await this.readYaml();
    if (!yaml.success) return err(yaml.error);

    // The env override replaces the YAML source, so the resolved config and the
    // fetch use the same URL. A malformed URL is an error, not a fallback.
    const override = this.opts.networkSourceOverride;
    if (override !== undefined) {
      const checked = z.string().url().safeParse(override);
      if (!checked.success) {
        return err({
          code: 'CONFIG_PARSE_FAILED',
          message: `AGGREGATOR_NETWORK_SOURCE is not a valid URL: "${override}"`,
        });
      }
      yaml.value.aggregator.network.source = checked.data;
    }

    // Either the YAML or the env override must provide a URL.
    const source = yaml.value.aggregator.network.source;
    if (!source) {
      return err({
        code: 'CONFIG_PARSE_FAILED',
        message:
          'no network.json source configured — set AGGREGATOR_NETWORK_SOURCE or ' +
          '`aggregator.network.source` in aggregator.config.yaml',
      });
    }

    const network = await this.fetchNetwork(source);
    if (!network.success) return err(network.error);

    const resolved = resolveDomains(yaml.value, network.value);
    if (!resolved.success) return err(resolved.error);

    // Participant consent is fetched like network.json, but a fetch failure is
    // not fatal: `participantConsent` stays undefined and the web app uses its
    // on-disk copy. A malformed override URL is still an error.
    const consentOverride = this.opts.consentSourceOverride;
    if (consentOverride !== undefined) {
      const checked = z.string().url().safeParse(consentOverride);
      if (!checked.success) {
        return err({
          code: 'CONFIG_PARSE_FAILED',
          message: `AGGREGATOR_PARTICIPANT_CONSENT_SOURCE is not a valid URL: "${consentOverride}"`,
        });
      }
      yaml.value.aggregator.network.consent_source = checked.data;
    }
    const consentSource = yaml.value.aggregator.network.consent_source;
    if (consentSource) {
      const consent = await this.fetchConsent(consentSource);
      if (consent) resolved.value.participantConsent = consent;
    }

    this.cached = resolved.value;
    return ok(resolved.value);
  }

  // ─── YAML ──────────────────────────────────────────────────────────────────

  private async readYaml(): Promise<Result<AggregatorYaml, NetworkConfigError>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.opts.configPath, 'utf8');
    } catch (e) {
      return err({
        code: 'CONFIG_FILE_MISSING',
        message: `aggregator config not found at ${this.opts.configPath}: ${(e as Error).message}`,
      });
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      return err({
        code: 'CONFIG_PARSE_FAILED',
        message: `YAML parse failed: ${(e as Error).message}`,
        cause: e as Error,
      });
    }
    const validated = AggregatorYamlSchema.safeParse(parsed);
    if (!validated.success) {
      return err({
        code: 'CONFIG_PARSE_FAILED',
        message: `aggregator.config.yaml failed schema validation: ${validated.error.message}`,
      });
    }
    const merged = await this.mergeBrandJson(validated.data);
    if (!merged.success) return err(merged.error);
    return ok(merged.value);
  }

  /**
   * Merges a sibling `brand.json` into the parsed YAML brand block.
   *
   * A missing file is fine. An invalid file returns `CONFIG_PARSE_FAILED`.
   *
   * @param yaml - The validated aggregator config.
   * @returns The config with brand tokens merged in, or a parse error.
   */
  private async mergeBrandJson(
    yaml: AggregatorYaml,
  ): Promise<Result<AggregatorYaml, NetworkConfigError>> {
    const brandPath = path.join(path.dirname(this.opts.configPath), 'brand.json');
    let raw: string;
    try {
      raw = await fs.readFile(brandPath, 'utf8');
    } catch {
      // brand.json is optional.
      return ok(yaml);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return err({
        code: 'CONFIG_PARSE_FAILED',
        message: `brand.json at ${brandPath} is not valid JSON: ${(e as Error).message}`,
        cause: e as Error,
      });
    }
    const validated = BrandJsonSchema.safeParse(parsed);
    if (!validated.success) {
      return err({
        code: 'CONFIG_PARSE_FAILED',
        message: `brand.json failed schema validation: ${validated.error.message}`,
      });
    }
    return ok(applyBrandJson(yaml, validated.data));
  }

  // ─── network.json ──────────────────────────────────────────────────────────

  private async fetchNetwork(
    url: string,
  ): Promise<Result<SignalstackNetwork, BaseError | NetworkConfigError>> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        return this.recoverFromCache(url, `signalstack network.json fetch returned ${res.status}`);
      }
      const payload = (await res.json()) as SignalstackNetwork;
      const checked = validateNetwork(payload);
      if (!checked.success) {
        return this.recoverFromCache(url, checked.error.message);
      }
      await this.writeCacheFile(url, 'network', payload);
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      return this.recoverFromCache(url, `network fetch transport failure: ${cause.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recoverFromCache(
    url: string,
    upstreamReason: string,
  ): Promise<Result<SignalstackNetwork, BaseError | NetworkConfigError>> {
    const cachePath = this.cachePath(url);
    if (!cachePath) {
      return err(
        new UpstreamError(`${upstreamReason}; no cache configured`, {
          code: 'NETWORK_FETCH_FAILED',
        }),
      );
    }
    try {
      const cached = await fs.readFile(cachePath, 'utf8');
      const payload = JSON.parse(cached) as SignalstackNetwork;
      return ok(payload);
    } catch (e) {
      return err(
        new UpstreamError(`${upstreamReason}; cache miss at ${cachePath}`, {
          cause: e as Error,
          code: 'NETWORK_FETCH_FAILED',
        }),
      );
    }
  }

  /**
   * Writes a fetched payload to its last-known-good cache file, best effort.
   *
   * @param url - Source URL; sets the file name.
   * @param kind - Selects the file name suffix.
   * @param payload - The data to write.
   */
  private async writeCacheFile(
    url: string,
    kind: 'network' | 'consent',
    payload: unknown,
  ): Promise<void> {
    const cachePath = this.cachePath(url, kind);
    if (!cachePath) return;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Best effort. The next boot fetches again.
    }
  }

  private cachePath(url: string, kind: 'network' | 'consent' = 'network'): string | null {
    if (!this.opts.cacheDir) return null;
    // One file per source URL, so deployments sharing a host do not collide.
    const safe = url.replace(/[^a-z0-9]/gi, '_').slice(0, 200);
    return path.join(this.opts.cacheDir, `${safe}.${kind}.json`);
  }

  // ─── participant consent.json ───────────────────────────────────────────────

  /**
   * Fetches and validates the participant `consent.json`, with timeout and cache.
   *
   * Never fails boot.
   *
   * @param url - The consent document URL.
   * @returns The document, or null on failure with no cached copy.
   */
  private async fetchConsent(url: string): Promise<ParticipantConsentDoc | null> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return this.recoverConsentFromCache(url);
      const checked = ParticipantConsentDocSchema.safeParse(await res.json());
      if (!checked.success) return this.recoverConsentFromCache(url);
      await this.writeCacheFile(url, 'consent', checked.data);
      return checked.data;
    } catch {
      return this.recoverConsentFromCache(url);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recoverConsentFromCache(url: string): Promise<ParticipantConsentDoc | null> {
    const cachePath = this.cachePath(url, 'consent');
    if (!cachePath) return null;
    try {
      const parsed = ParticipantConsentDocSchema.safeParse(
        JSON.parse(await fs.readFile(cachePath, 'utf8')),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function validateNetwork(payload: unknown): Result<SignalstackNetwork, NetworkConfigError> {
  if (!payload || typeof payload !== 'object') {
    return err({ code: 'NETWORK_PARSE_FAILED', message: 'network.json must be an object' });
  }
  const n = payload as Partial<SignalstackNetwork>;
  if (typeof n.id !== 'string' || !n.id) {
    return err({ code: 'NETWORK_PARSE_FAILED', message: 'network.json missing `id`' });
  }
  if (!Array.isArray(n.domains) || n.domains.length === 0) {
    return err({
      code: 'NETWORK_PARSE_FAILED',
      message: 'network.json must declare at least one domain',
    });
  }
  for (const d of n.domains) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') {
      return err({ code: 'NETWORK_PARSE_FAILED', message: 'each domain must declare `id`' });
    }
    if (!d.item_schemas || typeof d.item_schemas !== 'object') {
      return err({
        code: 'NETWORK_PARSE_FAILED',
        message: `domain ${d.id} missing item_schemas`,
      });
    }
  }
  return ok(payload as SignalstackNetwork);
}

function resolveDomains(
  yaml: AggregatorYaml,
  network: SignalstackNetwork,
): Result<ResolvedNetworkConfig, NetworkConfigError> {
  const overrides = yaml.aggregator.network.field_overrides ?? {};
  const labels = yaml.aggregator.domain_labels ?? {};
  const domains: Record<string, ResolvedDomain> = {};
  const order: string[] = [];

  for (const d of network.domains) {
    const itemTypes = Object.keys(d.item_schemas);
    if (itemTypes.length === 0) {
      return err({
        code: 'DOMAIN_RESOLUTION_FAILED',
        message: `domain ${d.id} has no item_schemas`,
      });
    }
    const itemType = itemTypes[0]!;
    // Link fields get Signals' URL rule here, once, so the registration form,
    // the public submit route and the bulk worker all validate them exactly as
    // Signals will on the push (#904).
    const schema = applyUrlRule(d.item_schemas[itemType] as Record<string, unknown>);
    const identity = pickIdentity(d, schema, overrides[d.id]);
    if (!identity) {
      return err({
        code: 'DOMAIN_RESOLUTION_FAILED',
        message: `could not resolve identity selectors for domain '${d.id}' — add field_overrides.${d.id} to aggregator.config.yaml`,
      });
    }
    const tabLabel = labels[d.id]?.tab_label ?? titleCase(d.id);
    const singular = labels[d.id]?.singular ?? titleCase(d.id);
    const plural = labels[d.id]?.plural ?? `${singular}s`;
    domains[d.id] = {
      id: d.id,
      label: tabLabel,
      pluralLabel: plural,
      itemType,
      schema,
      identity,
      // Missing keys default to off: no consent step and no birth year.
      guardianConsentRequired: d.guardian_consent_required === true,
      goLiveRequired: Array.isArray(d.go_live_required) ? d.go_live_required : [],
      ...(d.dashboard_tiles !== undefined ? { dashboardTiles: d.dashboard_tiles } : {}),
      ...(d.status_rules !== undefined ? { statusRules: d.status_rules } : {}),
    };
    order.push(d.id);
  }

  return ok({
    aggregator: yaml.aggregator,
    network,
    domains,
    domainIds: order,
    ...(network.dashboard_buckets !== undefined
      ? { dashboardBuckets: network.dashboard_buckets }
      : {}),
  });
}

function pickIdentity(
  _domain: NetworkDomain,
  schema: Record<string, unknown>,
  override: IdentitySelectors | undefined,
): IdentitySelectors | null {
  if (override) return override;
  return sniffIdentitySelectors(schema);
}

/**
 * Copies design tokens from `brand.json` onto the YAML brand block.
 *
 * Sets `palette`, `typography`, `logo`, `attribution` and `strapline`. Flat
 * YAML fields such as `primary_color` are not changed.
 */
function applyBrandJson(yaml: AggregatorYaml, brand: BrandJson): AggregatorYaml {
  return {
    ...yaml,
    aggregator: {
      ...yaml.aggregator,
      brand: {
        ...yaml.aggregator.brand,
        ...(brand.colours ? { palette: brand.colours } : {}),
        ...(brand.typography ? { typography: brand.typography } : {}),
        ...(brand.logo ? { logo: brand.logo } : {}),
        ...(brand.attribution ? { attribution: brand.attribution } : {}),
        ...(brand.brand?.strapline ? { strapline: brand.brand.strapline } : {}),
      },
    },
  };
}

function titleCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
