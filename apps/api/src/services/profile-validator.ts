/**
 * Compiled Ajv validator for `profile.v1.json`, in `@aggregator-dpg/api`.
 *
 * Loads the schema from `config/` and caches it on first use.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

const require = createRequire(import.meta.url);

type AjvOptions = { allErrors?: boolean; strict?: boolean | 'log' };
type AjvLike = { compile(schema: unknown): ValidateFunction };
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the shared compiled profile validator.
 */
export function getProfileValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schemaPath = resolveSchemaPath();
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator: ValidateFunction = ajv.compile(schema);
  cachedValidator = validator;
  return validator;
}

function resolveSchemaPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../config/schemas/aggregator/profile.v1.json'),
    path.resolve(__dirname, '../../../../../config/schemas/aggregator/profile.v1.json'),
    path.resolve(process.cwd(), 'config/schemas/aggregator/profile.v1.json'),
    path.resolve(process.cwd(), '../../config/schemas/aggregator/profile.v1.json'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`profile schema not found; tried: ${candidates.join(', ')}`);
}

export function _resetProfileValidator(): void {
  cachedValidator = null;
}
