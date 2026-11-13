/**
 * Builds a CSV from decrypted signalstack profiles for the aggregator's
 * "Export profile data" action. Belongs to @aggregator-dpg/profile-csv.
 *
 * Columns: `item_id` first, then identity-like columns (name fields, then
 * phone/mobile fields) regardless of the network-specific field names, then
 * the remaining union of item_state keys in alphabetical order. Values that
 * are objects/arrays are JSON-stringified; every field is neutralized against
 * spreadsheet formula injection and then RFC-4180 escaped.
 */
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

/**
 * Ordered identity-column patterns. Keys matching an earlier pattern sort first.
 * Patterns keep this network-agnostic, e.g. `beneficiary_name` and
 * `mobile_number` also match.
 */
const PRIORITY_PATTERNS = [/name/i, /phone|mobile|contact/i] as const;

/**
 * Returns the sort rank of a column key from {@link PRIORITY_PATTERNS}. Lower sorts first.
 *
 * @param key - The item_state field name.
 * @returns The sort rank (0-based; `PRIORITY_PATTERNS.length` when no match).
 */
function priorityRank(key: string): number {
  const idx = PRIORITY_PATTERNS.findIndex((re) => re.test(key));
  return idx === -1 ? PRIORITY_PATTERNS.length : idx;
}

/**
 * Neutralizes spreadsheet formula injection.
 *
 * Spreadsheets treat a cell starting with `=`, `+`, `-`, `@`, TAB or CR as a
 * formula. A leading single quote makes the cell literal text.
 *
 * @param value - The raw cell string.
 * @returns The value, prefixed with `'` when it starts with a formula trigger.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Escapes a single CSV field: first neutralizes formula triggers, then applies
 * RFC 4180 quoting (quote when it contains a comma, quote, CR, or LF; double
 * embedded quotes).
 *
 * @param value - The raw string value of the field.
 * @returns The formula-safe, RFC-4180 escaped field string.
 */
function csvField(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Renders one item_state value to a CSV cell string. Objects/arrays become
 * compact JSON; null/undefined become an empty string.
 *
 * @param value - The raw value from item_state.
 * @returns The string representation suitable for a CSV cell.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value as string | number | boolean | bigint | symbol);
}

/**
 * Builds the CSV body (CRLF line endings) from decrypted profile rows.
 *
 * @param rows - Decrypted profiles returned by signalstack.
 * @returns The CSV text. Header is just `item_id` when `rows` is empty.
 */
export function buildDecryptedProfilesCsv(rows: SignalStackDecryptedProfileRow[]): string {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.item_state ?? {})) keys.add(k);
  }
  const stateCols = [...keys].sort((a, b) => {
    const ra = priorityRank(a);
    const rb = priorityRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const header = ['item_id', ...stateCols];

  const lines = [header.map(csvField).join(',')];
  for (const r of rows) {
    const cells = [
      csvField(r.item_id),
      ...stateCols.map((c) => csvField(renderCell(r.item_state?.[c]))),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}

/** The three canonical contact fields exported by the campaign PII export. */
const CONTACT_FIELDS = ['name', 'email', 'phone'] as const;

/**
 * Maps a Signals decrypt contact `source` to the export's provenance label:
 * `item` → `profile`, `user` → `user`, and absent/`null` → `none`.
 *
 * @param source - The `source` from a Signals `contact` field.
 * @returns The export-facing provenance label.
 */
function contactSourceLabel(
  source: 'item' | 'user' | null | undefined,
): 'profile' | 'user' | 'none' {
  if (source === 'item') return 'profile';
  if (source === 'user') return 'user';
  return 'none';
}

/**
 * Builds the campaign PII export CSV with one row per profile.
 *
 * Columns: `item_id,name,name_source,email,email_source,phone,phone_source`.
 * The column set is the same for every network and item type. Every field is
 * formula-neutralised and RFC-4180 escaped.
 *
 * @param rows - Decrypted profiles carrying a `contact` block.
 * @returns The CSV text (CRLF line endings).
 */
export function buildContactExportCsv(rows: SignalStackDecryptedProfileRow[]): string {
  const header = ['item_id'];
  for (const f of CONTACT_FIELDS) header.push(f, `${f}_source`);
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) {
    const cells = [csvField(r.item_id)];
    for (const f of CONTACT_FIELDS) {
      const c = r.contact?.[f];
      const value = typeof c?.value === 'string' ? c.value : '';
      cells.push(csvField(value), csvField(contactSourceLabel(c?.source)));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}
