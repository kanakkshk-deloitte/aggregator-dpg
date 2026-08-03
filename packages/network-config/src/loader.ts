/**
 * File + HTTP config loader.
 *
 * Reads `aggregator.config.yaml` from disk, fetches the upstream
 * signalstack `network.json` over HTTPS, sniffs identity selectors,
 * and resolves a singleton {@link ResolvedNetworkConfig} the api +
 * worker consume. Last-known-good cache lets the aggregator survive
 * a transient signalstack/GitHub outage on restart.
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
  BrandLogoSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  NetworkConfigLoaderBase,
  type AggregatorYaml,
  type IdentitySelectors,
  type NetworkConfigError,
  type NetworkDomain,
  type ResolvedDomain,
  type ResolvedNetworkConfig,
  type SignalstackNetwork,
} from './interface.js';
import { sniffIdentitySelectors } from './sniffer.js';
import { resolveNetworkSourceOverride } from './paths.js';

/**
 * Loader-internal shape of the sibling `brand.json` file. Not exported
 * from the package — external callers consume the merged
 * `BrandConfig` (with `palette`/`typography`/`logo`) on
 * `ResolvedNetworkConfig.aggregator.brand`.
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
  colours: BrandPaletteSchema.optional(),
  typography: BrandTypographySchema.optional(),
});
type BrandJson = z.infer<typeof BrandJsonSchema>;

export interface FileNetworkConfigLoaderOptions {
  /** Absolute path to the aggregator YAML config. */
  configPath: string;
  /**
   * Directory for the last-known-good signalstack network.json. The
   * fetcher writes a copy here on success and falls back to it on
   * upstream failure. Skip the cache by leaving this unset.
   */
  cacheDir?: string;
  /** Override for the network.json fetcher. Tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the network.json GET. */
  fetchTimeoutMs?: number;
  /**
   * Deploy-time replacement for the YAML `aggregator.network.source` URL.
   * Defaults to the `AGGREGATOR_NETWORK_SOURCE` env var (see
   * {@link resolveNetworkSourceOverride}); pass explicitly in tests. Must be
   * a valid URL — a malformed value fails `load()` with
   * `CONFIG_PARSE_FAILED` instead of silently falling back to the YAML.
   */
  networkSourceOverride?: string;
}

export class FileNetworkConfigLoader extends NetworkConfigLoaderBase {
  private cached: ResolvedNetworkConfig | null = null;
  private readonly opts: Required<
    Pick<FileNetworkConfigLoaderOptions, 'configPath' | 'fetchTimeoutMs'>
  > &
    Pick<FileNetworkConfigLoaderOptions, 'cacheDir' | 'fetchImpl' | 'networkSourceOverride'>;

  constructor(opts: FileNetworkConfigLoaderOptions) {
    super();
    const sourceOverride = opts.networkSourceOverride ?? resolveNetworkSourceOverride();
    this.opts = {
      configPath: opts.configPath,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? 5000,
      ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(sourceOverride ? { networkSourceOverride: sourceOverride } : {}),
    };
  }

  async load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>> {
    if (this.cached) return ok(this.cached);

    const yaml = await this.readYaml();
    if (!yaml.success) return err(yaml.error);

    // Deploy-time env override (#512): swap the signalstack network.json
    // source without rebuilding the image or editing the mounted YAML. The
    // override is applied onto the parsed YAML so the resolved config and the
    // fetch use the same value. Fail loud on a malformed URL — silently
    // falling back to the YAML would mask a broken deployment.
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

    // `source` is optional in the YAML (a deployment may rely solely on the
    // env override) — but at least one of the two must resolve a URL.
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
   * Merge a sibling `brand.json` (design-system file) into the parsed
   * YAML brand block. Absent or malformed file falls through — the
   * aggregator must still boot on flat YAML fields alone.
   */
  private async mergeBrandJson(
    yaml: AggregatorYaml,
  ): Promise<Result<AggregatorYaml, NetworkConfigError>> {
    const brandPath = path.join(path.dirname(this.opts.configPath), 'brand.json');
    let raw: string;
    try {
      raw = await fs.readFile(brandPath, 'utf8');
    } catch {
      // brand.json is optional — silent fall-through.
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
      await this.writeCache(url, payload);
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

  private async writeCache(url: string, payload: SignalstackNetwork): Promise<void> {
    const cachePath = this.cachePath(url);
    if (!cachePath) return;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Best-effort cache write — fall through silently. The next boot
      // will re-attempt the upstream fetch.
    }
  }

  private cachePath(url: string): string | null {
    if (!this.opts.cacheDir) return null;
    // Deterministic file name per network so different deployments
    // sharing a host don't overwrite each other.
    const safe = url.replace(/[^a-z0-9]/gi, '_').slice(0, 200);
    return path.join(this.opts.cacheDir, `${safe}.network.json`);
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
    const schema = d.item_schemas[itemType] as Record<string, unknown>;
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
 * Overlay design-token fields (`palette`, `typography`, `logo`,
 * `strapline`) from a sibling `brand.json` onto the YAML brand
 * block. Flat YAML fields (`primary_color`, `short_name`, ...) always
 * win — they are deploy-state and operator-authoritative.
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
