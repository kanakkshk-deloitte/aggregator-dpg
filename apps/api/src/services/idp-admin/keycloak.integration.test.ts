/**
 * Live integration tests for the Keycloak adapter. Skipped automatically
 * when no `KEYCLOAK_URL` env is set so unit-test runs stay hermetic.
 *
 * Run locally with the compose stack up:
 *   KEYCLOAK_URL=http://localhost:8080 \
 *   KEYCLOAK_REALM=aggregator \
 *   KEYCLOAK_ADMIN_CLIENT_ID=aggregator-api \
 *   KEYCLOAK_ADMIN_CLIENT_SECRET=aggregator-api-local-dev-secret \
 *   pnpm --filter @aggregator-dpg/api test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { KeycloakIdpAdmin } from './keycloak.js';

const baseUrl = process.env.KEYCLOAK_URL;
const realm = process.env.KEYCLOAK_REALM;
const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID;
const clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
const live = baseUrl && realm && clientId && clientSecret;

describe.skipIf(!live)('KeycloakIdpAdmin (integration)', () => {
  let admin: KeycloakIdpAdmin;
  const testEmail = `it-${Date.now()}@example.invalid`;
  const createdIds: string[] = [];

  beforeAll(() => {
    admin = new KeycloakIdpAdmin({
      baseUrl: baseUrl!,
      realm: realm!,
      clientId: clientId!,
      clientSecret: clientSecret!,
    });
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await admin.deleteUser(id).catch(() => undefined);
    }
  });

  it('round-trips create → find → enable → disable → delete', async () => {
    const created = await admin.createUser({
      email: testEmail,
      firstName: 'IT',
      lastName: 'Test',
      phone: '+919876543299',
      enabled: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdIds.push(created.value.id);
    expect(created.value.enabled).toBe(false);

    const found = await admin.findByEmail(testEmail);
    expect(found.ok).toBe(true);
    if (found.ok && found.value) {
      expect(found.value.id).toBe(created.value.id);
    }

    const enabled = await admin.enableUser(created.value.id);
    expect(enabled.ok).toBe(true);

    const disabled = await admin.disableUser(created.value.id);
    expect(disabled.ok).toBe(true);

    const deleted = await admin.deleteUser(created.value.id);
    expect(deleted.ok).toBe(true);
    createdIds.pop();
  });

  it('createUser returns USER_EXISTS for duplicate email', async () => {
    const a = await admin.createUser({ email: testEmail });
    expect(a.ok).toBe(true);
    if (a.ok) createdIds.push(a.value.id);

    const b = await admin.createUser({ email: testEmail });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe('USER_EXISTS');
  });
});
