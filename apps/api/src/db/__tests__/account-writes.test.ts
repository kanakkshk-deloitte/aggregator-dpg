/**
 * Unit tests for `db/account-writes.ts` (`@aggregator-dpg/api`): the admin
 * account link (explicit NULLs, hold-and-retry) and the identity link
 * outcomes. A scripted fake executor stands in for Drizzle; the same functions
 * run against real Postgres in `users.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  IdentityMismatchError,
  IdentityNotLinkableError,
  IdentityTakenError,
  linkAdminAccount,
  linkIdentity,
  subjectOf,
} from '../account-writes.js';
import type { DbExecutor } from '../contact-writes.js';

const dialect = new PgDialect();

interface Script {
  /** Rows for each successive `execute` call. */
  executes: Array<Array<Record<string, unknown>>>;
  /** Rows for each successive `select` chain. */
  selects?: Array<Array<Record<string, unknown>>>;
}

function fakeDb(script: Script): { db: DbExecutor; sql: string[] } {
  const sql: string[] = [];
  const executes = [...script.executes];
  const selects = [...(script.selects ?? [])];
  const chain = (rows: unknown): Promise<unknown> => {
    const p = Promise.resolve(rows);
    for (const m of ['from', 'where']) {
      Object.defineProperty(p, m, { value: () => p });
    }
    return p;
  };
  const db = {
    execute: (q: SQL) => {
      sql.push(dialect.sqlToQuery(q).sql);
      return Promise.resolve({ rows: executes.shift() ?? [] });
    },
    select: () => chain(selects.shift() ?? []),
  };
  return { db: db as unknown as DbExecutor, sql };
}

describe('linkAdminAccount', () => {
  it('inserts an identity-only admin row with explicit NULLs and holds it', async () => {
    const { db, sql } = fakeDb({ executes: [[], [{ id: 'admin-1' }]] });
    await expect(linkAdminAccount(db, 'c1')).resolves.toBe('admin-1');
    expect(sql[0]).toMatch(/INSERT INTO users/);
    expect(sql[0]).toMatch(/'admin', \$1, NULL, NULL, 'self'/);
    expect(sql[0]).toMatch(/ON CONFLICT \(contact_id, user_type\) DO NOTHING/);
    expect(sql[1]).toMatch(/FOR KEY SHARE/);
  });

  it('re-creates and re-holds the account when it vanished before the hold', async () => {
    const { db, sql } = fakeDb({ executes: [[], [], [], [{ id: 'admin-2' }]] });
    await expect(linkAdminAccount(db, 'c1')).resolves.toBe('admin-2');
    expect(sql).toHaveLength(4);
  });

  it('gives up after two attempts', async () => {
    const { db } = fakeDb({ executes: [[], [], [], []] });
    await expect(linkAdminAccount(db, 'c1')).rejects.toThrow(/could not be created or held/);
  });
});

describe('linkIdentity', () => {
  it('returns linked when the insert recorded it', async () => {
    const { db } = fakeDb({ executes: [[{ user_id: 'u1' }]] });
    await expect(linkIdentity(db, 'u1', 'keycloak', 's1')).resolves.toBe('linked');
  });

  it('returns already when this exact link exists', async () => {
    const { db } = fakeDb({ executes: [[]], selects: [[{ subject: 's1' }]] });
    await expect(linkIdentity(db, 'u1', 'keycloak', 's1')).resolves.toBe('already');
  });

  it('refuses to overwrite a different subject for the account', async () => {
    const { db } = fakeDb({ executes: [[]], selects: [[{ subject: 'other' }]] });
    await expect(linkIdentity(db, 'u1', 'keycloak', 's1')).rejects.toBeInstanceOf(
      IdentityMismatchError,
    );
  });

  it('reports a subject owned by another account', async () => {
    const { db } = fakeDb({ executes: [[], [{ ok: true }]], selects: [[]] });
    await expect(linkIdentity(db, 'u1', 'keycloak', 's1')).rejects.toBeInstanceOf(
      IdentityTakenError,
    );
  });

  it('refuses a missing or wrong-type account, filtering the insert by type', async () => {
    const { db, sql } = fakeDb({ executes: [[], [{ ok: false }]], selects: [[]] });
    await expect(linkIdentity(db, 'u1', 'keycloak', 's1', 'coordinator')).rejects.toBeInstanceOf(
      IdentityNotLinkableError,
    );
    expect(sql[0]).toMatch(/AND u\.user_type = \$\d/);
  });
});

describe('subjectOf', () => {
  it('returns the subject or null', async () => {
    expect(
      await subjectOf(
        fakeDb({ executes: [], selects: [[{ subject: 's1' }]] }).db,
        'u1',
        'keycloak',
      ),
    ).toBe('s1');
    expect(
      await subjectOf(fakeDb({ executes: [], selects: [[]] }).db, 'u1', 'keycloak'),
    ).toBeNull();
  });
});
