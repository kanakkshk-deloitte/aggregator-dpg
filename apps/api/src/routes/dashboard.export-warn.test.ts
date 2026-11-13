/**
 * Covers the `decrypt.unowned_ids_requested` warning on the decrypted-profile
 * export.
 *
 * Lives in its own file because asserting a log line needs the shared pino
 * options pointed at an in-memory sink, and that has to be a module mock —
 * the handler logs through `req.log`, a child bound when the request starts,
 * so patching `app.log` after `buildApp()` never sees it. Mirrors
 * `app.onboarding-enabled-warnings.test.ts`.
 *
 * Ownership on this route is enforced by Signals; the warning is the detection
 * signal this side owns, so what it must carry — counts — and what it must not
 * — item ids, on a PII decrypt path — are both pinned here.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type * as LoggerModule from '../logger.js';

const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));

// Point the shared pino options at an in-memory sink so request-scoped log
// lines can be read back. `stream` is a Fastify logger option rather than a
// pino one, hence the cast.
vi.mock('../logger.js', async () => {
  const actual = await vi.importActual<typeof LoggerModule>('../logger.js');
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    ...actual,
    loggerOptions: { ...actual.loggerOptions, level: 'warn', stream: sink } as never,
  };
});

const { buildApp } = await import('../app.js');
const { _setAccessTokenVerifier, _resetJwks } = await import('../services/auth/access-token.js');
const { _setSignalStackWriter } = await import('../services/signalstack.js');
const { _setNetworkConfig } = await import('../services/network-config.js');
const { buildBlueDotConfig } = await import('@aggregator-dpg/network-config/testing');
const { UserStoreFake, _setUserStore, buildCoordinator } =
  await import('../services/user-store/index.js');
const { IdpAdminFake, _setIdpAdmin } = await import('../services/idp-admin/index.js');
const { SignalStackWriterFake } = await import('@aggregator-dpg/signalstack-writer/testing');

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = 'org_aaa_signalstack';

/** Parses the captured sink lines into log records. */
function records(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines.join('').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Partial or non-JSON line — ignore.
    }
  }
  return out;
}

describe('POST /v1/dashboard/export/profiles unowned-id warning', () => {
  let app: FastifyInstance;
  let writer: InstanceType<typeof SignalStackWriterFake>;

  beforeEach(async () => {
    lines.length = 0;
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    _setNetworkConfig(buildBlueDotConfig());

    const idp = new IdpAdminFake();
    await idp.createUser({
      email: 'kc-1@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_A, decision_made: 'approved' },
    });
    _setIdpAdmin(idp);

    const userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: AGG_A,
        orgSlug: 'agg-a',
        name: 'Agg A',
        status: 'active',
        signalstackOrgId: ORG_A,
      }),
    ]);
    _setUserStore(userStore);

    writer = new SignalStackWriterFake();
    _setSignalStackWriter(writer);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-approved-with-org') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
          signalstack_org_id: ORG_A,
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setUserStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  async function seedOwnedProfile(name: string, phone: string): Promise<string> {
    const onboarded = await writer.onboard({
      actingOrgId: ORG_A,
      name,
      phoneNumber: phone,
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name, phone },
    });
    if (!onboarded.success) throw new Error('seed failed');
    return onboarded.value.profile_item_id;
  }

  async function exportProfiles(itemIds: string[]): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: itemIds, domain: 'seeker' },
    });
    return res.statusCode;
  }

  it('warns with counts, and carries no item ids', async () => {
    const ownedId = await seedOwnedProfile('Warn Case', '+919876801014');
    const secretId = 'another-aggregators-item';

    expect(await exportProfiles([ownedId, secretId])).toBe(200);

    const warning = records().find((r) => r.sub === 'decrypt.unowned_ids_requested');
    expect(warning).toBeDefined();
    expect(warning).toMatchObject({ level: 40, requested: 2, returned: 1, skipped: 1 });
    // Neither the probed id nor the owned one may appear anywhere in the record.
    const serialised = JSON.stringify(warning);
    expect(serialised).not.toContain(secretId);
    expect(serialised).not.toContain(ownedId);
  });

  it('does not warn when every requested id is owned', async () => {
    const ownedId = await seedOwnedProfile('No Warn', '+919876801015');

    expect(await exportProfiles([ownedId])).toBe(200);

    expect(records().find((r) => r.sub === 'decrypt.unowned_ids_requested')).toBeUndefined();
  });
});
