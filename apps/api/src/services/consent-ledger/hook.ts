/**
 * The consent write a store runs inside its create transaction
 * (`@aggregator-dpg/api`). The `consent_record` row commits with its account
 * or org, or neither does.
 */

/**
 * Writes the registration's consent row inside the store's create
 * transaction. Any thrown error rolls back the whole create and the store
 * answers `CONSENT_WRITE_FAILED`.
 *
 * @param executor - The store's transaction (Postgres), or `undefined` for a
 *   store without transactions.
 * @param subjectId - The id of the row just inserted (user or organisation).
 */
export type RecordConsentHook = (executor: unknown, subjectId: string) => Promise<void>;

/**
 * A hook that writes nothing, for tests. Never pass it from a route.
 */
export const NO_CONSENT_WRITE: RecordConsentHook = async () => {};
