/**
 * Plain-language messages for a failed console action (`apps/web`).
 *
 * @module apps/web/src/lib/console-errors
 */

import type { ConsoleError } from './console-client';

/**
 * The message key for a failed console action, under `<namespace>.error`.
 * Each namespace defines `network`, `signed_out`, `forbidden`, `not_found`,
 * `rate_limited`, `server` and `generic`, plus any kinds named in `byCode`.
 *
 * @param r - The failed result.
 * @param namespace - The message namespace, such as `coordinator` or `orgs`.
 * @param byCode - Extra kinds for specific API error codes.
 * @returns A key for `useTranslations('console')`.
 */
export function plainErrorKey(
  r: { status: number; error: ConsoleError },
  namespace: string,
  byCode: Readonly<Record<string, string>> = {},
): string {
  const kind = (k: string) => `${namespace}.error.${k}`;
  const special = r.error.code ? byCode[r.error.code] : undefined;
  if (special) return kind(special);
  if (r.status === 0) return kind('network');
  if (r.status === 401) return kind('signed_out');
  if (r.status === 403) return kind('forbidden');
  if (r.status === 404) return kind('not_found');
  if (r.status === 429) return kind('rate_limited');
  if (r.status >= 500) return kind('server');
  return kind('generic');
}
