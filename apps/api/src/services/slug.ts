/**
 * Slug generation utilities (`@aggregator-dpg/api`).
 *
 * `slugify` makes a URL-safe, lower-case, hyphenated string. `randomSuffix`
 * adds a short hex suffix so equal names do not collide on the unique
 * `signalstack_org_slug` column. The slug is set once at insert; a DB trigger
 * rejects any later change.
 */

import { randomBytes } from 'node:crypto';

const MAX_SLUG_LEN = 60;

/**
 * Converts a free-form string into a URL-safe slug.
 *
 * Returns "org" when the input has no slug-friendly characters.
 *
 * @param input - Raw input (aggregator display name).
 * @returns Lower-case slug, max 60 chars.
 */
export function slugify(input: string): string {
  const cleaned = (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LEN);
  return cleaned || 'org';
}

/**
 * Returns a short hex suffix suitable for slug uniqueness.
 *
 * @param bytes - Number of random bytes (default 2 → 4 hex chars).
 * @returns Lower-case hex string.
 */
export function randomSuffix(bytes = 2): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Builds `slugify(name)-<hex>` from the display name.
 *
 * Call once at insert; the slug cannot change afterwards.
 *
 * @param name - Coordinator display name from the registration payload.
 * @param bytes - Random suffix length in bytes (default 2 → 4 hex chars).
 */
export function slugFromName(name: string, bytes = 2): string {
  return `${slugify(name)}-${randomSuffix(bytes)}`;
}

/**
 * Alias for {@link slugFromName}, for callers that pass an association string.
 *
 * @deprecated Use {@link slugFromName} once the registration route is on the new payload.
 */
export function slugWithSuffix(stem: string, bytes = 2): string {
  return slugFromName(stem, bytes);
}
