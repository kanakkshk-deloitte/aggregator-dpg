/**
 * The online steps of the instance-upgrade tool (`@aggregator-dpg/api`).
 *
 * `enrich` runs after the database commit and before scale-up. `enable-owners`
 * is a one-off step that lets existing org owners sign in. Both call Keycloak
 * through the API's adapter, so they need the API's full environment.
 * `instance-upgrade.ts` loads this module lazily so `check` and `run` do not
 * depend on it. Output carries counts and ids only.
 */

import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { logger } from '../logger.js';
import { getOrganisationStore, type Organisation } from '../services/organisation-store/index.js';
import { grantOwnerAccess } from '../services/decisions/org.js';
import { PLACEHOLDER_OWNER_EMAIL } from '../services/organisation-root.js';
import { getDb } from '../db/client.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpAdminAdapter } from '../services/idp-admin/interface.js';
import { IDP_PROVIDER } from '../services/idp-admin/provider.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import type { IdentityStoreBase } from '../services/identity-store/interface.js';
import {
  backfillOwnerContactNames,
  listOwnerNameCandidatesFromDb,
  setContactNameIfMissingInDb,
} from '../services/owner-name-backfill.js';

type Out = (line: string) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Counts of the identity step of `enrich`. */
export interface EnrichReport {
  candidates: number;
  linked: number;
  already: number;
  notInKeycloak: number;
  conflicts: number;
  failed: number;
  /** Coordinator ids with no Keycloak user. */
  absentIds: string[];
  /** Coordinator ids whose login is already recorded differently, or belongs to another account. */
  conflictIds: string[];
}

/** What the identity step of `enrich` needs (fakes in tests). */
export interface EnrichDeps {
  idp: IdpAdminAdapter;
  identities: IdentityStoreBase;
  /** Coordinator ids that have no recorded Keycloak login yet. */
  listCandidates: () => Promise<string[]>;
  /** Pause between Keycloak calls. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * Records the Keycloak login of every coordinator that has none yet, paced.
 *
 * Idempotent; a re-run picks up only what is still missing.
 *
 * @param deps - Keycloak, the identity store, the candidate list.
 * @param opts - `dryRun` reads only; `ratePerSecond` (> 0) paces Keycloak calls.
 * @returns Per-outcome counts.
 * @throws {RangeError} When `ratePerSecond` is not a positive number.
 */
export async function enrichIdentities(
  deps: EnrichDeps,
  opts: { dryRun: boolean; ratePerSecond: number },
): Promise<EnrichReport> {
  if (!Number.isFinite(opts.ratePerSecond) || opts.ratePerSecond <= 0) {
    throw new RangeError('--rate must be a positive number of calls per second');
  }
  const ids = await deps.listCandidates();
  const report: EnrichReport = {
    candidates: ids.length,
    linked: 0,
    already: 0,
    notInKeycloak: 0,
    conflicts: 0,
    failed: 0,
    absentIds: [],
    conflictIds: [],
  };
  const pause = deps.pause ?? sleep;
  const gapMs = Math.ceil(1000 / opts.ratePerSecond);
  for (const id of ids) {
    // Sequential: paced against Keycloak.
    const found = await deps.idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, id); // NOSONAR typescript:S9382
    if (!found.ok) report.failed += 1;
    else if (!found.value) {
      report.notInKeycloak += 1;
      report.absentIds.push(id);
    } else if (!opts.dryRun) {
      const linked = await deps.identities.link(id, IDP_PROVIDER, found.value.id, 'coordinator'); // NOSONAR typescript:S9382
      if (!linked.ok) {
        report.conflicts += 1;
        report.conflictIds.push(id);
      } else if (linked.value === 'linked') report.linked += 1;
      else report.already += 1;
    }
    await pause(gapMs); // NOSONAR typescript:S9382
  }
  return report;
}

/** Coordinator ids without a recorded Keycloak login, oldest first. */
async function coordinatorsWithoutLogin(): Promise<string[]> {
  const rows = await getDb().execute<{ id: string }>(sql`
    SELECT u.id::text AS id FROM users u
     WHERE u.user_type = 'coordinator'
       AND NOT EXISTS (SELECT 1 FROM user_identities i
                        WHERE i.user_id = u.id AND i.provider = ${IDP_PROVIDER})
     ORDER BY u.created_at`);
  return rows.rows.map((r) => r.id);
}

/**
 * Runs `enrich`: records Keycloak logins, then backfills owner names.
 *
 * @param opts - `dryRun` reads only; `ratePerSecond` paces Keycloak calls.
 * @param out - Line printer.
 * @returns Exit code: 1 when any lookup failed or a login conflicts, else 0.
 */
export async function enrich(
  opts: { dryRun: boolean; ratePerSecond: number },
  out: Out,
): Promise<number> {
  const idp = getIdpAdmin();
  const report = await enrichIdentities(
    { idp, identities: getIdentityStore(), listCandidates: coordinatorsWithoutLogin },
    opts,
  );
  const { absentIds, conflictIds, ...counts } = report;
  out(`enrich identities ${JSON.stringify(counts)}${opts.dryRun ? ' (dry run)' : ''}`);
  for (const id of absentIds) out(`  not in keycloak: coordinator ${id}`);
  for (const id of conflictIds) out(`  login conflict: coordinator ${id}`);
  const names = await backfillOwnerContactNames(
    {
      idp,
      listCandidates: listOwnerNameCandidatesFromDb,
      setNameIfMissing: setContactNameIfMissingInDb,
    },
    { dryRun: opts.dryRun },
  );
  out(`enrich owner_names ${JSON.stringify(names)}`);
  return enrichExitCode(report, names);
}

/**
 * Exit code for `enrich`: 0 only when every lookup answered and no login conflicts.
 *
 * Coordinators absent from Keycloak do not fail it.
 *
 * @param identities - The identity step's counts.
 * @param names - The owner-name step's counts.
 * @returns 0 or 1.
 */
export function enrichExitCode(
  identities: Pick<EnrichReport, 'failed' | 'conflicts'>,
  names: { failed: number },
): 0 | 1 {
  return identities.failed > 0 || identities.conflicts > 0 || names.failed > 0 ? 1 : 0;
}

/** Counts of `enable-owners`; ids name the orgs to follow up. */
export interface EnableOwnersReport {
  /** Active aggregator orgs considered (Default and placeholders excluded). */
  orgs: number;
  /** Owners given (or confirmed) sign-in access. */
  granted: number;
  /** Owners with no recorded Keycloak login (`user_identities`). */
  noLogin: number;
  /** Owners whose recorded Keycloak user no longer exists. */
  missingUser: number;
  /** Keycloak errors (lookup, enable, role or group). */
  failed: number;
  noLoginIds: string[];
  missingIds: string[];
  failedIds: string[];
}

/** What `enable-owners` needs (fakes in tests). */
export interface EnableOwnersDeps {
  idp: IdpAdminAdapter;
  /** Active aggregator orgs. */
  listActiveOrgs: () => Promise<Organisation[]>;
  /** Grants access (enable, role, group); idempotent. */
  grant: (org: Organisation) => Promise<{ status: 'granted' | 'partial' | 'no_login' }>;
  pause?: (ms: number) => Promise<void>;
}

/**
 * Gives every active org's owner sign-in access.
 *
 * Enables the Keycloak user, grants `org_owner` and adds the org's group, also
 * repairing owners already enabled. Idempotent. Skips the Default org and
 * placeholder owners.
 *
 * @param deps - Keycloak, the org list, the grant.
 * @param opts - `dryRun` reads only; `ratePerSecond` (> 0) paces Keycloak calls.
 * @returns Per-outcome counts and the org ids to follow up.
 * @throws {RangeError} When `ratePerSecond` is not a positive number.
 */
export async function enableOwnersStep(
  deps: EnableOwnersDeps,
  opts: { dryRun: boolean; ratePerSecond: number },
): Promise<EnableOwnersReport> {
  if (!Number.isFinite(opts.ratePerSecond) || opts.ratePerSecond <= 0) {
    throw new RangeError('--rate must be a positive number of calls per second');
  }
  const orgs = (await deps.listActiveOrgs()).filter(
    (o) => !o.isDefault && o.ownerEmail !== PLACEHOLDER_OWNER_EMAIL,
  );
  const report: EnableOwnersReport = {
    orgs: orgs.length,
    granted: 0,
    noLogin: 0,
    missingUser: 0,
    failed: 0,
    noLoginIds: [],
    missingIds: [],
    failedIds: [],
  };
  const pause = deps.pause ?? sleep;
  const gapMs = Math.ceil(1000 / opts.ratePerSecond);
  for (const org of orgs) {
    if (!org.ownerKcSub) {
      report.noLogin += 1;
      report.noLoginIds.push(org.id);
      continue;
    }
    // Sequential: paced against Keycloak.
    const found = await deps.idp.findById(org.ownerKcSub); // NOSONAR typescript:S9382
    if (!found.ok) {
      report.failed += 1;
      report.failedIds.push(org.id);
    } else if (!found.value) {
      report.missingUser += 1;
      report.missingIds.push(org.id);
    } else if (opts.dryRun) {
      report.granted += 1;
    } else {
      const result = await deps.grant(org); // NOSONAR typescript:S9382
      if (result.status === 'granted') report.granted += 1;
      else {
        report.failed += 1;
        report.failedIds.push(org.id);
      }
    }
    await pause(gapMs); // NOSONAR typescript:S9382
  }
  return report;
}

/** Every active aggregator org, paged through the store. */
async function activeOrgs(): Promise<Organisation[]> {
  const store = getOrganisationStore();
  const all: Organisation[] = [];
  let cursor: { name: string; id: string } | undefined;
  for (;;) {
    const page = /* NOSONAR typescript:S9382 */ await store.search({
      orgIds: null,
      status: 'active',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) throw new Error(`org list failed (${page.error.code})`);
    all.push(...page.value.rows);
    if (!page.value.nextCursor) return all;
    cursor = page.value.nextCursor;
  }
}

/**
 * Runs `enable-owners`: lets every existing org owner sign in.
 *
 * Exits 1 on any Keycloak error (re-run to resume). Owners without a login or
 * Keycloak user are listed by org id and do not fail it.
 *
 * @param opts - `dryRun` reads only; `ratePerSecond` paces Keycloak calls.
 * @param out - Line printer.
 * @returns 0 or 1.
 */
export async function enableOwners(
  opts: { dryRun: boolean; ratePerSecond: number },
  out: Out,
): Promise<number> {
  const log = logger as unknown as FastifyBaseLogger;
  const report = await enableOwnersStep(
    {
      idp: getIdpAdmin(),
      listActiveOrgs: activeOrgs,
      grant: (org) => grantOwnerAccess(org, log),
    },
    opts,
  );
  const { noLoginIds, missingIds, failedIds, ...counts } = report;
  out(`enable-owners ${JSON.stringify(counts)}${opts.dryRun ? ' (dry run)' : ''}`);
  for (const id of noLoginIds) out(`  no recorded login: org ${id}`);
  for (const id of missingIds) out(`  keycloak user missing: org ${id}`);
  for (const id of failedIds) out(`  keycloak error: org ${id}`);
  return report.failed > 0 ? 1 : 0;
}
