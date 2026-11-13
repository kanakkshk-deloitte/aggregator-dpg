/**
 * Test-only hook for the role-assignment store (`@aggregator-dpg/api`).
 *
 * `src/test-setup.ts` puts a fresh in-memory store under this global key
 * before each unit test; `getRoleStore()` uses it when no store was injected.
 * Never set in production.
 */
export const TEST_ROLE_STORE_KEY = '__aggregatorDpgTestRoleStore';
