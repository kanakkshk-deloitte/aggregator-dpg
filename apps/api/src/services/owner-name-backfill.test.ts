import { afterEach, describe, it, expect } from 'vitest';
import { IdpAdminFake } from './idp-admin/testing.js';
import { _setDbClients } from '../db/client.js';
import {
  backfillOwnerContactNames,
  listOwnerNameCandidatesFromDb,
  setContactNameIfMissingInDb,
  type OwnerNameCandidate,
} from './owner-name-backfill.js';
import type { IdpResult, IdpUser } from './idp-admin/interface.js';

/** Fake that answers `findById` from a scripted table. */
class ScriptedIdp extends IdpAdminFake {
  constructor(private readonly answers: Record<string, Array<IdpResult<IdpUser | null>>>) {
    super();
  }
  override async findById(userId: string): Promise<IdpResult<IdpUser | null>> {
    const queue = this.answers[userId] ?? [{ ok: true, value: null }];
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }
}

const user = (over: Partial<IdpUser> = {}): IdpUser => ({
  id: 'kc-1',
  email: 'o@x.org',
  username: 'o@x.org',
  enabled: true,
  ...over,
});

function run(
  idp: ScriptedIdp,
  candidates: OwnerNameCandidate[],
  dryRun = false,
  existingNames: Record<string, string> = {},
) {
  const written: Record<string, string> = { ...existingNames };
  return backfillOwnerContactNames(
    {
      idp,
      listCandidates: async () => candidates,
      setNameIfMissing: async (id, name) => {
        if (written[id]) return false;
        written[id] = name;
        return true;
      },
      retryDelayMs: 0,
    },
    { dryRun },
  ).then((report) => ({ report, written }));
}

const cand = (n: number): OwnerNameCandidate => ({
  orgId: `org-${n}`,
  contactId: `c${n}`,
  ownerKcSub: `kc-${n}`,
});

describe('backfillOwnerContactNames', () => {
  it('writes first + last name from Keycloak', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [{ ok: true, value: user({ firstName: 'Ravi', lastName: 'Kumar' }) }],
    });
    const { report, written } = await run(idp, [cand(1)]);
    expect(written).toEqual({ c1: 'Ravi Kumar' });
    expect(report).toMatchObject({ candidates: 1, updated: 1, failed: 0 });
  });

  it('dry-run counts but never writes', async () => {
    const idp = new ScriptedIdp({ 'kc-1': [{ ok: true, value: user({ firstName: 'Ravi' }) }] });
    const { report, written } = await run(idp, [cand(1)], true);
    expect(written).toEqual({});
    expect(report).toMatchObject({ updated: 1, dryRun: true });
  });

  it('keeps an existing name (idempotent re-run)', async () => {
    const idp = new ScriptedIdp({ 'kc-1': [{ ok: true, value: user({ firstName: 'New' }) }] });
    const { report, written } = await run(idp, [cand(1)], false, { c1: 'Existing' });
    expect(written).toEqual({ c1: 'Existing' });
    expect(report.updated).toBe(0);
  });

  it('skips a Keycloak user with no name, and a missing user', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [{ ok: true, value: user({ firstName: '  ' }) }],
      'kc-2': [{ ok: true, value: null }],
    });
    const { report } = await run(idp, [cand(1), cand(2)]);
    expect(report).toMatchObject({ candidates: 2, updated: 0, noName: 1, userMissing: 1 });
  });

  it('retries a transient Keycloak failure once', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [
        { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'timeout' } },
        { ok: true, value: user({ lastName: 'Only' }) },
      ],
    });
    const { report, written } = await run(idp, [cand(1)]);
    expect(written).toEqual({ c1: 'Only' });
    expect(report.failed).toBe(0);
  });

  it('counts a failure that persists after the retry', async () => {
    const down: IdpResult<IdpUser | null> = {
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'down' },
    };
    const idp = new ScriptedIdp({ 'kc-1': [down, down] });
    const { report } = await run(idp, [cand(1)]);
    expect(report.failed).toBe(1);
  });

  it('counts a failed write and continues with the next candidate', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [{ ok: true, value: user({ firstName: 'A' }) }],
      'kc-2': [{ ok: true, value: user({ firstName: 'B' }) }],
    });
    const written: string[] = [];
    const report = await backfillOwnerContactNames(
      {
        idp,
        listCandidates: async () => [cand(1), cand(2)],
        setNameIfMissing: async (id) => {
          if (id === 'c1') throw new Error('db blip');
          written.push(id);
          return true;
        },
        retryDelayMs: 0,
      },
      { dryRun: false },
    );
    expect(report).toMatchObject({ failed: 1, updated: 1 });
    expect(written).toEqual(['c2']);
  });

  it('handles an empty candidate list', async () => {
    const { report } = await run(new ScriptedIdp({}), []);
    expect(report).toMatchObject({ candidates: 0, updated: 0 });
  });
});

/**
 * A Drizzle-shaped fake whose every query resolves to `rows`; records the
 * chained method names so a test can assert the query shape.
 */
function fakeDb(rows: unknown[]): { db: unknown; calls: string[] } {
  const calls: string[] = [];
  const chain = (): Promise<unknown[]> => {
    const p = Promise.resolve(rows);
    for (const m of ['from', 'innerJoin', 'where', 'set', 'returning']) {
      Object.defineProperty(p, m, {
        value: () => {
          calls.push(m);
          return p;
        },
      });
    }
    return p;
  };
  const db = {
    select: () => {
      calls.push('select');
      return chain();
    },
    update: () => {
      calls.push('update');
      return chain();
    },
  };
  return { db, calls };
}

describe('owner-name backfill database helpers', () => {
  afterEach(() => _setDbClients(null, null));

  it('lists orgs whose contact has no name, dropping any row without a Keycloak owner', async () => {
    const { db, calls } = fakeDb([
      { orgId: 'o1', contactId: 'c1', ownerKcSub: 'kc-1' },
      { orgId: 'o2', contactId: 'c2', ownerKcSub: null },
    ]);
    _setDbClients(null, db as never);
    await expect(listOwnerNameCandidatesFromDb()).resolves.toEqual([
      { orgId: 'o1', contactId: 'c1', ownerKcSub: 'kc-1' },
    ]);
    // org → owner account → contact → IdP login (0027).
    expect(calls).toEqual(['select', 'from', 'innerJoin', 'innerJoin', 'innerJoin', 'where']);
  });

  it('reports whether the name was written (only while it is still NULL)', async () => {
    const written = fakeDb([{ id: 'c1' }]);
    _setDbClients(null, written.db as never);
    await expect(setContactNameIfMissingInDb('c1', 'Asha')).resolves.toBe(true);
    expect(written.calls).toEqual(['update', 'set', 'where', 'returning']);

    _setDbClients(null, fakeDb([]).db as never);
    await expect(setContactNameIfMissingInDb('c1', 'Asha')).resolves.toBe(false);
  });
});
