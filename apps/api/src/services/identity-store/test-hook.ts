/**
 * Test-only hook for the identity store (`@aggregator-dpg/api`). The Vitest
 * setup publishes a fresh in-memory store under this global key before each
 * unit test; `getIdentityStore()` uses it when no store was injected. Never
 * set in production.
 */
export const TEST_IDENTITY_STORE_KEY = '__aggregatorDpgTestIdentityStore';
