/**
 * Shared Ajv 2020-12 wiring for the schema loaders in this package.
 *
 * Internal module, not a subpath export. Gives {@link FileSchemaLoader} and
 * {@link NetworkSchemaLoader} the same compiler setup.
 *
 * @module @aggregator-dpg/schema-loader
 */

import { createRequire } from 'node:module';
import type { ValidateFunction } from './interface.js';

const require = createRequire(import.meta.url);

type AjvOptions = {
  allErrors?: boolean;
  strict?: boolean | 'log';
  coerceTypes?: boolean | 'array';
};

/** The slice of Ajv's surface this package uses. */
export type AjvLike = {
  compile(schema: unknown): ValidateFunction;
};

type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

// Ajv 2020-12 build, since schemas declare draft 2020-12. Both packages are CJS.
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

/**
 * Builds an Ajv instance: all errors reported, non-strict parsing, and
 * array-aware type coercion (form payloads arrive as strings).
 *
 * @returns A ready-to-use Ajv instance with `ajv-formats` registered.
 */
export function createAjv(): AjvLike {
  const ajv = new AjvCtor({ allErrors: true, strict: false, coerceTypes: 'array' });
  addFormats(ajv);
  return ajv;
}
