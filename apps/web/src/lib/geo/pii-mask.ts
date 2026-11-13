/**
 * Detects masked PII values. Same as Signals-DPG `apps/ui/src/lib/geo/pii-mask.ts`.
 *
 * @module apps/web/lib/geo/pii-mask
 */
/**
 * Returns true when a value looks like an API-masked PII value (e.g. "M***",
 * "+91-XX-XXXX-X123").
 *
 * Check this before geocoding; masked values waste quota and give bad results.
 *
 * @param value - The field value to check.
 * @returns True when the value looks masked.
 */
export function looksLikePIIMask(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/\*{3,}/.test(trimmed)) return true;
  // Phone-style mask, e.g. "+91-XX-XXXX-X123".
  if (/X{3,}/.test(trimmed)) return true;
  // Treat as masked when mask characters are at least 40% of the string.
  const maskChars = trimmed.match(/[*X]/g)?.length ?? 0;
  return maskChars / trimmed.length >= 0.4;
}
