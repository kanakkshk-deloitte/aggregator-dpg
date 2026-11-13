/**
 * Identity-selector sniffer for the network-config package.
 *
 * Given a participant profile JSON Schema, returns the field names used as
 * `name`, `phone` and `email`. Schemas with unusual field names can set
 * `field_overrides` in the aggregator YAML instead.
 *
 * @module @aggregator-dpg/network-config/sniffer
 */

import type { IdentitySelectors } from './interface.js';

/**
 * The JSON Schema fields the sniffer reads. Unknown keys are ignored.
 */
interface SchemaProperty {
  type?: string | string[];
  pattern?: string;
  format?: string;
  title?: string;
  minLength?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

interface SchemaShape {
  properties?: Record<string, SchemaProperty>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

/**
 * Derives {@link IdentitySelectors} from a JSON Schema's properties.
 *
 * The first matching property wins:
 *   - phone: `format: tel`, a 10-digit or E.164 `pattern`, or a name
 *     containing "phone" or "mobile".
 *   - email: `format: email`, or a name containing "email".
 *   - name: a string or untyped field named `name`, or with a `name` word in
 *     snake_case or camelCase. The phone and email fields are excluded.
 *
 * @param schema - The profile JSON Schema.
 * @returns The selectors, or `null` when phone, email or name cannot be found.
 */
export function sniffIdentitySelectors(schema: unknown): IdentitySelectors | null {
  if (!schema || typeof schema !== 'object') return null;
  const props = (schema as SchemaShape).properties;
  if (!props || typeof props !== 'object') return null;

  const phone = pickFirstMatch(props, isPhoneField);
  const email = pickFirstMatch(props, isEmailField);
  if (!phone || !email) return null;

  const name = pickFirstMatch(props, (p, n) => isNameField(p, n) && n !== phone && n !== email);
  if (!name) return null;

  return { name, phone, email };
}

function pickFirstMatch(
  props: Record<string, SchemaProperty>,
  predicate: (prop: SchemaProperty, name: string) => boolean,
): string | null {
  for (const [name, prop] of Object.entries(props)) {
    if (predicate(prop, name)) return name;
  }
  return null;
}

const PHONE_PATTERNS = [/^\^\[0-9\]\{10\}\$$/, /^\\?\+/, /e\.164/i];

function isPhoneField(prop: SchemaProperty, name: string): boolean {
  if (prop.format === 'tel') return true;
  if (typeof prop.pattern === 'string') {
    for (const p of PHONE_PATTERNS) if (p.test(prop.pattern)) return true;
  }
  return /phone|mobile/i.test(name);
}

function isEmailField(prop: SchemaProperty, name: string): boolean {
  if (prop.format === 'email') return true;
  return /email/i.test(name);
}

function isNameField(prop: SchemaProperty, name: string): boolean {
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (type !== 'string' && type !== undefined) return false;
  if (name === 'name') return true;
  // snake_case: `beneficiary_name`, `contact_name`, `name_of_role`.
  if (/(^|_)name($|_)/i.test(name)) return true;
  // camelCase: `jobProviderName`, `firstName`, `nameOfRole`.
  if (/(^name|Name$|^name[A-Z])/i.test(name)) return true;
  return false;
}
