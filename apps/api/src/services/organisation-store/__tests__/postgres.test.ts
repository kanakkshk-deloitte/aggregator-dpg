/**
 * Unit tests for PostgresOrganisationStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * insert/CAS-approve/error-mapping logic in `postgres.ts` without a live
 * database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PostgresOrganisationStore } from '../postgres.js';
import { permissiveTreeRules } from '../testing.js';
import { _setDbClients } from '../../../db/client.js';
import { orgKnownAs } from '../../../db/schema.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import type { Organisation, CreateOrgInput, TreeRules } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeFakeDb(resolveRaw: (chain: ChainCall[]) => unknown): unknown {
  // Reads go through `aggregator_orgs JOIN contact` (migration 0025) and
  // resolve to `{ o, c }` pairs. Tests keep returning flat rows; wrap them
  // here, deriving the joined contact from the fixture's owner fields.
  const resolve = (chain: ChainCall[]): unknown => {
    // Raw SQL: the admin-account link reads `id`; ownerIsShared reads `shared`.
    if (chain[0]?.method === 'execute') return { rows: [{ n: 1, id: 'admin-1', shared: false }] };
    const out = resolveRaw(chain);
    if (!chain.some((c) => c.method === 'innerJoin') || !Array.isArray(out)) return out;
    return out.map((r: Record<string, unknown>) =>
      'o' in r
        ? r
        : {
            // The fixture is a domain row; the table columns follow 0028.
            o: {
              ...r,
              name: r['displayName'],
              orgOwner: r['ownerUserId'],
              orgType: 'aggregator',
              url: r['url'] ?? null,
              locations: r['locations'] ?? [],
              legalName: r['legalName'] ?? null,
              gstNumber: r['gstNumber'] ?? null,
            },
            ownerKcSub: (r['ownerKcSub'] as string | null) ?? null,
            parentName: (r['parentName'] as string | null) ?? null,
            c: {
              id: 'c'.repeat(64),
              email: String(r['ownerEmail']).toLowerCase(),
              phone: (r['ownerPhone'] as string | null) ?? null,
              name: (r['ownerName'] as string | null) ?? null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          },
    );
  };
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string | symbol) {
          if (prop === 'transaction') {
            // Run the callback against a fresh chain, like Drizzle does.
            return (fn: (tx: unknown) => Promise<unknown>) => fn(build([]));
          }
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              let result: unknown;
              try {
                result = resolve(chain);
              } catch (e) {
                return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e);
              }
              return Promise.resolve(result).then(onFulfilled, onRejected);
            };
          }
          if (prop === 'catch') {
            return (onRejected: (e: unknown) => unknown) =>
              (build(chain) as Promise<unknown>).then(undefined, onRejected);
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

/** Whether `chain` is the INSERT/UPDATE of the `aggregator_orgs` row itself. */
function isOrgWrite(chain: ChainCall[]): boolean {
  const values = callArgs(chain, 'values')?.[0] as Record<string, unknown> | undefined;
  const set = callArgs(chain, 'set')?.[0] as Record<string, unknown> | undefined;
  return values?.['slug'] !== undefined || set?.['updatedAt'] !== undefined;
}

afterEach(() => {
  _setDbClients(null, null);
});

function makeRow(overrides: Partial<Organisation> = {}): Organisation {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    contactId: 'a'.repeat(64),
    ownerUserId: 'admin-1',
    ownerEmail: 'owner@test.local',
    ownerPhone: null,
    ownerName: null,
    ownerKcSub: null,
    kcGroupId: null,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    updatedBy: null,
    rejectedAt: null,
    isDefault: false,
    locations: [],
    legalName: null,
    knownAs: 'aggregator',
    knownAsName: 'Aggregator',
    depth: 1,
    parentId: null,
    parentName: null,
    description: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateOrgInput> = {}): CreateOrgInput {
  return {
    slug: 'test-org',
    displayName: 'Test Org',
    ownerEmail: 'owner@test.local',
    recordConsent: NO_CONSENT_WRITE,
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.create', () => {
  it('inserts the mapped row linked to the owner contact', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ ownerEmail: 'owner@test.local' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(
      makeInput({ ownerEmail: 'OWNER@TEST.LOCAL' }),
      permissiveTreeRules(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerEmail).toBe('owner@test.local');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      slug: 'test-org',
      name: 'Test Org',
      // Every new org is an aggregator under the network root (0028).
      orgType: 'aggregator',
      // The owner is an admin account (0027) linked to the owner's contact;
      // the org row holds no contact or IdP copy of its own.
      orgOwner: 'admin-1',
      state: null,
      kcGroupId: null,
    });
    const orgValues = callArgs(captured, 'values')?.[0] as Record<string, unknown>;
    expect(orgValues).not.toHaveProperty('contactId');
    expect(orgValues).not.toHaveProperty('ownerKcSub');
  });

  it('inserts depth as the parent depth plus one and reads depth back', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (isOrgWrite(chain)) captured = chain;
      // The parent lookup and the re-read both see an active depth-2 row.
      return [makeRow({ depth: 2, status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput({ parentId: 'p1' }), permissiveTreeRules());

    expect(result.ok && result.value.depth).toBe(2);
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      parentId: '00000000-0000-0000-0000-0000000000a1',
      depth: 3,
    });
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a display-name unique violation (SQLSTATE 23505 + constraint) to DUPLICATE_NAME', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'organisations_name_live_unique',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug unique violation (SQLSTATE 23505 + constraint) to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'organisations_slug_live_unique',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it.each([
    ['contact_email_unique', 'DUPLICATE_EMAIL'],
    ['contact_phone_unique', 'DUPLICATE_PHONE'],
  ] as const)('maps a %s violation (another person) to %s', async (constraint, code) => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    });
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().create(makeInput(), permissiveTreeRules());
    expect(result.ok || result.error.code).toBe(code);
  });

  it('does NOT misreport a connection error whose query text names a constraint (M2)', async () => {
    // No SQLSTATE 23505 → must be DB_UNAVAILABLE even though the message text
    // mentions the unique index (Drizzle puts the query text on `.message`).
    const db = makeFakeDb(() => {
      throw Object.assign(
        new Error('Failed query: insert ... organisations_name_live_unique ...'),
        { cause: new Error('connection terminated') },
      );
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a display-name violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_NAME', async () => {
    // Real Drizzle shape: outer `.message` is the query text; the pg driver
    // error (SQLSTATE 23505 + `constraint`) is on `.cause`. Regression guard
    // for the 503-instead-of-409 misclassification.
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "organisations_name_live_unique"',
        ),
        { code: '23505', constraint: 'organisations_name_live_unique' },
      );
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key value ...'), {
        code: '23505',
        constraint: 'organisations_slug_live_unique',
      });
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput(), permissiveTreeRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    // The driver message carries query parameters; it is never echoed.
    expect(result.error.message).not.toContain('connection reset');
  });
});

// ─── findById / findBySlug / findByOwnerEmail (findOne) ────────────────────

describe('PostgresOrganisationStore.findById / findBySlug / findByOwnerEmail', () => {
  it('findById returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('org-1');
  });

  it('findById returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('findById returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findBySlug returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ slug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();
    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.slug).toBe('acme');
  });

  it('findByOwnerEmail lowercases the lookup value and returns the mapped row', async () => {
    const db = makeFakeDb(() => [makeRow({ ownerEmail: 'mixed@x.org' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findByOwnerEmail('MIXED@X.ORG');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.ownerEmail).toBe('mixed@x.org');
  });

  it('findByOwnerPhone returns the org whose owner contact holds the phone', async () => {
    const db = makeFakeDb(() => [makeRow({ ownerPhone: '+919000000009' })]);
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().findByOwnerPhone('+919000000009');
    expect(result.ok && result.value?.ownerPhone).toBe('+919000000009');
  });

  it('findByOwnerEmail returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findByOwnerEmail('a@x.org');
    expect(result.ok).toBe(false);
  });
});

// ─── listActive / listPending ───────────────────────────────────────────────

describe('PostgresOrganisationStore.listActive', () => {
  it('returns the mapped active rows', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1', status: 'active' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.status).toBe('active');
  });

  it('returns an empty array when there are no active orgs', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore.listPending', () => {
  it('builds a compound where clause when updatedBefore is given', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending(new Date('2026-01-01T00:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(callArgs(captured, 'where')?.[0]).toBeDefined();
  });

  it('filters on status=pending only when updatedBefore is omitted', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'pending' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.update', () => {
  it('merges the patch and stamps updatedAt', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ displayName: 'New Name' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('org-1', { displayName: 'New Name' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe('New Name');
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ name: 'New Name' });
    expect(set).toHaveProperty('updatedAt');
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('missing', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('org-1', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── deleteById ─────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.deleteById', () => {
  it('returns ok(void) on success', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── approve / reject (casFromPending) ──────────────────────────────────────

describe('PostgresOrganisationStore.approve / reject', () => {
  it('approve returns the updated row on a successful CAS', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('active');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'active' });
  });

  it('approve returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('reject returns the updated row with status=inactive', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'inactive' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.reject('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('inactive');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'inactive' });
  });

  it('reject returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.reject('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore — consent in the create transaction (0029)', () => {
  it('runs recordConsent inside the transaction with the new org id', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-7', ownerEmail: 'owner@test.local' })]);
    _setDbClients(null, db as never);
    const calls: { tx: unknown; id: string }[] = [];
    const result = await new PostgresOrganisationStore().create(
      makeInput({
        recordConsent: async (tx, id) => {
          calls.push({ tx, id });
        },
      }),
      permissiveTreeRules(),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tx).toBeDefined();
  });

  it('answers CONSENT_WRITE_FAILED when the hook throws (the transaction rolls back)', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-8', ownerEmail: 'owner@test.local' })]);
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().create(
      makeInput({
        recordConsent: async () => {
          throw new Error('ledger down');
        },
      }),
      permissiveTreeRules(),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
    });
  });
});

/** Every string literal inside a Drizzle `sql` object (visited once each). */
function sqlText(node: unknown, seen = new Set<unknown>()): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object' || seen.has(node)) return '';
  seen.add(node);
  return Object.values(node as Record<string, unknown>)
    .map((v) => sqlText(v, seen))
    .join(' ');
}

describe('PostgresOrganisationStore.search — descendantsOf', () => {
  it('adds a recursive subtree filter only when descendantsOf is set', async () => {
    const wheres: unknown[] = [];
    const db = makeFakeDb((chain) => {
      wheres.push(callArgs(chain, 'where')?.[0]);
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const below = await store.search({ orgIds: null, descendantsOf: 'state-id' });
    expect(below.ok && below.value.rows).toHaveLength(1);
    await store.search({ orgIds: null });

    expect(sqlText(wheres[0])).toContain('WITH RECURSIVE');
    expect(sqlText(wheres[1])).not.toContain('WITH RECURSIVE');
  });
});

describe('PostgresOrganisationStore — descendants', () => {
  it('descendantIds runs one recursive query and leaves out the given ids', async () => {
    // The fake answers raw SQL with the row id 'admin-1': a given id, so it is left out.
    _setDbClients(null, makeFakeDb(() => []) as never);
    const r = await new PostgresOrganisationStore().descendantIds(['admin-1']);
    expect(r.ok && r.value).toEqual([]);
    expect(await new PostgresOrganisationStore().descendantIds([])).toEqual({
      ok: true,
      value: [],
    });
  });

  it('descendantIds returns DB_UNAVAILABLE when the driver throws', async () => {
    const failing = {
      execute: () => Promise.reject(Object.assign(new Error('boom'), { code: '57P01' })),
    };
    _setDbClients(null, failing as never);
    const r = await new PostgresOrganisationStore().descendantIds(['p']);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore — tree rules', () => {
  const rules: TreeRules = {
    maxDepth: 3,
    maxChildren: null,
    maxTotalOrgs: 50,
  };

  /** Wraps a fake so the statements run on the transaction are recorded in order. */
  function recording(inner: unknown, statements: string[]): unknown {
    const dialect = new PgDialect();
    return new Proxy(inner as object, {
      get(target, prop) {
        const value = (target as Record<string | symbol, unknown>)[prop];
        if (prop !== 'transaction') return value;
        return (fn: (tx: unknown) => Promise<unknown>) =>
          (value as (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>)((tx) =>
            fn(
              new Proxy(tx as object, {
                get(t, p) {
                  const v = (t as Record<string | symbol, unknown>)[p];
                  if (typeof p !== 'string') return v;
                  return (...args: unknown[]) => {
                    statements.push(p === 'execute' ? dialect.sqlToQuery(args[0] as SQL).sql : p);
                    return (v as (...a: unknown[]) => unknown)(...args);
                  };
                },
              }),
            ),
          );
      },
    });
  }

  it.each([
    ['create', (s: PostgresOrganisationStore) => s.create(makeInput(), rules)],
    ['revive', (s: PostgresOrganisationStore) => s.revive('o1', 'p1', rules)],
    ['move', (s: PostgresOrganisationStore) => s.move('o1', { parentId: 'p1' }, rules)],
    ['setKnownAs', (s: PostgresOrganisationStore) => s.setKnownAs('o1', 'state', 'p1', 'u1')],
    ['setKnownAsValues', (s: PostgresOrganisationStore) => s.setKnownAsValues('o1', [], 'u1')],
  ] as const)('%s takes the tree lock as the first statement', async (_name, call) => {
    const statements: string[] = [];
    _setDbClients(
      null,
      recording(
        makeFakeDb(() => []),
        statements,
      ) as never,
    );
    await call(new PostgresOrganisationStore());
    expect(statements[0]).toContain("pg_advisory_xact_lock(hashtext('aggregator-dpg:org-tree'))");
  });

  it('move answers ORG_BUSY when the org row is locked (SQLSTATE 55P03)', async () => {
    const db = makeFakeDb((chain) => {
      if (chain.some((c) => c.method === 'for')) {
        throw Object.assign(new Error('could not obtain lock'), { code: '55P03' });
      }
      return [];
    });
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().move('o1', { parentId: 'p1' }, rules);
    expect(!r.ok && r.error.code).toBe('ORG_BUSY');
  });

  it('move locks the org row with NOWAIT and answers NOT_FOUND when it is missing', async () => {
    let forArgs: unknown[] | undefined;
    const db = makeFakeDb((chain) => {
      forArgs ??= callArgs(chain, 'for');
      return [];
    });
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().move('o1', { parentId: 'p1' }, rules);
    expect(!r.ok && r.error.code).toBe('NOT_FOUND');
    expect(forArgs).toEqual(['update', { noWait: true }]);
  });

  it('childCounts returns every id, 0 when it has no counted child', async () => {
    _setDbClients(null, makeFakeDb(() => [{ parentId: 'a', n: '2' }]) as never);
    const store = new PostgresOrganisationStore();
    expect(await store.childCounts(['a', 'b'])).toEqual({ ok: true, value: { a: 2, b: 0 } });
    expect(await store.childCounts([])).toEqual({ ok: true, value: {} });
  });

  it('countTotal returns the count', async () => {
    _setDbClients(null, makeFakeDb(() => [{ n: 3 }]) as never);
    expect(await new PostgresOrganisationStore().countTotal()).toEqual({ ok: true, value: 3 });
  });

  it.each([
    ['childCounts', (s: PostgresOrganisationStore) => s.childCounts(['a'])],
    ['countTotal', (s: PostgresOrganisationStore) => s.countTotal()],
    ['parentOptions', (s: PostgresOrganisationStore) => s.parentOptions('a', rules)],
  ] as const)('%s returns DB_UNAVAILABLE when the driver throws', async (_name, call) => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const r = await call(new PostgresOrganisationStore());
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore — move and revive statements', () => {
  const dialect = new PgDialect();
  const baseRules: TreeRules = {
    maxDepth: 5,
    maxChildren: null,
    maxTotalOrgs: 50,
  };
  type NodeRow = {
    id: string;
    parentId: string | null;
    depth: number;
    status: string;
    orgType: 'network_facilitator' | 'aggregator';
    slug: string;
  };
  const node = (id: string, parentId: string | null, depth: number) =>
    ({
      id,
      parentId,
      depth,
      status: 'active',
      orgType: parentId === null ? 'network_facilitator' : 'aggregator',
      slug: id,
    }) as NodeRow;

  /** A joined read row (`selectJoined`), built from a domain row like makeFakeDb does. */
  const joined = (r: Organisation) => ({
    o: {
      ...r,
      name: r.displayName,
      orgOwner: r.ownerUserId,
      orgType: 'aggregator',
      // Columns the app no longer reads; their values live in `profile`.
      url: null,
      locations: r.locations,
      legalName: r.legalName,
      gstNumber: null,
    },
    ownerKcSub: r.ownerKcSub,
    parentName: r.parentName,
    parentKnownAsName: null,
    c: {
      id: 'c'.repeat(64),
      email: r.ownerEmail,
      phone: r.ownerPhone,
      name: r.ownerName,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  });

  interface Script {
    tree?: NodeRow[];
    /** Rows returned by the recursive depth update. */
    moved?: Array<{ id: string }>;
    /** move: the moved org's key. */
    current?: string;
    /** The `org_known_as` list of the org the statement reads (parent or target). */
    list?: KnownAsValues;
    /** setKnownAs / setKnownAsValues: the target row. */
    target?: Record<string, unknown> | null;
    /** revive: the rejected row, a child, the parent, live counts. */
    rejected?: { status: string } | null;
    child?: boolean;
    parent?: NodeRow;
    live?: number;
    read?: Organisation;
    /** setKnownAsValues: the children the reset returns. */
    resetIds?: Array<{ id: string }>;
  }

  /** A Drizzle-like executor answering each statement from the script, recording writes. */
  function scripted(script: Script) {
    const sets: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    const upserts: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    const wheres: string[] = [];
    const executed: string[] = [];
    const params: unknown[][] = [];
    const resolve = (chain: ChainCall[]): unknown => {
      const first = chain[0];
      if (first?.method === 'execute') {
        const q = dialect.sqlToQuery(first.args[0] as SQL);
        executed.push(q.sql);
        params.push(q.params);
        return { rows: q.sql.includes('WITH RECURSIVE sub') ? (script.moved ?? []) : [] };
      }
      if (first?.method === 'insert') {
        inserts.push(callArgs(chain, 'values')?.[0] as Record<string, unknown>);
        const conflict = callArgs(chain, 'onConflictDoUpdate')?.[0] as
          { set: Record<string, unknown> } | undefined;
        if (conflict) upserts.push(conflict.set);
        return [];
      }
      if (first?.method === 'delete') {
        deletes.push(dialect.sqlToQuery(callArgs(chain, 'where')?.[0] as SQL).sql);
        return [];
      }
      if (first?.method === 'update') {
        sets.push(callArgs(chain, 'set')?.[0] as Record<string, unknown>);
        wheres.push(dialect.sqlToQuery(callArgs(chain, 'where')?.[0] as SQL).sql);
        return chain.some((c) => c.method === 'returning') ? (script.resetIds ?? []) : [];
      }
      if (chain.some((c) => c.method === 'innerJoin')) {
        return script.read ? [joined(script.read)] : [];
      }
      const fields = Object.keys((callArgs(chain, 'select')?.[0] ?? {}) as object);
      if (callArgs(chain, 'from')?.[0] === orgKnownAs) {
        const list = script.list ?? [];
        return list.length > 0 ? [{ values: list }] : [];
      }
      const forArg = callArgs(chain, 'for')?.[0];
      if (forArg === 'update') return [{ id: 'locked' }];
      if (forArg === 'share') return script.parent ? [script.parent] : [];
      if (!chain.some((c) => c.method === 'where')) return script.tree ?? [];
      if (fields.length === 1 && fields[0] === 'status') {
        return script.rejected ? [script.rejected] : [];
      }
      if (fields.length === 1 && fields[0] === 'knownAs') {
        return [{ knownAs: script.current ?? 'aggregator' }];
      }
      if (fields.includes('slug') && !fields.includes('depth')) {
        return script.target ? [script.target] : [];
      }
      if (fields.length === 1 && fields[0] === 'id') return script.child ? [{ id: 'kid' }] : [];
      if (fields.length === 1 && fields[0] === 'n') return [{ n: script.live ?? 0 }];
      return [];
    };
    const build = (chain: ChainCall[]): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop: string | symbol) {
            if (prop === 'transaction') {
              return (fn: (tx: unknown) => Promise<unknown>) => fn(build([]));
            }
            if (prop === 'then') {
              return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
                try {
                  return Promise.resolve(resolve(chain)).then(ok, bad);
                } catch (e) {
                  return bad ? Promise.resolve(bad(e)) : Promise.reject(e);
                }
              };
            }
            return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
          },
        },
      );
    _setDbClients(null, build([]) as never);
    return {
      sets,
      inserts,
      upserts,
      deletes,
      wheres,
      executed,
      params,
      store: new PostgresOrganisationStore(),
    };
  }

  // root ─ a(1) ─ b(2);  root ─ c(1) ─ d(2)
  const tree = () => [
    node('root', null, 0),
    node('a', 'root', 1),
    node('b', 'a', 2),
    node('c', 'root', 1),
    node('d', 'c', 2),
  ];
  const depthUpdate = (s: { executed: string[]; params: unknown[][] }) => {
    const i = s.executed.findIndex((q) => q.includes('WITH RECURSIVE sub'));
    return i < 0 ? null : s.params[i];
  };

  it('moves an org and its subtree two levels deeper with one depth update', async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'a' }, { id: 'b' }],
      read: makeRow({ id: 'a', depth: 3, parentId: 'd' }),
    });
    const r = await s.store.move('a', { parentId: 'd' }, baseRules);
    expect(r.ok && [r.value.movedCount, r.value.oldParentId]).toEqual([2, 'root']);
    expect(s.sets[0]).toMatchObject({ parentId: 'd' });
    expect(depthUpdate(s)).toEqual(['a', 2]);
  });

  it('shifts depth by a negative delta when moving to a shallower parent', async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'b' }],
      read: makeRow({ id: 'b', depth: 1, parentId: 'root' }),
    });
    const r = await s.store.move('b', { parentId: 'root' }, baseRules);
    expect(r.ok && r.value.movedCount).toBe(1);
    expect(depthUpdate(s)).toEqual(['b', -1]);
  });

  it("keeps the moved org's key when the new parent's list has it", async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'a' }, { id: 'b' }],
      current: 'block',
      list: [{ key: 'block', name: 'Block' }],
      read: makeRow({ id: 'a', depth: 2, parentId: 'c' }),
    });
    const r = await s.store.move('a', { parentId: 'c' }, baseRules);
    expect(r.ok && r.value.movedCount).toBe(2);
    expect(s.sets[0]).toMatchObject({ parentId: 'c' });
    expect(s.sets[0]).not.toHaveProperty('knownAs');
  });

  it("gives the moved org the new parent's default when the list lacks its key", async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'a' }],
      current: 'gone',
      list: [
        { key: 'block', name: 'Block' },
        { key: 'ward', name: 'Ward', default: true },
      ],
      read: makeRow({ id: 'a', depth: 2, parentId: 'c' }),
    });
    await s.store.move('a', { parentId: 'c' }, baseRules);
    expect(s.sets[0]).toMatchObject({ parentId: 'c', knownAs: 'ward' });
  });

  it('gives aggregator when the new parent has no default', async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'a' }],
      current: 'gone',
      list: [{ key: 'block', name: 'Block' }],
      read: makeRow({ id: 'a', depth: 2, parentId: 'c' }),
    });
    await s.store.move('a', { parentId: 'c' }, baseRules);
    expect(s.sets[0]).toMatchObject({ knownAs: 'aggregator' });
  });

  it('keeps aggregator even when the new parent has a default', async () => {
    const s = scripted({
      tree: tree(),
      moved: [{ id: 'a' }],
      current: 'aggregator',
      list: [{ key: 'ward', name: 'Ward', default: true }],
      read: makeRow({ id: 'a', depth: 2, parentId: 'c' }),
    });
    await s.store.move('a', { parentId: 'c' }, baseRules);
    expect(s.sets[0]).toMatchObject({ parentId: 'c' });
    expect(s.sets[0]).not.toHaveProperty('knownAs');
  });

  it('sends no write for a move to the current parent without a new value', async () => {
    const s = scripted({ tree: tree(), read: makeRow({ id: 'b', depth: 2, parentId: 'a' }) });
    const r = await s.store.move('b', { parentId: 'a' }, baseRules);
    expect(r.ok && r.value.movedCount).toBe(0);
    expect(s.sets).toEqual([]);
    expect(depthUpdate(s)).toBeNull();
  });

  it('revive refuses a rejected org that has a child (NOT_MOVABLE) and writes nothing', async () => {
    const s = scripted({ rejected: { status: 'inactive' }, child: true });
    const r = await s.store.revive('a', 'c', baseRules);
    expect(!r.ok && r.error.code).toBe('NOT_MOVABLE');
    expect(s.sets).toEqual([]);
  });

  it("revive places the org under the new parent, one level down, with the parent's default", async () => {
    const s = scripted({
      rejected: { status: 'inactive' },
      parent: node('c', 'root', 1),
      list: [{ key: 'ward', name: 'Ward', default: true }],
      live: 1,
      read: makeRow({ id: 'a', depth: 2, parentId: 'c', status: 'pending' }),
    });
    const r = await s.store.revive('a', 'c', baseRules);
    expect(r.ok && r.value.parentId).toBe('c');
    expect(s.sets[0]).toMatchObject({
      parentId: 'c',
      depth: 2,
      knownAs: 'ward',
      status: 'pending',
      rejectedAt: null,
    });
  });

  it('setKnownAs writes a key of the parent list with the writer', async () => {
    const s = scripted({
      target: { parentId: 'p1', slug: 'o1', status: 'active' },
      list: [{ key: 'ward', name: 'Ward' }],
      read: makeRow({ id: 'o1', parentId: 'p1', knownAs: 'ward' }),
    });
    const r = await s.store.setKnownAs('o1', 'ward', 'p1', 'u1');
    expect(r.ok && r.value.knownAs).toBe('ward');
    expect(s.sets[0]).toMatchObject({ knownAs: 'ward', updatedBy: 'u1' });
  });

  it.each([
    ['KNOWN_AS_INVALID', { parentId: 'p1', slug: 'o1', status: 'active' }, 'block'],
    ['KNOWN_AS_INVALID', { parentId: 'p1', slug: 'o1', status: 'active' }, 'aggregator'],
    ['ORG_MOVED', { parentId: 'p2', slug: 'o1', status: 'active' }, 'ward'],
    ['NOT_EDITABLE', { parentId: 'p1', slug: 'default', status: 'active' }, 'ward'],
    ['NOT_EDITABLE', { parentId: 'p1', slug: 'o1', status: 'inactive' }, 'ward'],
    ['NOT_FOUND', null, 'ward'],
  ] as const)('setKnownAs refuses with %s and writes nothing', async (expected, target, key) => {
    const s = scripted({ target, list: [{ key: 'ward', name: 'Ward' }] });
    const r = await s.store.setKnownAs('o1', key, 'p1', 'u1');
    expect(!r.ok && r.error.code).toBe(expected);
    expect(s.sets).toEqual([]);
  });

  it('setKnownAs allows only aggregator under an empty list', async () => {
    const s = scripted({
      target: { parentId: 'p1', slug: 'o1', status: 'active' },
      list: [],
      read: makeRow({ id: 'o1', parentId: 'p1' }),
    });
    expect((await s.store.setKnownAs('o1', 'aggregator', 'p1', 'u1')).ok).toBe(true);
  });

  it('setKnownAsValues upserts the root row by id and resets children outside the list', async () => {
    const s = scripted({
      target: { orgType: 'network_facilitator', slug: 'network' },
      resetIds: [{ id: 'x' }, { id: 'y' }],
      read: makeRow({ id: 'root' }),
    });
    const r = await s.store.setKnownAsValues('root', [{ name: 'Ward', default: true }], 'admin');
    expect(r.ok && r.value.resetCount).toBe(2);
    expect(r.ok && r.value.values).toEqual([{ key: 'ward', name: 'Ward', default: true }]);
    expect(s.deletes).toEqual([]);
    expect(s.inserts).toEqual([
      expect.objectContaining({
        orgId: 'root',
        knownAsValues: [{ key: 'ward', name: 'Ward', default: true }],
        updatedBy: 'admin',
      }),
    ]);
    expect(s.upserts).toEqual([
      expect.objectContaining({
        knownAsValues: [{ key: 'ward', name: 'Ward', default: true }],
        updatedBy: 'admin',
      }),
    ]);
    expect(s.sets[0]).toMatchObject({ updatedBy: 'admin' });
    // The org write is not limited to aggregator orgs, so the root can be written.
    expect(s.wheres[0]).not.toContain('org_type');
    // The reset sets only known_as (updated_at is kept) and skips aggregator, the list and Default.
    expect(s.sets[1]).toEqual({ knownAs: 'ward' });
    expect(s.wheres[1]).toContain('"org_type" = ');
    expect(s.wheres[1]).toContain('"slug" <> ');
    expect(s.wheres[1]).toContain('"known_as" not in');
  });

  it('setKnownAsValues writes a changed list as one row, in the sent order', async () => {
    const s = scripted({
      target: { orgType: 'aggregator', slug: 'o1' },
      list: [
        { key: 'state', name: 'State' },
        { key: 'block', name: 'Block' },
      ],
      read: makeRow({ id: 'o1' }),
    });
    const r = await s.store.setKnownAsValues(
      'o1',
      [{ key: 'block', name: 'Blocks' }, { key: 'state', name: 'State' }, { name: 'Ward' }],
      'u1',
    );
    expect(r.ok).toBe(true);
    expect(s.inserts).toHaveLength(1);
    expect(s.inserts[0]!['knownAsValues']).toEqual([
      { key: 'block', name: 'Blocks' },
      { key: 'state', name: 'State' },
      { key: 'ward', name: 'Ward' },
    ]);
  });

  it('setKnownAsValues does not write an unchanged list', async () => {
    const list = [
      { key: 'state', name: 'State', default: true as const },
      { key: 'block', name: 'Block' },
    ];
    const s = scripted({ target: { orgType: 'aggregator', slug: 'o1' }, list, read: makeRow() });
    const r = await s.store.setKnownAsValues('o1', list, 'u1');
    expect(r.ok && r.value.values).toEqual(list);
    expect(s.inserts).toEqual([]);
    expect(s.deletes).toEqual([]);
  });

  it('setKnownAsValues with an empty list deletes the row and inserts none', async () => {
    const s = scripted({
      target: { orgType: 'aggregator', slug: 'o1' },
      list: [{ key: 'state', name: 'State' }],
      read: makeRow({ id: 'o1' }),
    });
    const r = await s.store.setKnownAsValues('o1', [], 'u1');
    expect(r.ok && r.value.values).toEqual([]);
    expect(s.deletes).toHaveLength(1);
    expect(s.deletes[0]).toContain('"org_id" = ');
    expect(s.inserts).toEqual([]);
    expect(s.sets[1]).toEqual({ knownAs: 'aggregator' });
  });

  it('setKnownAsValues refuses the Default org and an unknown org', async () => {
    const def = scripted({ target: { orgType: 'aggregator', slug: 'default' } });
    const r = await def.store.setKnownAsValues('d0', [], 'u1');
    expect(!r.ok && r.error.code).toBe('NOT_EDITABLE');
    expect(def.sets).toEqual([]);
    expect(def.deletes).toEqual([]);
    const none = scripted({ target: null });
    const n = await none.store.setKnownAsValues('x', [], 'u1');
    expect(!n.ok && n.error.code).toBe('NOT_FOUND');
  });

  it('setKnownAsValues refuses a sent key not in the list read under the lock', async () => {
    const s = scripted({
      target: { orgType: 'aggregator', slug: 'o1' },
      list: [{ key: 'block', name: 'Block' }],
    });
    const r = await s.store.setKnownAsValues(
      'o1',
      [
        { key: 'block', name: 'Block' },
        { key: 'ward', name: 'Ward' },
      ],
      'u1',
    );
    expect(r.ok ? null : r.error).toMatchObject({ code: 'KNOWN_AS_UNKNOWN_KEY', index: 1 });
    expect(s.sets).toEqual([]);
    expect(s.deletes).toEqual([]);
    expect(s.inserts).toEqual([]);
  });

  it('setKnownAsValues makes a new key that is not a dropped key of the stored list', async () => {
    const s = scripted({
      target: { orgType: 'aggregator', slug: 'o1' },
      list: [{ key: 'state', name: 'State' }],
      resetIds: [{ id: 'x' }],
      read: makeRow({ id: 'o1' }),
    });
    const r = await s.store.setKnownAsValues('o1', [{ name: 'State' }], 'u1');
    expect(r.ok && r.value.resetCount).toBe(1);
    expect(s.inserts[0]!['knownAsValues']).toEqual([{ key: 'state_2', name: 'State' }]);
  });

  it('countStaleKnownAs counts with one statement', async () => {
    const s = scripted({ live: 3 });
    const r = await s.store.countStaleKnownAs();
    expect(r.ok && r.value).toBe(3);
  });

  it('defaultKnownAsNames answers an empty map without a query for no ids', async () => {
    const db = makeFakeDb(() => {
      throw new Error('no query expected');
    });
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().defaultKnownAsNames([]);
    expect(r.ok && r.value).toEqual({});
  });

  it('defaultKnownAsNames maps each org to its default name', async () => {
    const db = makeFakeDb(() => [
      {
        orgId: 'p1',
        values: [
          { key: 'block', name: 'Block' },
          { key: 'district', name: 'District', default: true },
        ],
      },
      { orgId: 'p2', values: [{ key: 'ward', name: 'Ward' }] },
    ]);
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().defaultKnownAsNames(['p1', 'p2']);
    expect(r.ok && r.value).toEqual({ p1: 'District' });
  });

  it.each([
    ['knownAsValues', (st: PostgresOrganisationStore) => st.knownAsValues('o1')],
    ['defaultKnownAsNames', (st: PostgresOrganisationStore) => st.defaultKnownAsNames(['o1'])],
    ['countStaleKnownAs', (st: PostgresOrganisationStore) => st.countStaleKnownAs()],
  ] as const)('%s returns DB_UNAVAILABLE when the driver throws', async (_n, call) => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const r = await call(new PostgresOrganisationStore());
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });

  it('knownAsValues reads the rows in list order', async () => {
    const s = scripted({
      list: [
        { key: 'b', name: 'B' },
        { key: 'a', name: 'A', default: true },
      ],
    });
    const r = await s.store.knownAsValues('o1');
    expect(r.ok && r.value).toEqual([
      { key: 'b', name: 'B' },
      { key: 'a', name: 'A', default: true },
    ]);
  });

  it('revive answers NOT_FOUND when the org is no longer rejected', async () => {
    const s = scripted({ rejected: null });
    const r = await s.store.revive('a', 'c', baseRules);
    expect(!r.ok && r.error.code).toBe('NOT_FOUND');
  });
});
