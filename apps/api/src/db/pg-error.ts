/**
 * Postgres driver-error helpers (`@aggregator-dpg/api`).
 *
 * Drizzle wraps the pg error, so the SQLSTATE `code` and `constraint` are on
 * `.cause`. Stores classify violations by SQLSTATE, never by matching message text.
 */

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';

/** Walks the `.cause` chain (bounded) and returns the first string field found. */
function walkString(err: unknown, key: 'code' | 'constraint'): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === 'object') {
      const v = (cur as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The Postgres SQLSTATE for a thrown (possibly Drizzle-wrapped) error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  return walkString(err, 'code');
}

/** The violated constraint name for a thrown error, if the driver set one. */
export function pgConstraint(err: unknown): string | undefined {
  return walkString(err, 'constraint');
}
