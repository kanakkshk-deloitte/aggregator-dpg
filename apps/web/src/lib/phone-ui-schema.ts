/**
 * Puts the phone widget on every string field named `phone` in a form
 * schema, at any depth, unless the uiSchema already picks a widget for it.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The uiSchema with the phone widget on each phone field.
 *
 * @param uiSchema - The form's uiSchema.
 * @param schema - The form's JSON schema.
 */
export function withPhoneWidget(uiSchema: Json, schema: Json): Json {
  const props = isObject(schema['properties']) ? schema['properties'] : {};
  let out = uiSchema;
  for (const [key, prop] of Object.entries(props)) {
    if (!isObject(prop)) continue;
    const ui = isObject(uiSchema[key]) ? uiSchema[key] : {};
    let next: Json | null = null;
    if (key === 'phone' && prop['type'] === 'string' && !ui['ui:widget']) {
      next = { ...ui, 'ui:widget': 'phone' };
    } else if (prop['type'] === 'object') {
      const inner = withPhoneWidget(ui, prop);
      if (inner !== ui) next = inner;
    }
    if (next) out = { ...out, [key]: next };
  }
  return out;
}
