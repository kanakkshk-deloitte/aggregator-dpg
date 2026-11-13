/**
 * Validation of an organisation's schema-driven fields (`@aggregator-dpg/api`).
 *
 * The fields come from the deployment's `org-registration.v1.json`, so a
 * deployment adds or removes an organisation field by editing that file.
 * The schema is compiled with Ajv once per process. Three markers on a
 * property are read here:
 *
 * - `x-network-domains: true` — the value is one or more of the network's
 *   domain ids; the ids are filled in from network config before compiling.
 * - `x-check: "gstin"` — after the schema passes, the GSTIN check character is
 *   verified too, and the value is stored upper-cased.
 * - `x-updatable: true` — the owner may change the field in the console after
 *   registration; no other field is accepted on a console edit.
 *
 * @module apps/api/src/services/org-schema-validator
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { describeSchemaIssue, type SchemaIssue } from '@aggregator-dpg/network-config/field-errors';
import { isValidGstin, normaliseGstin } from '@aggregator-dpg/shared-primitives/org-details';
import { getNetworkConfig } from './network-config.js';
import { resolveSchema, schemaCandidates } from './schema-ref.js';

const require = createRequire(import.meta.url);
// ajv and ajv-formats are CommonJS; load their default exports through createRequire.
type AjvOptions = { allErrors?: boolean; strict?: boolean | 'log' };
type AjvLike = { compile(schema: unknown): ValidateFunction };
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

// The org-registration schema uses draft 2020-12, which needs the 2020 Ajv build.
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

/** The organisation schema this module compiles. */
const SCHEMA_FILE = 'org-registration.v1.json';

/**
 * Registration body keys the API checks and stores itself; the schema's copy
 * of them is for the form only.
 */
const FIXED_REGISTRATION_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'parent_id',
  'state',
  'owner',
  'consent',
  'address',
]);

/** Message for a GSTIN that fails its check character, unless the schema words it. */
const GSTIN_MESSAGE = 'Please enter a valid GSTIN.';

type JsonRecord = Record<string, unknown>;

/** Field → message, one per bad field. */
export type OrgFieldErrors = Record<string, string>;

/** Outcome of validating organisation fields. */
export type OrgFieldsResult =
  { ok: true; values: JsonRecord } | { ok: false; errors: OrgFieldErrors };

/** The compiled organisation schema and what its markers say. */
interface CompiledOrgSchema {
  /** The schema with network domains filled in. */
  schema: JsonRecord;
  /** The schema's own fields: every top-level property but the fixed ones. */
  fields: Set<string>;
  /** Properties the owner may change after registration. */
  updatable: Set<string>;
  /** Properties that also need the GSTIN check. */
  gstin: Set<string>;
  /** Validator for the schema's own fields at registration. */
  validateFields: ValidateFunction;
  /** Validator for the updatable properties only, none required. */
  validateUpdatable: ValidateFunction;
}

let cached: Promise<CompiledOrgSchema> | null = null;

/** Whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sets the allowed values of every `x-network-domains` property to the
 * network's domain ids. Leaves the schema alone when there are none.
 */
function fillNetworkDomains(properties: Record<string, JsonRecord>, ids: string[]): void {
  if (ids.length === 0) return;
  for (const prop of Object.values(properties)) {
    if (prop['x-network-domains'] !== true) continue;
    if (prop['type'] === 'array') {
      const items = isRecord(prop['items']) ? prop['items'] : {};
      prop['items'] = { ...items, type: 'string', enum: ids };
    } else {
      prop['enum'] = ids;
    }
  }
}

/** Loads, patches and compiles the deployment's organisation schema. */
async function compile(): Promise<CompiledOrgSchema> {
  const resolved = resolveSchema(SCHEMA_FILE);
  if (!resolved) {
    throw new Error(
      `org-registration schema not found; tried: ${schemaCandidates(SCHEMA_FILE)
        .map((c) => c.path)
        .join(', ')}`,
    );
  }
  const schema = JSON.parse(readFileSync(resolved.path, 'utf8')) as JsonRecord;
  const properties = (isRecord(schema['properties']) ? schema['properties'] : {}) as Record<
    string,
    JsonRecord
  >;
  try {
    fillNetworkDomains(properties, (await getNetworkConfig()).domainIds);
  } catch {
    // Without network config the schema's own values stand.
  }

  const updatable = new Set<string>();
  const gstin = new Set<string>();
  for (const [name, prop] of Object.entries(properties)) {
    if (prop['x-updatable'] === true) updatable.add(name);
    if (prop['x-check'] === 'gstin') gstin.add(name);
  }

  const fields = new Set(Object.keys(properties).filter((k) => !FIXED_REGISTRATION_KEYS.has(k)));
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const subSchema = (names: Iterable<string>, req: string[]): JsonRecord => ({
    $schema: schema['$schema'],
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries([...names].map((name) => [name, properties[name]])),
    required: req,
  });
  return {
    schema,
    fields,
    updatable,
    gstin,
    validateFields: ajv.compile(
      subSchema(
        fields,
        required.filter((k) => fields.has(k)),
      ),
    ),
    validateUpdatable: ajv.compile(subSchema(updatable, [])),
  };
}

/** The compiled schema, compiled on first use. */
function compiled(): Promise<CompiledOrgSchema> {
  cached ??= compile().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

/**
 * Ajv's issues as field → message, first message per field. Keyed by the
 * top-level field (`domains`, not `domains.1`), which is what a form shows
 * the message under.
 */
function describe(validate: ValidateFunction, schema: JsonRecord): OrgFieldErrors {
  const errors: OrgFieldErrors = {};
  for (const issue of (validate.errors ?? []) as SchemaIssue[]) {
    const { field, message } = describeSchemaIssue(issue, schema);
    const key = field.split('.')[0] ?? field;
    if (!Object.hasOwn(errors, key)) errors[key] = message;
  }
  return errors;
}

/**
 * Tidies values before validation: strings are trimmed, an empty string is
 * dropped (the field is left empty), and a GSTIN is upper-cased.
 */
function tidy(c: CompiledOrgSchema, values: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    const trimmed = c.gstin.has(key) ? normaliseGstin(value) : value.trim();
    if (trimmed !== '') out[key] = trimmed;
  }
  return out;
}

/**
 * Applies `x-check: "gstin"`: refuses a GSTIN whose check character is wrong.
 * The schema's pattern has already checked the shape.
 */
function checkGstin(c: CompiledOrgSchema, values: JsonRecord, errors: OrgFieldErrors): void {
  for (const name of c.gstin) {
    const value = values[name];
    if (typeof value !== 'string' || Object.hasOwn(errors, name)) continue;
    if (!isValidGstin(value)) {
      const prop = (c.schema['properties'] as Record<string, JsonRecord>)[name];
      const authored = prop?.['x-error-message'];
      errors[name] = typeof authored === 'string' && authored.trim() ? authored : GSTIN_MESSAGE;
    }
  }
}

/**
 * Validates the schema's own fields of a registration body.
 *
 * The fixed parts (`display_name`, `owner`, `consent`, `address`, `state`) are
 * checked by the route. Keys the schema does not declare are dropped, as a
 * field another deployment's schema has is not this deployment's.
 *
 * @param body - The registration body.
 * @returns The tidied schema-field values (GSTINs upper-cased), or field errors.
 * @throws {Error} If no org-registration schema can be found.
 */
export async function validateOrgRegistration(body: JsonRecord): Promise<OrgFieldsResult> {
  const c = await compiled();
  const values = tidy(
    c,
    Object.fromEntries(Object.entries(body).filter(([key]) => c.fields.has(key))),
  );
  const errors: OrgFieldErrors = c.validateFields(values)
    ? {}
    : describe(c.validateFields, c.schema);
  checkGstin(c, values, errors);
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

/**
 * Validates a console edit of an organisation's schema fields.
 *
 * Only `x-updatable` properties are accepted. A `null` value removes the key
 * and is not validated further.
 *
 * @param changes - Keys to set (or `null` / an empty string to remove).
 * @returns The changes (tidied, GSTINs upper-cased; `null` = remove), or field errors.
 * @throws {Error} If no org-registration schema can be found.
 */
export async function validateOrgUpdate(changes: JsonRecord): Promise<OrgFieldsResult> {
  const c = await compiled();
  const errors: OrgFieldErrors = {};
  const toSet: JsonRecord = {};
  const toRemove: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!c.updatable.has(key)) errors[key] = 'is not an editable field';
    else if (value === null) toRemove.push(key);
    else toSet[key] = value;
  }
  const tidied = tidy(c, toSet);
  // A value tidied away (an empty string) clears the field.
  for (const key of Object.keys(toSet)) if (!Object.hasOwn(tidied, key)) toRemove.push(key);
  if (!c.validateUpdatable(tidied)) {
    for (const [field, message] of Object.entries(describe(c.validateUpdatable, c.schema))) {
      if (!Object.hasOwn(errors, field)) errors[field] = message;
    }
  }
  checkGstin(c, tidied, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const values: JsonRecord = { ...tidied };
  for (const key of toRemove) values[key] = null;
  return { ok: true, values };
}

/**
 * Test-only; clears the compiled schema so the next call recompiles.
 */
export function _resetOrgSchemaValidator(): void {
  cached = null;
}
