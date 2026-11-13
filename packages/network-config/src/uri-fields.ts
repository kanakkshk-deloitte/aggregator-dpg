/**
 * The one URL rule for participant schemas, matching Signals byte for byte.
 *
 * A network.json declares a link field in one of two ways: Signals' own
 * `"x-uri": true` marker, or the standard `"format": "uri"`. Signals validates
 * the marker with its shared `URL_PATTERN` (scheme optional) and ignores
 * `format` entirely — its ajv has no `ajv-formats`. The aggregator did the
 * opposite: its ajv enforces `format: "uri"` (an absolute URI, so
 * `www.example.org` is rejected) and knows nothing of `x-uri` (so `NA` is
 * accepted, then rejected by Signals on the push — aggregator-dpg#904).
 *
 * `applyUrlRule` rewrites both declarations to the Signals rule when the
 * network config is loaded, so the registration form, the public submit route
 * and the bulk worker all validate a link field exactly as Signals will.
 *
 * `URL_PATTERN` is a verbatim copy of Signals'
 * `packages/schemas/src/uri_fields.ts`. Keep the two identical; the test list
 * in `__tests__/uri-fields.test.ts` is Signals' own.
 *
 * Dependency-free on purpose: the web app may import it into the client bundle.
 *
 * @module @aggregator-dpg/network-config/uri-fields
 */

type JsonRecord = Record<string, unknown>;

/** Signals' field-level URL marker. */
const URI_FIELD_MARKER = 'x-uri';

/**
 * Signals' URL rule: optional http(s) scheme, a dotted host ending in letters,
 * optional port, path, query or fragment; surrounding whitespace and the empty
 * string are accepted (presence is `required[]`'s job).
 */
export const URL_PATTERN = String.raw`^\s*$|^\s*([hH][tT][tT][pP][sS]?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d{1,5})?([\/?#][^\s]*)?\s*$`;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of a participant schema with every link field validated by
 * the Signals URL rule.
 *
 * A link field is a string property (or the `items` of an array property)
 * carrying `"x-uri": true` or `"format": "uri"`. Each one gets `x-uri: true`,
 * loses `format: "uri"`, and gains `pattern: URL_PATTERN` unless it already
 * declares its own `pattern`. Recurses through nested `properties` and
 * `items`. The input is never mutated.
 *
 * @param schema - A JSON Schema document (normally one network.json item schema).
 * @returns The rewritten schema; non-object input is returned unchanged.
 */
export function applyUrlRule<T>(schema: T): T {
  if (!isPlainObject(schema)) return schema;
  return transform(schema) as T;
}

function transform(node: JsonRecord): JsonRecord {
  let out: JsonRecord = { ...node };

  if (isPlainObject(node.properties)) {
    const props: JsonRecord = {};
    for (const [key, prop] of Object.entries(node.properties)) {
      props[key] = isPlainObject(prop) ? transform(prop) : prop;
    }
    out.properties = props;
  }

  if (isPlainObject(node.items)) {
    out.items = transform(node.items);
  }

  if (isLinkField(node)) {
    if (node.type === 'array' && isPlainObject(out.items)) {
      // `x-uri` on an array means "a list of links": the rule goes on items.
      out.items = withUrlRule(out.items as JsonRecord, false);
    } else {
      out = withUrlRule(out, true);
    }
  }
  return out;
}

/** True when the node declares itself a link field, either way. */
function isLinkField(node: JsonRecord): boolean {
  return node[URI_FIELD_MARKER] === true || node.format === 'uri';
}

/**
 * Applies the URL rule to one string schema.
 *
 * @param node - The (already recursed) string schema.
 * @param markLink - Whether to stamp `x-uri: true` on this node; false for the
 *   `items` of an `x-uri` array, whose parent already carries the marker.
 */
function withUrlRule(node: JsonRecord, markLink: boolean): JsonRecord {
  const { format, ...rest } = node;
  const out: JsonRecord = format === 'uri' ? rest : { ...node };
  if (markLink || format === 'uri') out[URI_FIELD_MARKER] = true;
  if (out.pattern === undefined) out.pattern = URL_PATTERN;
  return out;
}
