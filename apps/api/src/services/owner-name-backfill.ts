/**
 * One-off backfill of org-owner names onto the `contact` table.
 *
 * Belongs to `@aggregator-dpg/api`. Some org-owner contacts have no name in
 * the database; the name exists only in Keycloak. This reads it from Keycloak
 * through the owner's IdP login and stores it where the contact has none. An
 * existing name always wins. Safe to re-run.
 *
 * Runner: `apps/api/scripts/backfill-owner-contact-names.ts`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { organisations, contact, userIdentities, users } from '../db/schema.js';
import { IDP_PROVIDER } from './idp-admin/provider.js';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';
import type { IdpAdminAdapter, IdpUser, IdpResult } from './idp-admin/interface.js';

/** An org whose linked owner contact has no name yet. */
export interface OwnerNameCandidate {
  orgId: string;
  contactId: string;
  ownerKcSub: string;
}

/** Dependencies of the backfill; tests pass fakes. */
export interface OwnerNameBackfillDeps {
  idp: IdpAdminAdapter;
  listCandidates: () => Promise<OwnerNameCandidate[]>;
  /** Sets the name only while the contact still has none; returns whether it did. */
  setNameIfMissing: (contactId: string, name: string) => Promise<boolean>;
  /** Delay before the single retry of a transient Keycloak failure. */
  retryDelayMs?: number;
}

/** Outcome counts; never names or emails. */
export interface OwnerNameBackfillReport {
  candidates: number;
  updated: number;
  /** Keycloak user has no first/last name. */
  noName: number;
  /** Keycloak user no longer exists. */
  userMissing: number;
  /** Keycloak unreachable after the retry. */
  failed: number;
  dryRun: boolean;
}

/**
 * Fills missing org-owner contact names from Keycloak.
 *
 * @param deps - Keycloak adapter plus the candidate/update seams.
 * @param opts - `dryRun` reports what would change without writing.
 * @returns Per-outcome counts.
 */
export async function backfillOwnerContactNames(
  deps: OwnerNameBackfillDeps,
  opts: { dryRun: boolean },
): Promise<OwnerNameBackfillReport> {
  const report: OwnerNameBackfillReport = {
    candidates: 0,
    updated: 0,
    noName: 0,
    userMissing: 0,
    failed: 0,
    dryRun: opts.dryRun,
  };
  const candidates = await deps.listCandidates();
  report.candidates = candidates.length;

  for (const c of candidates) {
    // One Keycloak lookup at a time keeps load on the shared realm low.
    const outcome = await backfillOne(deps, c, opts.dryRun); // NOSONAR typescript:S9382
    if (outcome !== 'skipped') report[outcome]++;
  }
  return report;
}

/** What happened to one candidate; each value but `skipped` is a report counter. */
type CandidateOutcome = 'updated' | 'noName' | 'userMissing' | 'failed' | 'skipped';

/**
 * Looks up one owner in Keycloak and names their contact when it has no name.
 *
 * @param deps - Collaborators (see {@link OwnerNameBackfillDeps}).
 * @param c - The org owner to process.
 * @param dryRun - When true, reports what would change without writing.
 * @returns The outcome to count; never throws.
 */
async function backfillOne(
  deps: OwnerNameBackfillDeps,
  c: OwnerNameCandidate,
  dryRun: boolean,
): Promise<CandidateOutcome> {
  const start = Date.now();
  const user = await findWithRetry(deps.idp, c.ownerKcSub, deps.retryDelayMs ?? 500);
  if (!user.ok) {
    logger.error({
      operation: 'ownerNameBackfill.findUser',
      status: 'failure',
      error: user.error.message,
      error_type: user.error.code,
      latency_ms: Date.now() - start,
      org_id: c.orgId,
    });
    return 'failed';
  }
  if (!user.value) {
    logger.warn({
      operation: 'ownerNameBackfill.findUser',
      status: 'skipped',
      reason: 'kc_user_missing',
      org_id: c.orgId,
    });
    return 'userMissing';
  }
  const name = displayName(user.value);
  if (!name) {
    logger.info({
      operation: 'ownerNameBackfill',
      status: 'skipped',
      reason: 'kc_user_has_no_name',
      org_id: c.orgId,
    });
    return 'noName';
  }
  if (dryRun) return 'updated';
  let written: boolean;
  try {
    written = await deps.setNameIfMissing(c.contactId, name);
  } catch (err: unknown) {
    // One bad row must not abort the whole run; count it and carry on.
    logger.error({
      operation: 'ownerNameBackfill.setName',
      status: 'failure',
      error: (err as Error).message,
      error_type: (err as Error).constructor?.name,
      latency_ms: Date.now() - start,
      org_id: c.orgId,
    });
    return 'failed';
  }
  logger.info({
    operation: 'ownerNameBackfill.setName',
    // `skipped`: the contact gained a name since the candidate list was read.
    status: written ? 'success' : 'skipped',
    latency_ms: Date.now() - start,
    org_id: c.orgId,
  });
  return written ? 'updated' : 'skipped';
}

/** Joins first and last name, or returns `null` when Keycloak holds neither. */
function displayName(u: IdpUser): string | null {
  const name = [u.firstName, u.lastName]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(' ');
  return name === '' ? null : name;
}

/** Calls `findById`, retrying once after `delayMs` on a transient Keycloak failure. */
async function findWithRetry(
  idp: IdpAdminAdapter,
  sub: string,
  delayMs: number,
): Promise<IdpResult<IdpUser | null>> {
  const first = await idp.findById(sub);
  if (first.ok || first.error.code !== 'IDP_UNAVAILABLE') return first;
  await new Promise((r) => setTimeout(r, delayMs));
  return idp.findById(sub);
}

/**
 * Lists orgs whose owner contact has no name but has a Keycloak login.
 *
 * @returns The candidates (possibly empty).
 */
export async function listOwnerNameCandidatesFromDb(): Promise<OwnerNameCandidate[]> {
  const rows = await getDb()
    .select({
      orgId: organisations.id,
      contactId: users.contactId,
      ownerKcSub: userIdentities.subject,
    })
    .from(organisations)
    .innerJoin(users, eq(users.id, organisations.orgOwner))
    .innerJoin(contact, eq(contact.id, users.contactId))
    .innerJoin(
      userIdentities,
      and(eq(userIdentities.userId, users.id), eq(userIdentities.provider, IDP_PROVIDER)),
    )
    // Aggregator orgs only; the root has no Keycloak owner to read from.
    .where(and(isNull(contact.name), eq(organisations.orgType, 'aggregator')));
  return rows.flatMap((r) =>
    r.ownerKcSub ? [{ orgId: r.orgId, contactId: r.contactId, ownerKcSub: r.ownerKcSub }] : [],
  );
}

/**
 * Sets `contact.name` only while it is still NULL (an existing name wins).
 *
 * @param contactId - The contact to name.
 * @param name - The name read from Keycloak.
 * @returns Whether a row was updated.
 */
export async function setContactNameIfMissingInDb(
  contactId: string,
  name: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(contact)
    .set({ name })
    .where(and(eq(contact.id, contactId), isNull(contact.name)))
    .returning({ id: contact.id });
  return rows.length > 0;
}
