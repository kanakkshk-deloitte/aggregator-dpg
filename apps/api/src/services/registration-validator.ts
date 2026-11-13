/**
 * Compiled Ajv validator for coordinator registration (`@aggregator-dpg/api`).
 *
 * The schema is `config/schemas/aggregator/registration.v1.json`, so the form
 * can change without code changes.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { getNetworkConfig } from './network-config.js';
import { resolveSchema, schemaCandidates } from './schema-ref.js';

const require = createRequire(import.meta.url);
// ajv and ajv-formats are CommonJS; load their default exports through createRequire.
type AjvOptions = { allErrors?: boolean; strict?: boolean | 'log' };
type AjvLike = {
  compile(schema: unknown): ValidateFunction;
};
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

// The registration schema uses draft 2020-12, which needs the 2020 Ajv build.
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

/** The coordinator-registration schema this validator compiles. */
const SCHEMA_FILE = 'registration.v1.json';

let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the shared compiled validator, cached on first use.
 *
 * Before compiling, sets `properties.type.enum` to the current network's
 * domain ids from network config.
 */
export async function getRegistrationValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;
  const schemaPath = resolveSchemaPath();
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;

  try {
    const cfg = await getNetworkConfig();
    const ids = cfg.domainIds;
    if (ids.length > 0) {
      const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
      if (props?.['type']) {
        props['type']['enum'] = ids;
      }
    }
  } catch {
    // Keep the schema file's enum if network config is unavailable.
  }

  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator: ValidateFunction = ajv.compile(schema);
  cachedValidator = validator;
  return validator;
}

/**
 * Locates `registration.v1.json`, preferring a network/brand override.
 *
 * A network or brand can ship its own copy under
 * `config/<network>[/<brand>]/schemas/aggregator/`. Uses {@link resolveSchema},
 * so the validator and the recorded `profile_ref` pick the same file.
 *
 * @returns Absolute path to the most specific schema file that exists.
 * @throws {Error} If no candidate is readable.
 */
function resolveSchemaPath(): string {
  const resolved = resolveSchema(SCHEMA_FILE);
  if (!resolved) {
    throw new Error(
      `registration schema not found; tried: ${schemaCandidates(SCHEMA_FILE)
        .map((c) => c.path)
        .join(', ')}`,
    );
  }
  return resolved.path;
}

/**
 * Test-only; clears the cached validator so the next call recompiles.
 */
export function _resetValidator(): void {
  cachedValidator = null;
}
