/**
 * Boot-time reconcile of the network-facilitator root and the Default org
 * (`@aggregator-dpg/api`).
 *
 * Migration 0028 seeds both with placeholder values (slug `network`, name
 * `Network`, owner `network-admin@nf.invalid`). On every boot this module
 * applies the configured values:
 *
 * - root `slug` ← `brand.url_slug`; `name` ← `aggregator.legal_name` →
 *   `aggregator.name`; `legal_name` ← `aggregator.legal_name`;
 * - root owner ← the first `ADMIN_EMAILS` entry;
 * - Default owner ← `DEFAULT_ORG_OWNER_EMAIL`, else the root's owner.
 *
 * A configured owner who is a coordinator, or a Default owner who already
 * owns another org, is refused: logged, and the current owner kept.
 *
 * Then, best-effort, it mirrors both orgs and their owners into the IdP (a
 * group per org, a user per owner) and gives owners sign-in access (enabled,
 * `org_owner` role, the org's group). A replaced owner leaves the group; once
 * it owns nothing it loses the role and sessions, and is disabled if this app
 * created it. Idempotent; logs counts only; never throws. Failures retry on
 * the next boot.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { linkContact, type DbExecutor } from '../db/contact-writes.js';
import {
  IdentityMismatchError,
  IdentityTakenError,
  linkAdminAccount,
  linkIdentity,
} from '../db/account-writes.js';
import { logger } from '../logger.js';
import { pgErrorCode } from '../db/pg-error.js';
import type { IdpAdminAdapter } from './idp-admin/interface.js';
import { IDP_PROVIDER } from './idp-admin/provider.js';
import { KC_ATTR, OWNER_CREATED_BY, OWNER_REALM_ROLE } from './idp-admin/index.js';
import { getIdentityStore } from './identity-store/index.js';
import { revokeRolesOnLeave } from './authz/roles.js';

/** The placeholder owner address 0028 seeds; never mirrored to the IdP. */
export const PLACEHOLDER_OWNER_EMAIL = 'network-admin@nf.invalid';

/** Configured values for the root and the Default org (absent = keep). */
export interface RootConfig {
  nfSlug: string | null;
  nfName: string | null;
  nfLegalName: string | null;
  /** First `ADMIN_EMAILS` entry, lowercased. */
  nfOwnerEmail: string | null;
  /** `DEFAULT_ORG_OWNER_EMAIL`, lowercased. */
  defaultOwnerEmail: string | null;
}

/** One org the IdP mirror covers. */
export interface RootOrgState {
  id: string;
  slug: string;
  name: string;
  kcGroupId: string | null;
  ownerUserId: string;
  /** The owner's email (contact), lowercased. */
  ownerEmail: string;
  /** The owner's recorded IdP subject, if any. */
  ownerSubject: string | null;
  /**
   * Whether the owner also has a coordinator account. If so, the IdP user
   * belongs to that login and is not linked to the admin account.
   */
  ownerIsCoordinator: boolean;
}

/** An owner replaced by the reconcile: removed from the org's group. */
export interface ReplacedOwner {
  orgId: string;
  subject: string;
  /**
   * The owner's account was released (it owns no org any more): its IdP user
   * also loses the owner role and its sessions.
   */
  released: boolean;
}

/** What the database reconcile found and changed. */
export interface RootState {
  root: RootOrgState;
  defaultOrg: RootOrgState;
  changed: { slug: boolean; name: boolean; rootOwner: boolean; defaultOwner: boolean };
  /** Owners replaced in this run that had a recorded IdP subject. */
  replacedOwners: ReplacedOwner[];
}

/**
 * Builds the root config from the network config and environment.
 *
 * @param network - The resolved aggregator block (`url_slug`, names).
 * @param adminEmails - Parsed `ADMIN_EMAILS`.
 * @param defaultOwnerEmail - `DEFAULT_ORG_OWNER_EMAIL`, or `null`.
 * @returns The config to reconcile against.
 */
export function rootConfigFrom(
  network: { urlSlug?: string | null; name?: string | null; legalName?: string | null } | null,
  adminEmails: readonly string[],
  defaultOwnerEmail: string | null,
): RootConfig {
  const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  const legal = clean(network?.legalName);
  return {
    nfSlug: clean(network?.urlSlug),
    nfName: legal ?? clean(network?.name),
    nfLegalName: legal,
    nfOwnerEmail: clean(adminEmails[0])?.toLowerCase() ?? null,
    defaultOwnerEmail: clean(defaultOwnerEmail)?.toLowerCase() ?? null,
  };
}

/**
 * The admin account for an owner email: reuses the person's existing contact
 * (whatever its phone), else creates a phone-less one.
 *
 * @param tx - The caller's transaction.
 * @param email - Lowercased owner email.
 * @returns The admin account's `users.id`.
 */
async function adminAccountFor(tx: DbExecutor, email: string): Promise<string> {
  const found = await tx.execute<{ id: string }>(
    sql`SELECT id FROM contact WHERE email = ${email}`,
  );
  const contactId =
    found.rows[0]?.id ?? (await linkContact(tx, { email, phone: null, name: null }));
  return linkAdminAccount(tx, contactId);
}

/**
 * Deletes an admin account that owns no org any more (the placeholder after
 * the configured owner took over); its contact is then collected by the
 * `users_contact_ad` trigger.
 *
 * @returns Whether the account was deleted.
 */
async function releaseIfUnowned(tx: DbExecutor, userId: string): Promise<boolean> {
  const gone = await tx.execute<{ id: string }>(sql`
    DELETE FROM users u
     WHERE u.id = ${userId} AND u.user_type = 'admin'
       AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.org_owner = ${userId})
    RETURNING u.id`);
  return gone.rows.length > 0;
}

/**
 * Why a configured owner address may not own the root / Default org, or null.
 *
 * - `owner_is_coordinator`: the address belongs to a coordinator.
 * - `owner_owns_other_org`: (Default only) the address already owns an org.
 */
async function ownerConflict(
  tx: DbExecutor,
  email: string,
  which: 'root' | 'default',
): Promise<'owner_is_coordinator' | 'owner_owns_other_org' | null> {
  const r = await tx.execute<{ coordinator: boolean; other_owner: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM users x JOIN contact c ON c.id = x.contact_id
                    WHERE c.email = ${email} AND x.user_type = 'coordinator') AS coordinator,
           EXISTS (SELECT 1 FROM organisations o
                     JOIN users u ON u.id = o.org_owner
                     JOIN contact c ON c.id = u.contact_id
                    WHERE c.email = ${email} AND o.org_type = 'aggregator'
                      AND o.slug <> 'default') AS other_owner`);
  const row = r.rows[0];
  if (row?.coordinator) return 'owner_is_coordinator';
  if (which === 'default' && row?.other_owner) return 'owner_owns_other_org';
  return null;
}

/** Logs a refused owner config (no address: the env var names it). */
function warnRefused(which: 'root' | 'default', reason: string): void {
  logger.warn(
    { operation: 'ensureRootOrganisation', status: 'skipped', org: which, reason },
    which === 'root'
      ? 'the first ADMIN_EMAILS address cannot own the network root — keeping the current owner'
      : 'DEFAULT_ORG_OWNER_EMAIL cannot own the Default org — keeping the current owner',
  );
}

/** Reads the root or the Default org with its owner. */
async function readOrg(tx: DbExecutor, where: 'root' | 'default'): Promise<RootOrgState | null> {
  const filter =
    where === 'root'
      ? sql`o.org_type = 'network_facilitator'`
      : sql`o.org_type = 'aggregator' AND o.slug = 'default'`;
  const rows = await tx.execute<{
    id: string;
    slug: string;
    name: string;
    kc_group_id: string | null;
    org_owner: string;
    email: string;
    subject: string | null;
    is_coordinator: boolean;
  }>(sql`
    SELECT o.id, o.slug, o.name, o.kc_group_id, o.org_owner, c.email, i.subject,
           EXISTS (SELECT 1 FROM users x
                    WHERE x.contact_id = u.contact_id AND x.user_type = 'coordinator') AS is_coordinator
      FROM organisations o
      JOIN users u ON u.id = o.org_owner
      JOIN contact c ON c.id = u.contact_id
      LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = ${IDP_PROVIDER}
     WHERE ${filter}
     LIMIT 1`);
  const r = rows.rows[0];
  return r
    ? {
        id: r.id,
        slug: r.slug,
        name: r.name,
        kcGroupId: r.kc_group_id,
        ownerUserId: r.org_owner,
        ownerEmail: r.email,
        ownerSubject: r.subject,
        ownerIsCoordinator: Boolean(r.is_coordinator),
      }
    : null;
}

/** What {@link reconcileRootOrganisations} changed. */
type Changed = RootState['changed'];

/**
 * Applies the configured slug (only when no live org holds it), name and
 * legal name to the root.
 */
async function applyRootConfig(
  tx: DbExecutor,
  cfg: RootConfig,
  root: RootOrgState,
  changed: Changed,
): Promise<void> {
  if (cfg.nfSlug && cfg.nfSlug !== root.slug) {
    const taken = await tx.execute(sql`
      SELECT 1 FROM organisations
       WHERE slug = ${cfg.nfSlug} AND id <> ${root.id} AND status IN ('pending','active')`);
    if (taken.rows.length === 0) {
      await tx.execute(sql`UPDATE organisations SET slug = ${cfg.nfSlug} WHERE id = ${root.id}`);
      changed.slug = true;
    } else {
      logger.warn(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'slug_taken' },
        'configured network slug is held by another org — keeping the current one',
      );
    }
  }
  if (cfg.nfName && cfg.nfName !== root.name) {
    await tx.execute(sql`UPDATE organisations SET name = ${cfg.nfName} WHERE id = ${root.id}`);
    changed.name = true;
  }
  if (cfg.nfLegalName) {
    await tx.execute(sql`
      UPDATE organisations SET legal_name = ${cfg.nfLegalName}
       WHERE id = ${root.id} AND legal_name IS DISTINCT FROM ${cfg.nfLegalName}`);
  }
}

/**
 * Hands the root and the Default org to their configured owners, releasing
 * an owner account left with no org.
 *
 * @returns Replaced owners that had an IdP subject, read before their accounts
 *   are released.
 */
async function applyOwners( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  tx: DbExecutor,
  cfg: RootConfig,
  root: RootOrgState,
  dflt: RootOrgState,
  changed: Changed,
): Promise<ReplacedOwner[]> {
  let rootOwner = root.ownerUserId;
  if (cfg.nfOwnerEmail && cfg.nfOwnerEmail !== root.ownerEmail) {
    const refused = await ownerConflict(tx, cfg.nfOwnerEmail, 'root');
    if (refused) {
      warnRefused('root', refused);
    } else {
      rootOwner = await adminAccountFor(tx, cfg.nfOwnerEmail);
      if (rootOwner !== root.ownerUserId) {
        await tx.execute(
          sql`UPDATE organisations SET org_owner = ${rootOwner} WHERE id = ${root.id}`,
        );
        changed.rootOwner = true;
      }
    }
  }
  let defaultOwner = rootOwner;
  if (cfg.defaultOwnerEmail && cfg.defaultOwnerEmail !== dflt.ownerEmail) {
    const refused = await ownerConflict(tx, cfg.defaultOwnerEmail, 'default');
    if (refused) {
      warnRefused('default', refused);
      defaultOwner = dflt.ownerUserId;
    } else {
      defaultOwner = await adminAccountFor(tx, cfg.defaultOwnerEmail);
    }
  } else if (cfg.defaultOwnerEmail) {
    defaultOwner = dflt.ownerUserId;
  }
  if (defaultOwner !== dflt.ownerUserId) {
    await tx.execute(
      sql`UPDATE organisations SET org_owner = ${defaultOwner} WHERE id = ${dflt.id}`,
    );
    changed.defaultOwner = true;
  }
  const released = new Set<string>();
  if (changed.rootOwner && (await releaseIfUnowned(tx, root.ownerUserId))) {
    released.add(root.ownerUserId);
  }
  if (changed.defaultOwner && (await releaseIfUnowned(tx, dflt.ownerUserId))) {
    released.add(dflt.ownerUserId);
  }
  const replaced = (org: RootOrgState, didChange: boolean): ReplacedOwner[] =>
    didChange && org.ownerSubject
      ? [{ orgId: org.id, subject: org.ownerSubject, released: released.has(org.ownerUserId) }]
      : [];
  return [...replaced(root, changed.rootOwner), ...replaced(dflt, changed.defaultOwner)];
}

/**
 * Reconciles the root and the Default org with config in one transaction.
 *
 * @param cfg - The configured values.
 * @param db - Executor (defaults to the pool).
 * @returns The resulting state, or `null` when the database predates 0028.
 */
export async function reconcileRootOrganisations(
  cfg: RootConfig,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<RootState | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:ensure-root'))`);
    const reg = await tx.execute<{ t: string | null }>(
      sql`SELECT to_regclass('public.organisations')::text AS t`,
    );
    if (!reg.rows[0]?.t) return null;
    const root = await readOrg(tx, 'root');
    const dflt = await readOrg(tx, 'default');
    if (!root || !dflt) return null;
    const changed = { slug: false, name: false, rootOwner: false, defaultOwner: false };
    await applyRootConfig(tx, cfg, root, changed);
    const replacedOwners = await applyOwners(tx, cfg, root, dflt, changed);

    const nextRoot = await readOrg(tx, 'root');
    const nextDefault = await readOrg(tx, 'default');
    if (!nextRoot || !nextDefault) return null;
    return { root: nextRoot, defaultOrg: nextDefault, changed, replacedOwners };
  });
}

/** Writes the IdP mirror results back to the database. */
export interface RootIdpRecorder {
  setGroupId(orgId: string, groupId: string): Promise<void>;
  /** Records the owner's IdP subject; resolves `false` when it conflicts. */
  linkSubject(userId: string, subject: string): Promise<boolean>;
}

/** Counts of what the IdP mirror did. */
export interface RootIdpReport {
  groupsCreated: number;
  /** Groups found by name from an earlier attempt and adopted. */
  groupsAdopted: number;
  usersCreated: number;
  usersReused: number;
  /** Replaced owners removed from their org's group. */
  ownersRemoved: number;
  /** Configured owners given sign-in access (enabled, role, group). */
  ownersGranted: number;
  /** Released owners whose role and sessions were revoked. */
  ownersRevoked: number;
  failures: number;
}

/**
 * Creates the org's group, or adopts an existing one on a 409 when its
 * `org_id` attribute names this org.
 *
 * The name is `org-<slug>-<first 8 of the org id>`, because these slugs are
 * the same on every instance sharing a realm.
 *
 * @returns The group id, or `null` (counted as a failure, retried next boot).
 */
async function ensureGroup(
  idp: IdpAdminAdapter,
  org: RootOrgState,
  report: RootIdpReport,
  fail: (step: string, code: string) => void,
): Promise<string | null> {
  const name = `org-${org.slug}-${org.id.slice(0, 8)}`;
  const created = await idp.createGroup(name, { org_id: org.id, display_name: org.name });
  if (created.ok) {
    report.groupsCreated += 1;
    return created.value.id;
  }
  if (created.error.code !== 'BAD_REQUEST') {
    fail('createGroup', created.error.code);
    return null;
  }
  const found = await idp.findGroupByName(name);
  if (!found.ok) {
    fail('findGroupByName', found.error.code);
    return null;
  }
  if (found.value && (found.value.attributes['org_id'] ?? []).includes(org.id)) {
    report.groupsAdopted += 1;
    return found.value.id;
  }
  // The name belongs to another org: never take it over.
  fail('createGroup', 'group_name_taken');
  return null;
}

/** What every step of the IdP mirror shares. */
interface MirrorContext {
  idp: IdpAdminAdapter;
  recorder: RootIdpRecorder;
  report: RootIdpReport;
  fail: (step: string, code: string) => void;
}

/** Mirrors one org: its group, its replaced owners leaving it, and its owner. */
async function mirrorOrg(
  ctx: MirrorContext,
  org: RootOrgState,
  replacedOwners: readonly ReplacedOwner[],
): Promise<string | null> {
  let groupId = org.kcGroupId;
  if (!groupId) {
    groupId = await ensureGroup(ctx.idp, org, ctx.report, ctx.fail);
    if (groupId) await ctx.recorder.setGroupId(org.id, groupId);
  }
  if (groupId)
    await removeReplacedOwners(
      ctx,
      groupId,
      replacedOwners.filter((r) => r.orgId === org.id),
    );

  const subject = await ownerSubject(ctx, org);
  if (!subject) return null;
  // Grant sign-in access; each step soft-fails and retries next boot.
  const [enabled, role, added] = await Promise.all([
    ctx.idp.enableUser(subject),
    ctx.idp.assignRealmRole(subject, OWNER_REALM_ROLE),
    groupId ? ctx.idp.addUserToGroup(subject, groupId) : Promise.resolve(null),
  ]);
  if (!enabled.ok) ctx.fail('enableUser', enabled.error.code);
  if (!role.ok) ctx.fail('assignRealmRole', role.error.code);
  if (added && !added.ok) ctx.fail('addUserToGroup', added.error.code);
  if (enabled.ok && role.ok && (added === null || added.ok)) ctx.report.ownersGranted += 1;
  return subject;
}

/** Roles every realm user holds; they do not mean another app uses the login. */
function isDefaultRealmRole(role: string): boolean {
  return (
    role.startsWith('default-roles-') || role === 'offline_access' || role === 'uma_authorization'
  );
}

/**
 * Ends a released owner's access: removes the owner role and every session.
 * Disables the user only if this app created it.
 */
async function revokeReleasedOwner(ctx: MirrorContext, subject: string): Promise<void> {
  const [role, logout, found] = await Promise.all([
    ctx.idp.removeRealmRole(subject, OWNER_REALM_ROLE),
    ctx.idp.logoutSessions(subject),
    ctx.idp.findById(subject),
  ]);
  if (!role.ok) ctx.fail('removeRealmRole', role.error.code);
  if (!logout.ok) ctx.fail('logoutSessions', logout.error.code);
  if (!found.ok) {
    ctx.fail('findById', found.error.code);
    return;
  }
  const ours = (found.value?.attributes?.[KC_ATTR.CREATED_BY] ?? []).includes(OWNER_CREATED_BY);
  if (ours) {
    // Skip users with other realm roles; another app relies on them.
    const roles = await ctx.idp.listRealmRoles(subject);
    if (!roles.ok) {
      ctx.fail('listRealmRoles', roles.error.code);
    } else if (roles.value.every(isDefaultRealmRole)) {
      const disabled = await ctx.idp.disableUser(subject);
      if (!disabled.ok) ctx.fail('disableUser', disabled.error.code);
    }
  }
  if (role.ok && logout.ok) ctx.report.ownersRevoked += 1;
}

/**
 * Takes owners replaced by the reconcile out of the org's group. Their IdP
 * user is never deleted: it may be a person with other roles.
 */
async function removeReplacedOwners(
  ctx: MirrorContext,
  groupId: string,
  gone: readonly ReplacedOwner[],
): Promise<void> {
  const results = await Promise.all(
    gone.map((g) => ctx.idp.removeUserFromGroup(g.subject, groupId)),
  );
  for (const removed of results) {
    if (removed.ok) ctx.report.ownersRemoved += 1;
    else ctx.fail('removeUserFromGroup', removed.error.code);
  }
  // RBAC: a replaced owner's additional roles in the org end with ownership.
  for (const g of gone) {
    const user = await getIdentityStore().userOf(IDP_PROVIDER, g.subject);
    if (user.ok && user.value) await revokeRolesOnLeave(user.value, g.orgId, 'owner_replaced');
  }
}

/**
 * The org owner's IdP subject: the recorded one, else the existing user for
 * the owner's email, else a new disabled user, linked to the owner's admin
 * account. `null` for the placeholder owner, an owner who is a coordinator,
 * or on failure.
 */
async function ownerSubject(ctx: MirrorContext, org: RootOrgState): Promise<string | null> {
  if (org.ownerEmail === PLACEHOLDER_OWNER_EMAIL) return null;
  if (org.ownerSubject) return org.ownerSubject;
  // If the owner is also a coordinator, do not link that IdP user to the admin account.
  if (org.ownerIsCoordinator) {
    logger.warn(
      {
        operation: 'ensureRootOrganisation.idp',
        status: 'skipped',
        reason: 'owner_is_coordinator',
      },
      'the configured owner also holds a coordinator account — no admin IdP user is linked',
    );
    return null;
  }
  const subject = await findOrCreateOwner(ctx, org.ownerEmail);
  if (!subject) return null;
  if (!(await ctx.recorder.linkSubject(org.ownerUserId, subject))) {
    ctx.fail('linkSubject', 'identity_conflict');
    return null;
  }
  return subject;
}

/** The existing IdP user for `email`, else a new disabled one; `null` on failure. */
async function findOrCreateOwner(ctx: MirrorContext, email: string): Promise<string | null> {
  const existing = await ctx.idp.findByEmail(email);
  if (!existing.ok) {
    ctx.fail('findByEmail', existing.error.code);
    return null;
  }
  if (existing.value) {
    ctx.report.usersReused += 1;
    return existing.value.id;
  }
  const created = await ctx.idp.createUser({
    email,
    username: email,
    enabled: false,
    attributes: {
      [KC_ATTR.DECISION_MADE]: 'pending',
      [KC_ATTR.CREATED_BY]: OWNER_CREATED_BY,
    },
  });
  if (!created.ok) {
    ctx.fail('createUser', created.error.code);
    return null;
  }
  ctx.report.usersCreated += 1;
  return created.value.id;
}

/**
 * Mirrors the root and the Default org into the IdP: a group per org and a
 * user per configured owner (existing or new). Owners get sign-in access;
 * replaced owners leave the group; released owners lose the role and
 * sessions. Never throws.
 *
 * @param idp - The IdP admin adapter.
 * @param state - The reconciled orgs.
 * @param recorder - Persists group ids and subjects.
 * @returns Counts for the boot log.
 */
export async function provisionRootIdp(
  idp: IdpAdminAdapter,
  state: Pick<RootState, 'root' | 'defaultOrg'> & Partial<Pick<RootState, 'replacedOwners'>>,
  recorder: RootIdpRecorder,
): Promise<RootIdpReport> {
  const report: RootIdpReport = {
    groupsCreated: 0,
    groupsAdopted: 0,
    usersCreated: 0,
    usersReused: 0,
    ownersRemoved: 0,
    ownersGranted: 0,
    ownersRevoked: 0,
    failures: 0,
  };
  const fail = (step: string, code: string) => {
    report.failures += 1;
    logger.warn(
      { operation: 'ensureRootOrganisation.idp', status: 'failure', step, error: code },
      'IdP mirror step failed — retried on the next boot',
    );
  };

  const ctx: MirrorContext = { idp, recorder, report, fail };
  const replaced = state.replacedOwners ?? [];
  // Never revoke a login that a current owner resolved to.
  const current = new Set([
    state.root.ownerSubject,
    state.defaultOrg.ownerSubject,
    await mirrorOrg(ctx, state.root, replaced),
    await mirrorOrg(ctx, state.defaultOrg, replaced),
  ]);
  const revoke = new Set(
    replaced.filter((r) => r.released && !current.has(r.subject)).map((r) => r.subject),
  );
  for (const subject of revoke) await revokeReleasedOwner(ctx, subject); // NOSONAR typescript:S9382 — sequential by design
  return report;
}

/** Database-backed {@link RootIdpRecorder}. */
export const dbRootIdpRecorder: RootIdpRecorder = {
  async setGroupId(orgId, groupId) {
    await getDb().execute(
      sql`UPDATE organisations SET kc_group_id = ${groupId} WHERE id = ${orgId} AND kc_group_id IS NULL`,
    );
  },
  async linkSubject(userId, subject) {
    try {
      await getDb().transaction((tx) => linkIdentity(tx, userId, IDP_PROVIDER, subject, 'admin'));
      return true;
    } catch (e) {
      if (e instanceof IdentityTakenError || e instanceof IdentityMismatchError) return false;
      throw e;
    }
  },
};

/**
 * Runs the database reconcile at boot (awaited before the server listens).
 * Never throws: a failure is logged and the next boot retries.
 *
 * @param cfg - The configured values.
 * @returns The reconciled state for {@link mirrorRootOrganisations}, or `null`.
 */
export async function ensureRootOrganisation(cfg: RootConfig): Promise<RootState | null> {
  const start = Date.now();
  try {
    const state = await reconcileRootOrganisations(cfg);
    if (!state) {
      logger.info(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_root' },
        'no network root (database predates migration 0028)',
      );
      return null;
    }
    if (!cfg.nfOwnerEmail) {
      logger.warn(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_admin_email' },
        'ADMIN_EMAILS is empty — the network root keeps its placeholder owner',
      );
    }
    logger.info({
      operation: 'ensureRootOrganisation',
      status: 'success',
      latency_ms: Date.now() - start,
      ...state.changed,
      replaced_owners: state.replacedOwners.length,
    });
    return state;
  } catch (err) {
    logger.error({
      operation: 'ensureRootOrganisation',
      status: 'failure',
      // Never log the driver message; it includes query parameters (emails).
      error: pgErrorCode(err) ? `database error ${pgErrorCode(err)}` : 'reconcile failed',
      error_type: (err as Error | undefined)?.constructor?.name ?? 'unknown',
      latency_ms: Date.now() - start,
    });
    return null;
  }
}

/**
 * Mirrors the reconciled orgs into the IdP. Runs after the server listens,
 * so a slow IdP does not delay readiness. Never throws.
 *
 * @param state - The state {@link ensureRootOrganisation} returned.
 * @param idp - The IdP admin adapter.
 */
export async function mirrorRootOrganisations(
  state: RootState,
  idp: IdpAdminAdapter,
): Promise<void> {
  const start = Date.now();
  try {
    const report = await provisionRootIdp(idp, state, dbRootIdpRecorder);
    logger.info({
      operation: 'ensureRootOrganisation.idp',
      status: report.failures > 0 ? 'failure' : 'success',
      latency_ms: Date.now() - start,
      ...report,
    });
  } catch (err) {
    logger.error({
      operation: 'ensureRootOrganisation.idp',
      status: 'failure',
      error: pgErrorCode(err) ? `database error ${pgErrorCode(err)}` : 'mirror failed',
      error_type: (err as Error | undefined)?.constructor?.name ?? 'unknown',
      latency_ms: Date.now() - start,
    });
  }
}
