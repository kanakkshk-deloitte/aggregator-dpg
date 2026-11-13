/**
 * Public interface for the schema loader (`@aggregator-dpg/schema-loader`).
 *
 * Schemas are JSON Schema 2020-12 documents stored under
 * `config/schemas/{actor}/{action}.v{N}.json`. The loader resolves a schema
 * id + version, fetches the document, compiles an Ajv validator, and
 * caches both per (id, version).
 *
 * Used by:
 *   - API: link-channel sync validation, schema fetch endpoint.
 *   - Workers: bulk File Processor (header check) and Row Processor
 *     (per-row validation against the schema pinned on `bulk_uploads`).
 */

import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * Structural shape of a compiled JSON Schema validator. Mirrors Ajv's
 * `ValidateFunction` so concrete implementations can return the real Ajv
 * type without leaking Ajv into the interface contract.
 */
export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ValidateFunction = ((data: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

/** Logical reference to one schema document. */
export interface SchemaRef {
  /** e.g. `participant-seeker`, `aggregator-registration` */
  id: string;
  /** e.g. `v1` — must be stable once published */
  version: string;
}

/** Raw JSON Schema 2020-12 document. */
export type JsonSchema = Record<string, unknown>;

/** Errors returned by SchemaLoader methods. */
export class SchemaNotFoundError extends BaseError {
  constructor(ref: SchemaRef) {
    super('SCHEMA_NOT_FOUND', `schema not found: ${ref.id} ${ref.version}`, {
      details: { ref },
    });
  }
}
export class SchemaCompileError extends BaseError {
  constructor(ref: SchemaRef, cause: unknown) {
    super('SCHEMA_COMPILE_ERROR', `failed to compile schema: ${ref.id} ${ref.version}`, {
      cause,
      details: { ref },
    });
  }
}

/**
 * Abstract base. Concrete implementations: `FileSchemaLoader` (production —
 * reads from disk under `config/schemas/`), and `SchemaLoaderFake` (tests —
 * accepts in-memory schemas via `seed()`).
 */
export abstract class SchemaLoaderBase {
  /**
   * Returns the raw JSON Schema document for the given ref. ETag-cacheable.
   */
  abstract getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>>;

  /**
   * Returns a compiled Ajv validator for the given ref. Compiled lazily on
   * first call, cached by `(id, version)` for the lifetime of the loader.
   */
  abstract getValidator(ref: SchemaRef): Promise<Result<ValidateFunction, BaseError>>;
}
