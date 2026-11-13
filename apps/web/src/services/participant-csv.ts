/**
 * Builds an RFC 4180 CSV of the selected dashboard rows in the browser (web app).
 *
 * @module apps/web/services/participant-csv
 */

import type { ParticipantBase } from '../types';

/** Column order of the generated CSV. Do not rename headers. */
const COLUMNS = [
  'id',
  'name',
  'joined',
  'profile_completion_pct',
  'lifecycle_status',
  'status',
  'initiated_create',
  'initiated_accept',
  'initiated_reject',
  'initiated_cancel',
  'received_create',
  'received_accept',
  'received_reject',
  'received_cancel',
] as const;

/**
 * Quotes a CSV field per RFC 4180 when it contains a comma, quote or line break.
 *
 * @param value - Raw field value; null/undefined render as an empty field.
 * @returns The escaped field, safe to join with commas.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Builds a CSV document with a header and one line per row.
 *
 * Empty input yields only the header. Lines are joined with CRLF.
 *
 * @param rows - Selected participant rows from any domain.
 * @returns The full CSV string.
 */
export function buildParticipantCsv(rows: ParticipantBase[]): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.name),
        csvField(r.joined),
        csvField(r.profile.complete),
        csvField(r.lifecycle_status ?? ''),
        csvField(r.status),
        csvField(r.initiated.create),
        csvField(r.initiated.accept),
        csvField(r.initiated.reject),
        csvField(r.initiated.cancel),
        csvField(r.received.create),
        csvField(r.received.accept),
        csvField(r.received.reject),
        csvField(r.received.cancel),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}
