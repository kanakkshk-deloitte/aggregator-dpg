/**
 * Filters caller-supplied field names before they are written to the campaign PII audit row (api app).
 *
 * The voice route records the field names listed in `content.variables` as
 * `piiFields`. That array is free text, so a caller could put a participant's
 * name, email or phone in it. The audit table must hold field names and counts
 * only, never values.
 *
 * {@link sanitizeAuditFieldNames} keeps identifier-shaped names within a length
 * and count limit, and counts what it drops by reason. It never rejects a
 * request. Only the audit copy is filtered; `content.variables` itself is unchanged.
 *
 * A single-word value (e.g. a first name) looks like a field name and still passes.
 *
 * @module @aggregator-dpg/api
 */

/**
 * Field-name shape: letters, digits and underscore, starting with a letter or underscore.
 * Rejects spaces, `@` and `+`, which names, emails and phones usually contain.
 */
const FIELD_NAME_PATTERN = /^[A-Za-z_]\w*$/;

/**
 * Maximum length of one recorded field name; real `item_state` keys are far shorter.
 */
export const MAX_FIELD_NAME_LENGTH = 64;

/**
 * Maximum number of field names recorded on one audit row; matches the
 * `campaignMetadataPairSchema` cap in `envelope.ts`.
 */
export const MAX_FIELD_NAME_COUNT = 50;

/** Result of {@link sanitizeAuditFieldNames}. */
export interface SanitizedAuditFieldNames {
  /** Kept names, in input order. */
  names: string[];
  /** Entries dropped for not looking like a field name. */
  droppedCount: number;
  /** Identifier-shaped entries dropped for exceeding {@link MAX_FIELD_NAME_LENGTH}. */
  tooLongCount: number;
  /** Valid entries dropped because {@link MAX_FIELD_NAME_COUNT} was reached. */
  overLimitCount: number;
}

/**
 * Keeps the identifier-shaped, length- and count-bounded names for the audit `piiFields`.
 *
 * Checks shape, then length, then count; each failure goes to its own count.
 *
 * @param candidates - Raw caller strings (e.g. `content.variables`). Not mutated.
 * @returns The kept names and the dropped counts by reason.
 */
export function sanitizeAuditFieldNames(candidates: readonly string[]): SanitizedAuditFieldNames {
  const names: string[] = [];
  let droppedCount = 0;
  let tooLongCount = 0;
  let overLimitCount = 0;

  for (const candidate of candidates) {
    if (!FIELD_NAME_PATTERN.test(candidate)) {
      droppedCount++;
    } else if (candidate.length > MAX_FIELD_NAME_LENGTH) {
      tooLongCount++;
    } else if (names.length >= MAX_FIELD_NAME_COUNT) {
      overLimitCount++;
    } else {
      names.push(candidate);
    }
  }

  return { names, droppedCount, tooLongCount, overLimitCount };
}

/**
 * Builds the extra `piiFields` entries: the kept names plus one count entry per drop reason.
 *
 * @param candidates - Raw caller strings (e.g. `content.variables`).
 * @returns Entries to append to a channel's `piiFields` array.
 */
export function auditFieldNameEntries(candidates: readonly string[]): string[] {
  const { names, droppedCount, tooLongCount, overLimitCount } = sanitizeAuditFieldNames(candidates);
  const summaries: string[] = [];
  if (droppedCount > 0) summaries.push(`+${droppedCount} redacted (non-identifier)`);
  if (tooLongCount > 0) summaries.push(`+${tooLongCount} redacted (too long)`);
  if (overLimitCount > 0) summaries.push(`+${overLimitCount} redacted (over limit)`);
  return [...names, ...summaries];
}
