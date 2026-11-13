/**
 * Unit tests for the coordinator-invite batch minter (#700).
 *
 * Covers every per-recipient outcome — invalid address, duplicate-in-batch, an
 * address that already has an account (own-org coordinator, another org's
 * coordinator, an org owner, the root / Default owner), the fresh-invite and
 * refresh paths, store failures, the DUPLICATE_PENDING create→find→refresh
 * race, and a failed delivery still counting as sent — using the in-memory
 * stores and the fake mailer (fakes over mocks, per testing.md).
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { FakeMailer } from '@aggregator-dpg/mailer';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../organisation-store/index.js';
import {
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
} from '../registration-invites-store/index.js';
import { _resetInviteTokenKey } from '../invite-token.js';
import { _resetTokenKey } from '../approval-token.js';
import { mintInviteBatch, type MintBatchDeps, type InviteRecipient } from './mint.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';

describe('mintInviteBatch', () => {
  let invites: RegistrationInvitesStoreFake;
  let mailer: FakeMailer;
  let coordStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;

  beforeEach(() => {
    _resetInviteTokenKey();
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    invites = new RegistrationInvitesStoreFake();
    mailer = new FakeMailer();
    coordStore = new UserStoreFake();
    orgStore = new OrganisationStoreFake();
    _setUserStore(coordStore);
    _setOrganisationStore(orgStore);
  });

  afterEach(() => {
    _setUserStore(null);
    _setOrganisationStore(null);
  });

  const run = (recipients: InviteRecipient[], over: Partial<MintBatchDeps> = {}) =>
    mintInviteBatch({
      invites,
      mailer,
      orgId: ORG_ID,
      orgName: 'Enable India',
      inviterEmail: 'owner@enable.org',
      recipients,
      ttlSec: 14 * 24 * 3600,
      createdBy: `grant:${ORG_ID}`,
      log,
      ...over,
    });

  it('mints and mails a fresh invite (sent), de-dupes within the batch', async () => {
    const s = await run([{ email: 'New@X.org', name: 'Nina' }, { email: 'new@x.org' }]);
    expect(s.sent).toBe(1);
    expect(s.resent).toBe(0);
    expect(s.invalid).toEqual([{ email: 'new@x.org', reason: 'duplicate_in_batch' }]);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('flags an invalid address', async () => {
    const s = await run([{ email: 'not-an-email' }]);
    expect(s.invalid).toEqual([{ email: 'not-an-email', reason: 'invalid_email' }]);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('refreshes an existing pending invite (resent)', async () => {
    invites.seed([buildRegistrationInvite({ jti: 'j1', parentOrgId: ORG_ID, email: 'a@x.org' })]);
    const s = await run([{ email: 'a@x.org' }]);
    expect(s.resent).toBe(1);
    expect(s.sent).toBe(0);
  });

  it('still counts a failed delivery as sent', async () => {
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const s = await run([{ email: 'drop@x.org' }]);
    expect(s.sent).toBe(1);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('reports own-org coordinators under existing, mails nothing', async () => {
    coordStore.seed([
      buildCoordinator({
        id: 'c1',
        contact: { name: 'Asha', email: 'member@x.org', phone: '+919000000001' },
        parentOrgId: ORG_ID,
        status: 'active',
      }),
    ]);
    const s = await run([{ email: 'Member@x.org' }]);
    expect(s.existing).toEqual([{ email: 'Member@x.org', status: 'active' }]);
    expect(s.sent + s.resent).toBe(0);
    expect(mailer.outbox).toHaveLength(0);
  });

  it("another org's coordinator gets the you-already-have-an-account mail (sent)", async () => {
    coordStore.seed([
      buildCoordinator({
        id: 'c2',
        contact: { name: 'Bo', email: 'other@x.org', phone: '+919000000002' },
        parentOrgId: 'some-other-org',
        status: 'active',
      }),
    ]);
    const s = await run([{ email: 'other@x.org' }]);
    expect(s.sent).toBe(1);
    expect(s.existing).toHaveLength(0);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('an existing org owner is treated as another account (sent)', async () => {
    orgStore.seed([buildOrganisation({ id: 'o1', slug: 'o1', ownerEmail: 'owner2@x.org' })]);
    const s = await run([{ email: 'owner2@x.org' }]);
    expect(s.sent).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('the root owner is treated as another account', async () => {
    orgStore.seedRoot(
      buildOrganisation({ id: 'root', slug: 'network', ownerEmail: 'admin@x.org' }),
    );
    const s = await run([{ email: 'admin@x.org' }]);
    expect(s.sent).toBe(1);
  });

  it('the Default org owner is treated as another account', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'def',
        slug: 'default',
        ownerEmail: 'defowner@x.org',
        isDefault: true,
        status: 'active',
      }),
    ]);
    const s = await run([{ email: 'defowner@x.org' }]);
    expect(s.sent).toBe(1);
  });

  it('refreshes (resent) for an existing-account address with a pending invite', async () => {
    orgStore.seed([buildOrganisation({ id: 'o2', slug: 'o2', ownerEmail: 'own@x.org' })]);
    invites.seed([buildRegistrationInvite({ jti: 'j2', parentOrgId: ORG_ID, email: 'own@x.org' })]);
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const s = await run([{ email: 'own@x.org' }]);
    expect(s.resent).toBe(1);
  });

  describe('store failures', () => {
    it('store_error when the coordinator lookup fails', async () => {
      coordStore.findByContactEmail = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const s = await run([{ email: 'x@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'x@x.org', reason: 'store_error' }]);
    });

    it('store_error when the org-owner lookups fail', async () => {
      orgStore.findByOwnerEmail = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const s = await run([{ email: 'x@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'x@x.org', reason: 'store_error' }]);
    });

    it('store_error when creating the invite row fails (none path)', async () => {
      invites.create = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const s = await run([{ email: 'x@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'x@x.org', reason: 'store_error' }]);
    });

    it('store_error when the refresh of an existing pending invite fails', async () => {
      invites.seed([buildRegistrationInvite({ jti: 'j3', parentOrgId: ORG_ID, email: 'r@x.org' })]);
      invites.refresh = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const s = await run([{ email: 'r@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'r@x.org', reason: 'store_error' }]);
    });

    it('store_error on the existing-account path when the invite row cannot be kept', async () => {
      orgStore.seed([buildOrganisation({ id: 'o3', slug: 'o3', ownerEmail: 'own3@x.org' })]);
      invites.create = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const s = await run([{ email: 'own3@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'own3@x.org', reason: 'store_error' }]);
    });
  });

  describe('DUPLICATE_PENDING create→find→refresh race', () => {
    it('refreshes the row the racing insert created (resent)', async () => {
      let finds = 0;
      invites.findPendingByOrgAndEmail = async () => {
        finds += 1;
        return finds === 1
          ? { ok: true, value: null }
          : { ok: true, value: buildRegistrationInvite({ jti: 'j-race' }) };
      };
      invites.create = async () => ({
        ok: false,
        error: { code: 'DUPLICATE_PENDING', message: 'race' },
      });
      invites.refresh = async (jti) => ({ ok: true, value: buildRegistrationInvite({ jti }) });
      const s = await run([{ email: 'race@x.org' }]);
      expect(s.resent).toBe(1);
    });

    it('store_error when the second lookup finds nothing after the race', async () => {
      invites.findPendingByOrgAndEmail = async () => ({ ok: true, value: null });
      invites.create = async () => ({
        ok: false,
        error: { code: 'DUPLICATE_PENDING', message: 'race' },
      });
      const s = await run([{ email: 'race2@x.org' }]);
      expect(s.invalid).toEqual([{ email: 'race2@x.org', reason: 'store_error' }]);
    });
  });
});
