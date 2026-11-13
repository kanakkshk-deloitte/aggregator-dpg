/**
 * Vitest setup for `@aggregator-dpg/api` unit tests.
 *
 * Publishes fresh in-memory identity, role-assignment and RBAC catalogue stores, and
 * the RBAC edge test hooks (no real OPA push or token-roles sync), before every test, so no unit
 * test reaches Postgres through the login-recording paths (review link, first
 * approved request). `getIdentityStore()` returns it while no store was
 * injected explicitly (`_setIdentityStore(...)` still wins).
 *
 * Imports ONLY the dependency-free in-memory store: importing anything that
 * loads the API config here would freeze it before a test file sets the env
 * vars it reads at import time, and would interfere with tests that reset
 * modules.
 */
import { beforeEach } from 'vitest';
import { InMemoryIdentityStore } from './services/identity-store/memory.js';
import { TEST_IDENTITY_STORE_KEY } from './services/identity-store/test-hook.js';
import { InMemoryRoleStore } from './services/role-store/memory.js';
import { TEST_ROLE_STORE_KEY } from './services/role-store/test-hook.js';
import { InMemoryRbacCatalogue } from './services/rbac-catalogue/memory.js';
import { TEST_RBAC_CATALOGUE_KEY } from './services/rbac-catalogue/test-hook.js';
import {
  TEST_EDGE_FETCH_KEY,
  TEST_TOKEN_ROLES_OFF_KEY,
  edgeFetchRecorder,
} from './services/authz/edge-test-hook.js';

beforeEach(() => {
  (globalThis as Record<string, unknown>)[TEST_IDENTITY_STORE_KEY] = new InMemoryIdentityStore();
  (globalThis as Record<string, unknown>)[TEST_ROLE_STORE_KEY] = new InMemoryRoleStore();
  (globalThis as Record<string, unknown>)[TEST_RBAC_CATALOGUE_KEY] = new InMemoryRbacCatalogue();
  // RBAC edge: no real OPA push and no real token-roles sync in unit tests.
  (globalThis as Record<string, unknown>)[TEST_EDGE_FETCH_KEY] = edgeFetchRecorder();
  (globalThis as Record<string, unknown>)[TEST_TOKEN_ROLES_OFF_KEY] = true;
});
