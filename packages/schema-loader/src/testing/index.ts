/**
 * In-memory SchemaLoaderFake for tests (`@aggregator-dpg/schema-loader/testing`).
 *
 * Seed it with raw schema documents; `getSchema` and `getValidator` resolve
 * from the seeded map.
 */

import { createRequire } from 'node:module';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  SchemaLoaderBase,
  SchemaNotFoundError,
  SchemaCompileError,
  type JsonSchema,
  type SchemaRef,
  type ValidateFunction,
} from '../interface.js';

const require = createRequire(import.meta.url);
type AjvOptions = {
  allErrors?: boolean;
  strict?: boolean | 'log';
  coerceTypes?: boolean | 'array';
};
type AjvLike = {
  compile(schema: unknown): ValidateFunction;
};
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

export class SchemaLoaderFake extends SchemaLoaderBase {
  private readonly schemas = new Map<string, JsonSchema>();
  private readonly validatorCache = new Map<string, ValidateFunction>();
  private readonly ajv: AjvLike;

  constructor() {
    super();
    this.ajv = new AjvCtor({ allErrors: true, strict: false, coerceTypes: 'array' });
    addFormats(this.ajv);
  }

  /** Pre-load schemas before the test body. */
  seed(entries: Array<{ ref: SchemaRef; schema: JsonSchema }>): void {
    for (const { ref, schema } of entries) {
      this.schemas.set(this.key(ref), schema);
    }
  }

  async getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>> {
    const schema = this.schemas.get(this.key(ref));
    if (!schema) return err(new SchemaNotFoundError(ref));
    return ok(schema);
  }

  async getValidator(ref: SchemaRef): Promise<Result<ValidateFunction, BaseError>> {
    const cached = this.validatorCache.get(this.key(ref));
    if (cached) return ok(cached);

    const schemaResult = await this.getSchema(ref);
    if (!schemaResult.success) return schemaResult;

    try {
      const validator = this.ajv.compile(schemaResult.value);
      this.validatorCache.set(this.key(ref), validator);
      return ok(validator);
    } catch (compileErr) {
      return err(new SchemaCompileError(ref, compileErr));
    }
  }

  private key(ref: SchemaRef): string {
    return `${ref.id}:${ref.version}`;
  }
}
