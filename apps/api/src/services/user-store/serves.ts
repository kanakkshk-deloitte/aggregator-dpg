/**
 * The domains a coordinator serves (`users.serves`) in the `@aggregator-dpg/api`
 * user store. Shared by the Postgres and in-memory stores.
 */

/**
 * The `serves` value for a registration's domain.
 *
 * `null` means every domain and is stored as `[]`; a domain id is stored as a
 * one-element array. The caller validates the id first.
 *
 * @param type - The domain id from the request (already validated), or null.
 * @returns The domain ids to store.
 */
export function servesOf(type: string | null): string[] {
  return type === null ? [] : [type];
}
