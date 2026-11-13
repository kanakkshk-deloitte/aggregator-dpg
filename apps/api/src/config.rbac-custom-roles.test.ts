/**
 * Unit test for the RBAC_CUSTOM_ROLES_ENABLED deploy-time flag default.
 *
 * `config.ts` snapshots the environment at module load; the test suite does not
 * set this var (see vitest.config.ts), so the parsed value must be the schema
 * default — `false` (the capability is opt-in).
 */
import { describe, it, expect } from 'vitest';
import { config } from './config.js';

describe('RBAC_CUSTOM_ROLES_ENABLED', () => {
  it('defaults to false (CUSTOM-ROLES is opt-in)', () => {
    expect(config.RBAC_CUSTOM_ROLES_ENABLED).toBe(false);
  });
});
