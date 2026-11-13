/**
 * Unit tests for PostgresRegistrationLinksStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * create/list/updateDraft/error-mapping logic in `postgres.ts` without a live
 * database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresRegistrationLinksStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import type { CreateRegistrationLinkInput, RegistrationLink } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeFakeDb(resolve: (chain: ChainCall[]) => unknown): unknown {
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string | symbol) {
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

function hasCall(chain: ChainCall[], method: string): boolean {
  return chain.some((c) => c.method === method);
}

afterEach(() => {
  _setDbClients(null, null);
});

function makeRow(overrides: Partial<RegistrationLink> = {}): RegistrationLink {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: 'link-1',
    aggregatorId: 'agg-1',
    slug: 'my-link',
    domain: 'seeker',
    context: {},
    registrationMode: 'form',
    qrObjectKey: null,
    status: 'draft',
    expiresAt: null,
    createdBy: 'system',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<CreateRegistrationLinkInput> = {},
): CreateRegistrationLinkInput {
  return {
    aggregatorId: 'agg-1',
    slug: 'my-link',
    domain: 'seeker',
    context: {},
    createdBy: 'system',
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresRegistrationLinksStore.create', () => {
  it('inserts with draft/form defaults and returns the mapped row', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ id: 'link-9' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('link-9');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      status: 'draft',
      registrationMode: 'form',
      expiresAt: null,
    });
  });

  it('honours an explicit status/registrationMode/expiresAt', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const expiresAt = new Date('2026-06-01T00:00:00Z');
    await store.create(makeInput({ status: 'live', registrationMode: 'qr_only', expiresAt }));

    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      status: 'live',
      registrationMode: 'qr_only',
      expiresAt,
    });
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a unique violation to SLUG_COLLISION', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SLUG_COLLISION');
  });

  it('maps a Drizzle-wrapped unique violation (code on .cause) to SLUG_COLLISION', async () => {
    // Drizzle throws a DrizzleQueryError whose driver `code` sits on `.cause`,
    // not the top-level error — the mapping must walk the cause chain, else a
    // duplicate slug masquerades as DB_UNAVAILABLE and the route's retry never
    // fires (surfacing a misleading 503 instead of allocating a fresh slug).
    const db = makeFakeDb(() => {
      const driverErr = Object.assign(new Error('duplicate key value'), { code: '23505' });
      throw Object.assign(new Error('Failed query: insert into ...'), { cause: driverErr });
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SLUG_COLLISION');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    expect(result.error.message).toContain('connection reset');
  });
});

// ─── findBySlug / findByOrgAndSlug / findById ──────────────────────────────

describe('PostgresRegistrationLinksStore.findBySlug', () => {
  it('returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ slug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.slug).toBe('acme');
  });

  it('returns null when not found', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findBySlug('missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findBySlug('acme');
    expect(result.ok).toBe(false);
  });
});

describe('PostgresRegistrationLinksStore.findByOrgAndSlug', () => {
  it('joins on org slug and unwraps the { link } projection', async () => {
    const db = makeFakeDb(() => [{ link: makeRow({ id: 'link-42' }) }]);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findByOrgAndSlug('acme-org', 'my-link');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('link-42');
  });

  it('returns null when the join yields no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findByOrgAndSlug('acme-org', 'missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findByOrgAndSlug('acme-org', 'x');
    expect(result.ok).toBe(false);
  });
});

describe('PostgresRegistrationLinksStore.findById', () => {
  it('returns the mapped row scoped to the aggregator', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'link-1', aggregatorId: 'agg-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findById('link-1', 'agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('link-1');
  });

  it('returns null when not found', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findById('missing', 'agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findById('link-1', 'agg-1');
    expect(result.ok).toBe(false);
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('PostgresRegistrationLinksStore.list', () => {
  it('returns rows + total, filtering by status when given', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) {
        captured = chain;
        return [makeRow({ status: 'live' }), makeRow({ status: 'live' })];
      }
      return [{ count: 2 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.list('agg-1', { status: 'live', limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.total).toBe(2);
    expect(callArgs(captured, 'limit')).toEqual([10]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('omits the status filter when not given', async () => {
    const db = makeFakeDb((chain) => (hasCall(chain, 'orderBy') ? [] : [{ count: 0 }]));
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
  });

  it('defaults total to 0 when the count query returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── updateDraft ────────────────────────────────────────────────────────────

describe('PostgresRegistrationLinksStore.updateDraft', () => {
  it('includes only the patch fields that were provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ slug: 'new-slug' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateDraft('link-1', 'agg-1', { slug: 'new-slug' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe('new-slug');
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ slug: 'new-slug' });
    expect(set).not.toHaveProperty('context');
    expect(set).not.toHaveProperty('expiresAt');
  });

  it('allows clearing expiresAt with an explicit null', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ expiresAt: null })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    await store.updateDraft('link-1', 'agg-1', { expiresAt: null });
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toHaveProperty('expiresAt', null);
  });

  it('returns NOT_FOUND when the row is not a draft (or missing)', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateDraft('link-1', 'agg-1', { slug: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a unique violation to SLUG_COLLISION', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateDraft('link-1', 'agg-1', { slug: 'dup' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SLUG_COLLISION');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateDraft('link-1', 'agg-1', { slug: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── updateStatus ───────────────────────────────────────────────────────────

describe('PostgresRegistrationLinksStore.updateStatus', () => {
  it('sets the new status and returns the mapped row', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ status: 'retired' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateStatus('link-1', 'agg-1', 'retired');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('retired');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'retired' });
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateStatus('missing', 'agg-1', 'retired');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.updateStatus('link-1', 'agg-1', 'retired');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── toDomain mapping ───────────────────────────────────────────────────────

describe('PostgresRegistrationLinksStore row → domain mapping', () => {
  it('falls back to "form" when registrationMode is not a string', async () => {
    const db = makeFakeDb(() => [makeRow({ registrationMode: undefined as never })]);
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationLinksStore();

    const result = await store.findBySlug('my-link');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.registrationMode).toBe('form');
  });
});
