/**
 * Readable, field-named wording for a failed participant-schema check.
 *
 * The aggregator validates a participant with ajv before pushing it to
 * Signals, and Signals validates it again. Signals words each failure for a
 * person ("website: Please enter a valid web address.", "must be one of: …")
 * while ajv's own text is for developers (`must match pattern "^\s*$|…"`).
 * This module gives the aggregator Signals' wording, so the registration form
 * and the bulk `errors.csv` name the field and say what is wrong — whichever
 * side caught it (aggregator-dpg#904).
 *
 * Mirrors Signals' `describeAjvError` in `packages/schemas/src/network_workflow.ts`.
 * Dependency-free, like `./uri-fields`.
 *
 * @module @aggregator-dpg/network-config/field-errors
 */

type JsonRecord = Record<string, unknown>;

/** The subset of an ajv `ErrorObject` this module reads. */
export interface SchemaIssue {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
}

/** One failed field, ready to show a person. */
export interface FieldError {
  /** Dot path of the offending value (`address.city`, `links.1`); empty for the payload root. */
  field: string;
  /** The field's `title` from the schema, else `field`. */
  label: string;
  /** What is wrong, in Signals' wording. Never contains a raw regex. */
  message: string;
}

/** Per-field copy for a failed `pattern`, authored in network.json (same marker as Signals). */
const FIELD_ERROR_MESSAGE_MARKER = 'x-error-message';

/** How many allowed values an enum message lists before eliding (matches Signals). */
const ENUM_VALUES_SHOWN = 10;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks `schema` along a value path and returns the property schemas visited,
 * outermost first. Numeric segments step into `items`.
 */
function schemaTrail(schema: unknown, segments: string[]): JsonRecord[] {
  const trail: JsonRecord[] = [];
  let node: unknown = schema;
  for (const seg of segments) {
    if (!isPlainObject(node)) break;
    if (/^\d+$/.test(seg) && isPlainObject(node.items)) {
      node = node.items;
    } else if (isPlainObject(node.properties) && isPlainObject(node.properties[seg])) {
      node = node.properties[seg];
    } else {
      break;
    }
    trail.push(node as JsonRecord);
  }
  return trail;
}

/** The nearest schema on the trail with a title: an array item has none, its list does. */
function nearestTitled(trail: JsonRecord[]): JsonRecord | undefined {
  return [...trail].reverse().find((s) => typeof s.title === 'string' && s.title.trim());
}

/**
 * Returns the label to show for a field: its schema `title`, else the path.
 *
 * Used to label errors that arrive already keyed by field (Signals' per-field
 * `fields` map) rather than as ajv issues.
 *
 * @param schema - The participant schema; may be undefined.
 * @param field - Dot path of the field (`website`, `links.1`).
 * @returns The title of the field (or its nearest titled ancestor), else `field`.
 */
export function fieldLabel(schema: unknown, field: string): string {
  const titled = nearestTitled(schemaTrail(schema, field.split('.').filter(Boolean)));
  return titled ? String(titled.title) : field;
}

/**
 * Turns one ajv issue into a field name, a label and a readable message.
 *
 * A failed `pattern` never shows the regex: the field's `x-error-message` wins,
 * then a link field (`x-uri` on the field or on the array holding it) reads
 * "Please enter a valid web address.", any other field "Please enter a valid
 * <title>.". `minLength: 1` reads "is required". An `enum` lists up to ten
 * allowed values. Other keywords keep ajv's message.
 *
 * @param issue - One entry of ajv's `validate.errors`.
 * @param schema - The schema the value was validated against, used for the
 *   field's title and URL marker; may be undefined.
 * @returns The described field error; never throws on a malformed issue.
 */
export function describeSchemaIssue(issue: SchemaIssue, schema: unknown): FieldError {
  const params = issue.params ?? {};
  const segments = (issue.instancePath ?? '').split('/').filter(Boolean);
  if (issue.keyword === 'required' && typeof params.missingProperty === 'string') {
    segments.push(params.missingProperty);
  }
  if (issue.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    segments.push(params.additionalProperty);
  }
  if (issue.keyword === 'unevaluatedProperties' && typeof params.unevaluatedProperty === 'string') {
    segments.push(params.unevaluatedProperty);
  }
  const field = segments.join('.');
  const trail = schemaTrail(schema, segments);
  const titled = nearestTitled(trail);
  const label = titled ? String(titled.title) : field;

  let message: string;
  switch (issue.keyword) {
    case 'required':
      message = 'is required';
      break;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      message = 'is not an allowed field';
      break;
    case 'minLength':
      // `minLength: 1` is how a schema says "required and not blank".
      message = params.limit === 1 ? 'is required' : (issue.message ?? 'is invalid');
      break;
    case 'enum': {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      if (allowed.length === 0) {
        message = issue.message ?? 'is invalid';
        break;
      }
      const shown = allowed.slice(0, ENUM_VALUES_SHOWN).map(String).join(', ');
      message = `must be one of: ${shown}${allowed.length > ENUM_VALUES_SHOWN ? ', …' : ''}`;
      break;
    }
    case 'pattern': {
      const authored = trail.at(-1)?.[FIELD_ERROR_MESSAGE_MARKER];
      const isLink = trail.slice(-2).some((s) => s['x-uri'] === true);
      if (typeof authored === 'string' && authored.trim()) message = authored;
      else if (isLink) message = 'Please enter a valid web address.';
      else message = `Please enter a valid ${titled ? String(titled.title) : 'value'}.`;
      break;
    }
    default:
      message = issue.message ?? 'is invalid';
  }
  return { field, label, message };
}

/**
 * Joins field errors into one sentence-per-field string for a banner or a CSV
 * cell, e.g. `Website: Please enter a valid web address. Age: must be >= 14`.
 * Only the first error per field is kept, as Signals does.
 *
 * @param errors - Described field errors, in report order.
 * @returns The joined text; empty when there are no errors.
 */
export function formatFieldErrors(errors: readonly FieldError[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of errors) {
    if (e.field && seen.has(e.field)) continue;
    if (e.field) seen.add(e.field);
    const text = /[.!?]$/.test(e.message) ? e.message : `${e.message}.`;
    parts.push(e.label ? `${e.label}: ${text}` : text);
  }
  return parts.join(' ');
}
