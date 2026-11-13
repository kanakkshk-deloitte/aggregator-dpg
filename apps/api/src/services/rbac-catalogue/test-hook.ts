/**
 * Test-only hook for the RBAC catalogue store (`@aggregator-dpg/api`).
 *
 * `src/test-setup.ts` puts a fresh in-memory catalogue under this global key
 * before each unit test; `getRbacCatalogue()` uses it when no store was
 * injected. Never set in production.
 */
export const TEST_RBAC_CATALOGUE_KEY = '__aggregatorDpgTestRbacCatalogue';
