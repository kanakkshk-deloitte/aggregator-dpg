/**
 * Package root — re-exports the write-only audit contract and the
 * Postgres-backed implementation.
 *
 * @module @aggregator-dpg/campaign-audit
 */
export * from './interface.js';
export { PostgresCampaignAuditWriter, type AuditDb } from './postgres.js';
