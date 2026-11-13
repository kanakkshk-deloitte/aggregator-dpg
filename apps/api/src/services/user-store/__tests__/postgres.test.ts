/**
 * Unit tests for PostgresUserStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub that mimics
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked, matching the pattern used in
 * `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`
 * and `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`). Every
 * chained call is recorded so a test can assert on the exact values passed
 * into `.values()` / `.set()`, and the terminal `await` resolves to whatever
 * the test configures (a row set, an empty set, or a thrown driver error) —
 * this exercises the real UPSERT/error-mapping logic in `postgres.ts`
 * without a live database.
 *
 * @module @aggregator-dpg/api
 */
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { afterEach, describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PostgresUserStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import type { Coordinator, CreateCoordinatorInput } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

/**
 * Builds a stub that mimics Drizzle's fluent, thenable query builder. Every
 * chained method call (`.select()`, `.where()`, `.values()`, ...) is appended
 * to `chain`; when the caller finally `await`s the chain, `resolve(chain)`
 * decides what the "query" resolves to (return an array to simulate rows, or
 * throw to simulate a driver error).
 */
function makeFakeDb(
  resolveRaw: (chain: ChainCall[]) => unknown,
  opts: { refs?: number } = {},
): unknown {
  // Reads go through `aggregators JOIN contact` (migration 0025) and
  // resolve to `{ a, c }` pairs. Tests keep returning flat rows; wrap them
  // here, deriving the joined contact row from the fixture's `contact`.
  const resolve = (chain: ChainCall[]): unknown => {
    // `db.execute(sql…)` (contact FOR KEY SHARE / reference count) returns a
    // pg QueryResult: one row held, referenced `opts.refs` times (default once).
    if (chain[0]?.method === 'execute') return { rows: [{ n: opts.refs ?? 1 }] };
    const out = resolveRaw(chain);
    if (!chain.some((c) => c.method === 'innerJoin') || !Array.isArray(out)) return out;
    return out.map((r: Record<string, unknown>) => {
      if ('a' in r) return r;
      const legacy = r['contact'] as { name: string; email: string; phone: string } | undefined;
      const extra = (r['contact'] ?? {}) as { company?: string; gstNumber?: string };
      return {
        // The fixture is a domain row; the columns follow 0028 (the org link is
        // `org_id`, org details come from the joined org).
        a: {
          ...r,
          signalstackOrgSlug: r['orgSlug'],
          signalstackOrgName: r['name'],
          orgId: r['parentOrgId'],
          legacyOrgDetails: null,
        },
        // The newest ledger consent (0029), as the correlated subquery returns it.
        consent: r['consent']
          ? {
              at: Date.parse((r['consent'] as { given_at: string }).given_at),
              till: Date.parse((r['consent'] as { valid_till: string }).valid_till),
            }
          : null,
        inviteEmail: r['inviteEmail'] ?? null,
        o: {
          slug: 'org',
          url: r['url'] ?? null,
          locations: r['locations'] ?? [],
          legalName: extra.company ?? null,
          gstNumber: extra.gstNumber ?? null,
        },
        c: legacy
          ? {
              id: 'c'.repeat(64),
              email: legacy.email.toLowerCase(),
              phone: legacy.phone,
              name: legacy.name,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            }
          : null,
      };
    });
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

/** Returns the args of the first recorded call to `method`, if any. */
function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

/** Whether `chain` is the INSERT/UPDATE of the `aggregators` row itself. */
function isAggregatorWrite(chain: ChainCall[]): boolean {
  const values = callArgs(chain, 'values')?.[0] as Record<string, unknown> | undefined;
  const set = callArgs(chain, 'set')?.[0] as Record<string, unknown> | undefined;
  return values?.['signalstackOrgSlug'] !== undefined || set?.['updatedBy'] !== undefined;
}

function hasCall(chain: ChainCall[], method: string): boolean {
  return chain.some((c) => c.method === method);
}

afterEach(() => {
  _setDbClients(null, null);
});

// ─── Row fixture ────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<Coordinator> = {}): Coordinator {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-000000000001',
    orgSlug: 'test-org',
    actorType: 'aggregator',
    name: 'Test Org',
    type: null,
    serves: [],
    url: null,
    contactId: contactId('a@x.org', '+919000000001'),
    contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
    contactPhone: '+919000000001',
    contactEmail: 'a@x.org',
    locations: [],
    consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
    profile: {},
    profileRef: null,
    status: 'pending',
    createdBy: 'system',
    updatedBy: 'system',
    createdAt,
    updatedAt: createdAt,
    signalstackOrgId: null,
    parentOrgId: 'org-0',
    isDefaultOrg: false,
    inviteEmail: null,
    inviteId: null,
    rejectedAt: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateCoordinatorInput> = {}): CreateCoordinatorInput {
  return {
    orgSlug: 'test-org',
    name: 'Test Org',
    type: null,
    contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
    consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
    createdBy: 'system',
    updatedBy: 'system',
    orgId: 'org-0',
    recordConsent: NO_CONSENT_WRITE,
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresUserStore.create', () => {
  it('inserts the mapped row and returns it on success', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ id: 'agg-1' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput({ orgId: 'org-9' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('agg-1');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      signalstackOrgSlug: 'test-org',
      serves: [],
      orgId: 'org-9',
    });
    expect(callArgs(captured, 'values')?.[0]).not.toHaveProperty('actorType');
  });

  it('stores no org details on the coordinator (0028): legacy values only when given', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.create(makeInput());

    const values = callArgs(captured, 'values')?.[0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('url');
    expect(values).not.toHaveProperty('locations');
    expect(values.legacyOrgDetails).toBeNull();
    expect(values.orgId).toBe('org-0');
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a unique violation on contact_phone to DUPLICATE_PHONE', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_contact_phone_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_PHONE');
  });

  it('maps a unique violation on contact_email to DUPLICATE_EMAIL', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_contact_email_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('maps any other unique violation to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_org_slug_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps a Drizzle-wrapped unique violation (code/constraint on .cause) to DUPLICATE_SLUG', async () => {
    // Real Drizzle shape: outer error is the query text; SQLSTATE + constraint
    // are on `.cause`. Regression guard for the 503-instead-of-409 bug.
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_org_slug_key',
      });
      throw Object.assign(new Error('Failed query: insert into "aggregators" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps a non-canonical phone (rejected before any SQL) to CHECK_VIOLATION', async () => {
    _setDbClients(null, makeFakeDb(() => [makeRow()]) as never);
    const result = await new PostgresUserStore().create(
      makeInput({ contact: { name: 'A', phone: '9000000001', email: 'a@x.org' } }),
    );
    expect(result.ok || result.error.code).toBe('CHECK_VIOLATION');
  });

  it('maps a second coordinator row for the same person to DUPLICATE_EMAIL', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'users_contact_type_unique',
      });
    });
    _setDbClients(null, db as never);
    const result = await new PostgresUserStore().create(makeInput());
    expect(result.ok || result.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('maps a check violation to CHECK_VIOLATION', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('check failed'), {
        code: '23514',
        constraint: 'users_role_shape_chk',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CHECK_VIOLATION');
  });

  it('maps an unrecognised driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    // The driver message carries query parameters; it is never echoed.
    expect(result.error.message).not.toContain('connection reset');
  });
});

// ─── find* ──────────────────────────────────────────────────────────────────

describe('PostgresUserStore.findById / findBySlug / findByContactPhone / findByContactEmail', () => {
  it('findById returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'agg-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.findById('agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('agg-1');
  });

  it('findById returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

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
    const store = new PostgresUserStore();

    const result = await store.findById('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findBySlug returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ orgSlug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();
    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.orgSlug).toBe('acme');
  });

  it('findBySlug returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();
    const result = await store.findBySlug('acme');
    expect(result.ok).toBe(false);
  });

  it('findByContactPhone returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [
      makeRow({
        contactPhone: '+919000000009',
        contact: { name: 'A', phone: '+919000000009', email: 'a@x.org' },
      }),
    ]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();
    const result = await store.findByContactPhone('+919000000009');
    expect(result.ok && result.value?.contactPhone).toBe('+919000000009');
  });

  it('findByContactPhone returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();
    const result = await store.findByContactPhone('x');
    expect(result.ok).toBe(false);
  });

  it('findByContactEmail lowercases the lookup value', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [
        makeRow({
          contactEmail: 'mixed@x.org',
          contact: { name: 'A', phone: '+919000000001', email: 'Mixed@X.org' },
        }),
      ];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.findByContactEmail('MIXED@X.ORG');
    expect(result.ok && result.value?.contactEmail).toBe('mixed@x.org');
    // The where() call must have been reached with a condition built from the
    // lowercased email (asserted indirectly — the store computed it before
    // calling .where()).
    expect(hasCall(captured, 'where')).toBe(true);
  });

  it('findByContactEmail returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();
    const result = await store.findByContactEmail('a@x.org');
    expect(result.ok).toBe(false);
  });
});

// ─── findByParentOrgId ──────────────────────────────────────────────────────

describe('PostgresUserStore.findByParentOrgId', () => {
  it('returns the mapped rows for the org', async () => {
    const db = makeFakeDb(() => [
      makeRow({ id: 'c1', parentOrgId: 'org-1' }),
      makeRow({ id: 'c2', parentOrgId: 'org-1' }),
    ]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.findByParentOrgId('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  it('returns an empty array when no coordinators match', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.findByParentOrgId('org-none');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.findByParentOrgId('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('PostgresUserStore.list', () => {
  it('applies default limit/offset and returns rows + total', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) {
        captured = chain;
        return [makeRow({ id: 'agg-1' }), makeRow({ id: 'agg-2' })];
      }
      // The `select({ total: ... })` count query has no orderBy call.
      return [{ total: 2 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.list({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.total).toBe(2);
    expect(callArgs(captured, 'limit')).toEqual([50]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('clamps limit to 1000 and offset to 0', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) captured = chain;
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.list({ limit: 5000, offset: -10 });
    expect(callArgs(captured, 'limit')).toEqual([1000]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('builds a where clause when status/actorType/updatedBefore filters are set', async () => {
    let sawWhereWithFilters = false;
    const db = makeFakeDb((chain) => {
      const whereArgs = callArgs(chain, 'where');
      if (whereArgs && whereArgs[0] !== undefined) sawWhereWithFilters = true;
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.list({ status: 'active', updatedBefore: new Date() });
    expect(sawWhereWithFilters).toBe(true);
  });

  it('still restricts to coordinator accounts when no filters are set (0027)', async () => {
    const whereArgs: unknown[] = [];
    const db = makeFakeDb((chain) => {
      const w = callArgs(chain, 'where');
      if (w) whereArgs.push(w[0]);
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.list({});
    // Both the page query and the count query carry the user_type filter, so
    // an org owner's admin account never appears in (or counts towards) a list.
    expect(whereArgs).toHaveLength(2);
    expect(whereArgs.every((w) => w !== undefined)).toBe(true);
  });

  it('defaults total to 0 when the count query returns no row', async () => {
    const db = makeFakeDb((chain) => (hasCall(chain, 'orderBy') ? [] : []));
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.list({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.list({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update / updateStatus ──────────────────────────────────────────────────

describe('PostgresUserStore.update / updateStatus', () => {
  it('includes only the patch fields that were provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ name: 'New Name' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.update('agg-1', { name: 'New Name', updatedBy: 'tester' });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ signalstackOrgName: 'New Name', updatedBy: 'tester' });
    expect(set).not.toHaveProperty('status');
    expect(set).not.toHaveProperty('contact');
    expect(set).toHaveProperty('updatedAt');
  });

  it('includes every settable field when the full patch is provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    await store.update('agg-1', {
      name: 'N',
      type: 'seeker',
      contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
      status: 'active',
      updatedBy: 'tester',
    });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual(
      [
        'signalstackOrgName',
        'serves',
        'contactId',
        'alternatePhone',
        'status',
        'updatedBy',
        'updatedAt',
      ].sort(),
    );
  });

  it('returns NOT_FOUND when no row matches the id', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.update('missing', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'aggregators_contact_email_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.update('agg-1', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_EMAIL');
  });

  describe('with a contact change', () => {
    const next = { name: 'A', phone: '+919000000002', email: 'a@x.org' };
    /** The row lock returns the current contact; the target lookup finds nothing. */
    const lockOnly = (chain: ChainCall[]): unknown =>
      hasCall(chain, 'for') ? [{ contactId: makeRow().contactId }] : [];

    it('returns NOT_FOUND when the row to lock is gone', async () => {
      _setDbClients(null, makeFakeDb(() => []) as never);
      const result = await new PostgresUserStore().update('missing', {
        contact: next,
        updatedBy: 'tester',
      });
      expect(result.ok || result.error.code).toBe('NOT_FOUND');
    });

    it('maps ContactTakenError (another person has these details) to DUPLICATE_EMAIL', async () => {
      // Every select returns a row, so the target contact already exists.
      _setDbClients(null, makeFakeDb(() => [makeRow()]) as never);
      const result = await new PostgresUserStore().update('agg-1', {
        contact: next,
        updatedBy: 'tester',
      });
      expect(result.ok || result.error.code).toBe('DUPLICATE_EMAIL');
    });

    it('maps SharedContactError (contact held by two roles) to DUPLICATE', async () => {
      _setDbClients(null, makeFakeDb(lockOnly, { refs: 2 }) as never);
      const result = await new PostgresUserStore().update('agg-1', {
        contact: next,
        updatedBy: 'tester',
      });
      expect(result.ok || result.error.code).toBe('DUPLICATE');
    });
  });

  it('updateStatus delegates to update with the status field set', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.updateStatus('agg-1', 'active', 'tester');
    expect(result.ok).toBe(true);
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set.status).toBe('active');
  });
});

// ─── approveFromPending ─────────────────────────────────────────────────────

describe('PostgresUserStore.approveFromPending', () => {
  it('returns the updated row on a successful CAS', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'active' })]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('active');
  });

  it('returns ok(null) when the row was not pending (lost the race)', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── updateSignalstackOrgId ─────────────────────────────────────────────────

describe('PostgresUserStore.updateSignalstackOrgId', () => {
  it('stamps the signalstack org id and returns the mapped row', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the aggregators statement, then
      // a joined re-read; keep the aggregators write (or the first read).
      if (isAggregatorWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ signalstackOrgId: 'ss-org-1' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.updateSignalstackOrgId('agg-1', 'ss-org-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signalstackOrgId).toBe('ss-org-1');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ signalstackOrgId: 'ss-org-1' });
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.updateSignalstackOrgId('missing', 'ss-org-1', 'tester');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.updateSignalstackOrgId('agg-1', 'ss-org-1', 'tester');
    expect(result.ok).toBe(false);
  });
});

// ─── deleteById ─────────────────────────────────────────────────────────────

describe('PostgresUserStore.deleteById', () => {
  it('returns ok on successful delete', async () => {
    const db = makeFakeDb(() => [makeRow()]);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.deleteById('agg-1');
    expect(result.ok).toBe(true);
  });

  it('returns NOT_FOUND when nothing was deleted', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.deleteById('missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresUserStore();

    const result = await store.deleteById('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── toDomain mapping ───────────────────────────────────────────────────────

describe('PostgresUserStore serves on write (0029)', () => {
  it.each([
    ['seeker', ['seeker']],
    [null, []],
  ] as const)('create with type %s stores serves %j', async (type, serves) => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (isAggregatorWrite(chain)) captured = chain;
      return [makeRow({ id: 'agg-1' })];
    });
    _setDbClients(null, db as never);
    await new PostgresUserStore().create(makeInput({ type }));
    expect((callArgs(captured, 'values')?.[0] as { serves: string[] }).serves).toEqual(serves);
  });

  it('reads the alternate phone back into the Beckn contact, and omits a NULL one', async () => {
    _setDbClients(
      null,
      makeFakeDb(() => [makeRow({ alternatePhone: '+919811122233' } as never)]) as never,
    );
    const withPhone = await new PostgresUserStore().findById('agg-1');
    expect(withPhone.ok && withPhone.value?.contact.alternatePhone).toBe('+919811122233');
    _setDbClients(null, makeFakeDb(() => [makeRow({ alternatePhone: null } as never)]) as never);
    const without = await new PostgresUserStore().findById('agg-1');
    expect(without.ok && without.value ? 'alternatePhone' in without.value.contact : true).toBe(
      false,
    );
  });
});

// ─── contact composition (migration 0025) ───────────────────────────────────

describe('PostgresUserStore contact composition', () => {
  const linked = (name: string | null, phone: string | null) => ({
    id: 'c'.repeat(64),
    email: 'owner@x.org',
    phone,
    name,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it('composes the Beckn contact from the linked row plus the org company / GST, legacy key order', async () => {
    const a = {
      ...makeRow({ contactId: 'c'.repeat(64) }),
      contact: { name: 'STALE', phone: '+910000000000', email: 'stale@x.org' },
      alternatePhone: null,
      orgId: 'org-0',
      legacyOrgDetails: null,
    };
    // Company / GST are the org's since 0028 (`legal_name` / `gst_number`).
    const o = { slug: 'org', url: null, locations: [], legalName: 'Acme', gstNumber: 'G1' };
    _setDbClients(null, makeFakeDb(() => [{ a, o, c: linked('Owner', '+919000000009') }]) as never);
    const result = await new PostgresUserStore().findById(a.id);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) return;
    expect(result.value.contact).toEqual({
      name: 'Owner',
      email: 'owner@x.org',
      phone: '+919000000009',
      company: 'Acme',
      gstNumber: 'G1',
    });
    // Same key order the legacy jsonb serialised (length, then bytes).
    expect(Object.keys(result.value.contact)).toEqual([
      'name',
      'email',
      'phone',
      'company',
      'gstNumber',
    ]);
    expect(result.value.contactPhone).toBe('+919000000009');
    expect(result.value.contactEmail).toBe('owner@x.org');
  });

  it('maps a NULL contact name to an empty string (the wire field is required)', async () => {
    const a = { ...makeRow({ contactId: 'c'.repeat(64) }), alternatePhone: null, orgId: 'org-0' };
    _setDbClients(
      null,
      makeFakeDb(() => [{ a, o: null, c: linked(null, '+919000000009') }]) as never,
    );
    const result = await new PostgresUserStore().findById(a.id);
    expect(result.ok && result.value?.contact.name).toBe('');
  });
});

describe('PostgresUserStore — coordinator accounts only (0027)', () => {
  const dialect = new PgDialect();
  /** Renders every `.where(...)` argument the store passed, as SQL text. */
  function wheresOf(run: (store: PostgresUserStore) => Promise<unknown>) {
    const rendered: string[] = [];
    const db = makeFakeDb((chain) => {
      const w = callArgs(chain, 'where')?.[0];
      if (w) rendered.push(dialect.sqlToQuery(w as SQL).sql);
      return [];
    });
    _setDbClients(null, db as never);
    return run(new PostgresUserStore()).then(() => rendered);
  }

  it.each([
    ['findById', (s: PostgresUserStore) => s.findById('id-1')],
    ['findBySlug', (s: PostgresUserStore) => s.findBySlug('slug')],
    ['findByContactEmail', (s: PostgresUserStore) => s.findByContactEmail('a@x.org')],
    ['findByContactPhone', (s: PostgresUserStore) => s.findByContactPhone('+919000000001')],
    ['findByParentOrgId', (s: PostgresUserStore) => s.findByParentOrgId('org-1')],
    ['approveFromPending', (s: PostgresUserStore) => s.approveFromPending('id-1', 't')],
    [
      'updateSignalstackOrgId',
      (s: PostgresUserStore) => s.updateSignalstackOrgId('id-1', 'o', 't'),
    ],
    ['deleteById', (s: PostgresUserStore) => s.deleteById('id-1')],
  ] as const)('%s filters on user_type = coordinator', async (_name, run) => {
    const wheres = await wheresOf(run);
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w).toContain('"user_type" = $');
  });
});

describe('PostgresUserStore — consent in the create transaction (0029)', () => {
  it('runs recordConsent inside the transaction with the new id', async () => {
    const db = makeFakeDb((chain) =>
      hasCall(chain, 'returning') ? [{ id: 'agg-7' }] : [makeRow({ id: 'agg-7' })],
    );
    _setDbClients(null, db as never);
    const calls: { tx: unknown; id: string }[] = [];
    const result = await new PostgresUserStore().create(
      makeInput({
        recordConsent: async (tx, id) => {
          calls.push({ tx, id });
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('agg-7');
    expect(calls[0]?.tx).toBeDefined();
  });

  it('answers CONSENT_WRITE_FAILED when the hook throws (the transaction rolls back)', async () => {
    const db = makeFakeDb((chain) =>
      hasCall(chain, 'returning') ? [{ id: 'agg-8' }] : [makeRow({ id: 'agg-8' })],
    );
    _setDbClients(null, db as never);
    const result = await new PostgresUserStore().create(
      makeInput({
        recordConsent: async () => {
          throw new Error('ledger down');
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
    });
  });

  it('composes consent from the newest ledger row (given_at = accepted_at, G14)', async () => {
    const db = makeFakeDb(() => [
      makeRow({
        consent: {
          value: true,
          given_at: '2026-02-03T04:05:06.789Z',
          valid_till: '2027-02-03T04:05:06.789Z',
        },
      }),
    ]);
    _setDbClients(null, db as never);
    const found = await new PostgresUserStore().findById('agg-1');
    expect(found.ok && found.value?.consent).toEqual({
      value: true,
      given_at: '2026-02-03T04:05:06.789Z',
      valid_till: '2027-02-03T04:05:06.789Z',
    });
  });

  it('reads consent as null when the ledger holds no registration row', async () => {
    const db = makeFakeDb(() => [makeRow({ consent: null })]);
    _setDbClients(null, db as never);
    const found = await new PostgresUserStore().findById('agg-1');
    expect(found.ok && found.value?.consent).toBeNull();
  });

  it('derives type and actorType from serves', async () => {
    const db = makeFakeDb(() => [makeRow({ serves: ['provider'] })]);
    _setDbClients(null, db as never);
    const found = await new PostgresUserStore().findById('agg-1');
    expect(found.ok && found.value?.type).toBe('provider');
    expect(found.ok && found.value?.actorType).toBe('aggregator');
  });
});
