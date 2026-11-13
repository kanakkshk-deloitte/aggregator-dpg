/**
 * Browser-side caller of the console's BFF mutations.
 *
 * Sends same-origin JSON and returns the status and body instead of throwing,
 * so a view can update in place on `409 ALREADY_DECIDED`.
 *
 * @module apps/web/src/lib/console-client
 */

import type {
  KnownAsValues,
  KnownAsValuesRequest,
  Org,
  OrgKnownAsUpdateRequest,
} from '@aggregator-dpg/shared-primitives/user-org';

/** The API's error envelope, as far as the console reads it. */
export interface ConsoleError {
  code?: string;
  fields?: Record<string, unknown>;
}

export type ConsoleSendResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: ConsoleError };

/**
 * Calls a console BFF route.
 *
 * @param url - BFF path, e.g. `/api/console/user/decision/<id>`.
 * @param method - `POST` or `PATCH`.
 * @param body - JSON body.
 * @returns The outcome; never throws on an HTTP error.
 */
export async function sendConsole<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<ConsoleSendResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: {} };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const error = (json as { error?: ConsoleError } | null)?.error;
  return { ok: false, status: res.status, error: typeof error === 'object' && error ? error : {} };
}

/** Message keys for error codes that need no more detail. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  ORG_NAME_TAKEN: 'errors.name_taken',
  ROLE_ASSIGNMENT_NOT_ALLOWED: 'errors.role_not_allowed',
  ROLE_INVALID: 'errors.role_invalid',
  ROLE_EXISTS: 'errors.role_exists',
  ROLE_BUILTIN: 'errors.role_builtin',
  ROLE_IN_USE: 'errors.role_in_use',
  ROLE_LIMIT_REACHED: 'errors.role_limit',
  ORG_DEPTH_LIMIT: 'errors.depth_limit',
  ORG_CHILD_LIMIT: 'errors.child_limit',
  ORG_TOTAL_LIMIT: 'errors.total_limit',
  ORG_PARENT_CYCLE: 'errors.parent_cycle',
};

/** Message keys for error codes that name the cause in `fields`, as `[field, value, key]`. */
const FIELD_KEYS: Readonly<Record<string, ReadonlyArray<readonly [string, string, string]>>> = {
  CONFLICT: [
    ['reason', 'busy', 'errors.busy'],
    ['reason', 'not_movable', 'errors.not_movable'],
    ['reason', 'moved', 'errors.org_moved'],
  ],
  SCHEMA_VALIDATION: [
    ['parent_id', 'invalid', 'errors.parent_invalid'],
    ['known_as', 'invalid', 'errors.known_as_invalid'],
    ['known_as_values', 'unknown_key', 'errors.known_as_values_changed'],
  ],
};

/** The message key for an HTTP status with no more specific message. */
function statusKey(status: number): string {
  if (status === 0) return 'errors.network';
  if (status === 401) return 'errors.signed_out';
  if (status === 403) return 'errors.forbidden';
  if (status >= 500) return 'errors.server';
  return 'errors.generic';
}

/**
 * Sets an organisation's "known as" value (owner of its parent).
 *
 * @param orgId - The organisation.
 * @param knownAs - A key from the choices of the org's parent (`knownAsChoices`).
 * @returns The outcome, with the updated org on success.
 */
export function setOrgKnownAs(orgId: string, knownAs: string): Promise<ConsoleSendResult<Org>> {
  const body: OrgKnownAsUpdateRequest = { known_as: knownAs };
  return sendConsole<Org>(`/api/console/org/known-as/${orgId}`, 'PATCH', body);
}

/**
 * Replaces the "known as" values an organisation defines for its direct
 * children (its owner, or the network admin for the root).
 *
 * @param orgId - The organisation that defines the list.
 * @param values - The full list; saved entries keep their key, new ones omit it.
 * @returns The outcome, with the updated org and the saved list (keys filled) on success.
 */
export function setOrgKnownAsValues(
  orgId: string,
  values: KnownAsValuesRequest,
): Promise<ConsoleSendResult<Org & { known_as_values: KnownAsValues; reset_count?: number }>> {
  const body: OrgKnownAsUpdateRequest = { known_as_values: values };
  return sendConsole<Org & { known_as_values: KnownAsValues; reset_count?: number }>(
    `/api/console/org/known-as/${orgId}`,
    'PATCH',
    body,
  );
}

/**
 * Returns the console message key for a failed call.
 *
 * @param r - A failed result.
 * @returns A key under `console.errors`.
 */
export function errorKey(r: { status: number; error: ConsoleError }): string {
  if (r.status === 429) return 'errors.rate_limited';
  if (r.status === 404) return 'errors.not_found';
  const code = r.error.code ?? '';
  const byCode = CODE_KEYS[code];
  if (byCode) return byCode;
  const fields = r.error.fields ?? {};
  const byField = FIELD_KEYS[code]?.find(([field, value]) => fields[field] === value);
  if (byField) return byField[2];
  return statusKey(r.status);
}
