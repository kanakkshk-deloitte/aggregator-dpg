/**
 * Public surface and factory for the consent ledger.
 *
 * Returns a process-wide singleton wired to the shared Drizzle DB client.
 * Tests override via `_setConsentLedger`.
 *
 * @module apps/api/services/consent-ledger
 */

import type { ConsentLedgerBase } from '@aggregator-dpg/consent-ledger/interface';
import { PostgresConsentLedger } from '@aggregator-dpg/consent-ledger/postgres';
import { getDb } from '../../db/client.js';

let instance: ConsentLedgerBase | null = null;

/**
 * Returns the shared consent ledger singleton.
 *
 * Created on first call with the shared Drizzle DB handle.
 *
 * @returns The process-wide {@link ConsentLedgerBase} instance.
 */
export function getConsentLedger(): ConsentLedgerBase {
  if (instance) return instance;
  instance = new PostgresConsentLedger(getDb());
  return instance;
}

/**
 * Test helper — replace the singleton. Pass `null` to rebuild the real one on next call.
 *
 * @param ledger - The replacement ledger, or `null` to reset.
 */
export function _setConsentLedger(ledger: ConsentLedgerBase | null): void {
  instance = ledger;
}

export type { ConsentLedgerBase } from '@aggregator-dpg/consent-ledger/interface';
