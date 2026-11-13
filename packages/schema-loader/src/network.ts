/**
 * Hybrid SchemaLoader that resolves participant schemas from the in-memory
 * network config and defers everything else to {@link FileSchemaLoader}.
 *
 * Used by the API and the worker. Each app injects its own network-config
 * accessor, so this package does not depend on `@aggregator-dpg/network-config`.
 *
 * @module @aggregator-dpg/schema-loader
 */

import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  SchemaLoaderBase,
  SchemaNotFoundError,
  SchemaCompileError,
  type JsonSchema,
  type SchemaRef,
  type ValidateFunction,
} from './interface.js';
import { FileSchemaLoader } from './file-loader.js';
import { createAjv, type AjvLike } from './ajv.js';

/**
 * The slice of a resolved network config this loader reads. Structurally
 * satisfied by `ResolvedNetworkConfig` from `@aggregator-dpg/network-config`.
 */
export interface NetworkSchemaSource {
  domains: Record<string, { schema: unknown } | undefined>;
}

/** Supplies the process-wide resolved network config. */
export type NetworkConfigProvider = () => Promise<NetworkSchemaSource>;

export interface NetworkSchemaLoaderOptions {
  /** Absolute path to the directory holding aggregator-side schema files. */
  rootDir: string;
  /** Accessor for the calling process's resolved network config. */
  getNetworkConfig: NetworkConfigProvider;
}

/**
 * Routes `participant-*` schema ids to the network config; defers every other
 * id to the wrapped {@link FileSchemaLoader}.
 *
 * Compiled Ajv validators are cached per `(id, version)` for the lifetime of
 * the instance.
 */
export class NetworkSchemaLoader extends SchemaLoaderBase {
  private readonly file: FileSchemaLoader;
  private readonly ajv: AjvLike;
  private readonly getNetworkConfig: NetworkConfigProvider;
  private readonly validatorCache = new Map<string, ValidateFunction>();

  constructor(opts: NetworkSchemaLoaderOptions) {
    super();
    this.file = new FileSchemaLoader({ rootDir: opts.rootDir });
    this.ajv = createAjv();
    this.getNetworkConfig = opts.getNetworkConfig;
  }

  /**
   * Resolves a schema document for the given reference.
   *
   * @param ref - Schema id + version to resolve.
   * @returns The schema document, or `SchemaNotFoundError` when the domain is not configured.
   */
  async getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>> {
    const domain = participantDomain(ref);
    if (domain === null) return this.file.getSchema(ref);

    const cfg = await this.getNetworkConfig();
    const resolved = cfg.domains[domain];
    if (!resolved) return err(new SchemaNotFoundError(ref));
    return ok(resolved.schema as JsonSchema);
  }

  /**
   * Resolves and compiles a validator for the given reference.
   *
   * @param ref - Schema id + version to resolve.
   * @returns The compiled validator, or `SchemaNotFoundError` / `SchemaCompileError`.
   */
  async getValidator(ref: SchemaRef): Promise<Result<ValidateFunction, BaseError>> {
    const domain = participantDomain(ref);
    if (domain === null) return this.file.getValidator(ref);

    const cacheKey = `${ref.id}:${ref.version}`;
    const cached = this.validatorCache.get(cacheKey);
    if (cached) return ok(cached);

    const schemaResult = await this.getSchema(ref);
    if (!schemaResult.success) return err(schemaResult.error);
    try {
      const validate = this.ajv.compile(schemaResult.value);
      this.validatorCache.set(cacheKey, validate);
      return ok(validate);
    } catch (cause) {
      return err(new SchemaCompileError(ref, cause));
    }
  }
}

/**
 * Returns the participant domain id when `ref.id` is `participant-{domain}`.
 * The version is ignored: network.json keys item schemas by item type only.
 *
 * @param ref - The schema reference under consideration.
 * @returns The domain id, or `null` for any other shape so the caller delegates.
 */
function participantDomain(ref: SchemaRef): string | null {
  if (!ref.id.startsWith('participant-')) return null;
  const domain = ref.id.slice('participant-'.length);
  if (!/^[a-z0-9_]+$/i.test(domain)) return null;
  return domain;
}
