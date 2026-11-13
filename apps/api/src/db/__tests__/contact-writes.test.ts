/**
 * Unit tests for the application-side `contact` writes (`db/contact-writes.ts`,
 * `@aggregator-dpg/api`).
 *
 * A recording fake stands in for the Drizzle executor, so these tests pin the
 * statement sequence and every branch (re-key, refusal, re-insert) without a
 * database. The same functions run against real Postgres, with the real unique
 * indexes and triggers, in `contact.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import {
  changeContact,
  ContactTakenError,
  linkContact,
  SharedContactError,
  splitBecknContact,
  type DbExecutor,
} from '../contact-writes.js';

const dialect = new PgDialect();

/** One statement the code under test issued. */
interface Statement {
  kind: 'insert' | 'update' | 'select' | 'execute';
  /** Chained builder calls, e.g. `['values', {...}]`. */
  calls: Array<[string, unknown]>;
  /** SQL text, for `execute`. */
  text?: string;
}

interface FakeOptions {
  /** Rows returned by each successive `FOR KEY SHARE` hold (default: one row). */
  holds?: number[];
  /** Whether `select … where id = newId` finds a contact. */
  targetExists?: boolean;
  /** Reference count returned for the old contact (default 1). */
  refs?: number;
}

/**
 * Builds a fake executor that records statements. Each builder method returns
 * a real Promise carrying the chain methods, so awaiting it at any point
 * resolves the scripted result.
 */
function fakeDb(opts: FakeOptions = {}): { db: DbExecutor; log: Statement[] } {
  const log: Statement[] = [];
  const holds = [...(opts.holds ?? [1])];

  const builder = (stmt: Statement, result: unknown): Promise<unknown> => {
    const p = Promise.resolve(result);
    const methods = ['values', 'onConflictDoNothing', 'set', 'where', 'from'];
    for (const m of methods) {
      Object.defineProperty(p, m, {
        value: (arg: unknown) => {
          stmt.calls.push([m, arg]);
          return p;
        },
      });
    }
    return p;
  };

  const db = {
    insert: () => {
      const stmt: Statement = { kind: 'insert', calls: [] };
      log.push(stmt);
      return builder(stmt, undefined);
    },
    update: () => {
      const stmt: Statement = { kind: 'update', calls: [] };
      log.push(stmt);
      return builder(stmt, undefined);
    },
    select: () => {
      const stmt: Statement = { kind: 'select', calls: [] };
      log.push(stmt);
      return builder(stmt, opts.targetExists ? [{ id: 'x' }] : []);
    },
    execute: (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      log.push({ kind: 'execute', calls: [], text });
      if (text.includes('FOR KEY SHARE')) {
        const n = holds.length > 0 ? (holds.shift() ?? 1) : 1;
        return Promise.resolve({ rows: Array.from({ length: n }, () => ({})) });
      }
      if (text.includes('count(*)')) return Promise.resolve({ rows: [{ n: opts.refs ?? 1 }] });
      return Promise.resolve({ rows: [] });
    },
  };
  return { db: db as unknown as DbExecutor, log };
}

/** Every `set(...)` argument, in statement order. */
function setArgs(log: Statement[]): unknown[] {
  return log.flatMap((s) => s.calls.filter(([m]) => m === 'set').map(([, a]) => a));
}

const PHONE = '+919000000001';
const NEW_PHONE = '+919000000002';

describe('splitBecknContact', () => {
  it('separates identity from the optional Beckn keys', () => {
    const out = splitBecknContact({
      name: 'Asha',
      email: 'a@x.org',
      phone: PHONE,
      alternatePhone: '+919000000009',
      company: 'Acme',
      gstNumber: 'G1',
    });
    expect(out.identity).toEqual({ email: 'a@x.org', phone: PHONE, name: 'Asha' });
    expect(out.extra).toEqual({
      alternatePhone: '+919000000009',
      company: 'Acme',
      gstNumber: 'G1',
    });
  });

  it('omits extras that are absent (no undefined keys)', () => {
    const out = splitBecknContact({ name: 'Asha', email: 'a@x.org', phone: PHONE });
    expect(out.extra).toEqual({});
    expect(Object.keys(out.extra)).toHaveLength(0);
  });
});

describe('linkContact', () => {
  it('inserts, names a nameless contact, holds it, and returns the hash id', async () => {
    const { db, log } = fakeDb();
    const id = await linkContact(db, { email: ' A@X.org ', phone: PHONE, name: 'Asha' });
    expect(id).toBe(contactId('a@x.org', PHONE));
    expect(log.map((s) => s.kind)).toEqual(['insert', 'update', 'execute']);
    expect(setArgs(log)).toEqual([{ name: 'Asha' }]);
  });

  it('skips the name update for a blank name', async () => {
    const { db, log } = fakeDb();
    await linkContact(db, { email: 'a@x.org', phone: PHONE, name: '  ' });
    expect(log.map((s) => s.kind)).toEqual(['insert', 'execute']);
  });

  it('re-creates and re-holds the contact when it vanished before the hold', async () => {
    const { db, log } = fakeDb({ holds: [0, 1] });
    await linkContact(db, { email: 'a@x.org', phone: PHONE, name: null });
    expect(log.map((s) => s.kind)).toEqual(['insert', 'execute', 'insert', 'execute']);
  });

  it('rejects a non-canonical phone before any statement', async () => {
    const { db, log } = fakeDb();
    await expect(
      linkContact(db, { email: 'a@x.org', phone: '9000000001', name: null }),
    ).rejects.toThrow(TypeError);
    expect(log).toHaveLength(0);
  });
});

describe('changeContact', () => {
  const oldId = contactId('a@x.org', PHONE);

  it('only renames when the email and phone are unchanged', async () => {
    const { db, log } = fakeDb();
    const id = await changeContact(db, oldId, { email: 'A@x.org', phone: PHONE, name: 'New' });
    expect(id).toBe(oldId);
    expect(log.map((s) => s.kind)).toEqual(['update']);
    expect(setArgs(log)).toEqual([{ name: 'New' }]);
  });

  it('does nothing when the details and name are unchanged', async () => {
    const { db, log } = fakeDb();
    const id = await changeContact(db, oldId, { email: 'a@x.org', phone: PHONE, name: null });
    expect(id).toBe(oldId);
    expect(log).toHaveLength(0);
  });

  it('re-keys the contact in place and returns the new id', async () => {
    const { db, log } = fakeDb();
    const id = await changeContact(db, oldId, { email: 'a@x.org', phone: NEW_PHONE, name: 'Asha' });
    expect(id).toBe(contactId('a@x.org', NEW_PHONE));
    expect(log.map((s) => s.kind)).toEqual(['execute', 'select', 'execute', 'update']);
    expect(log[0]?.text).toContain('FOR UPDATE');
    expect(setArgs(log)).toEqual([{ id, email: 'a@x.org', phone: NEW_PHONE, name: 'Asha' }]);
  });

  it('keeps the stored name when re-keying without one', async () => {
    const { db, log } = fakeDb();
    await changeContact(db, oldId, { email: 'a@x.org', phone: NEW_PHONE, name: null });
    expect(setArgs(log)[0]).not.toHaveProperty('name');
  });

  it('refuses to move onto another person’s contact (ContactTakenError)', async () => {
    const { db, log } = fakeDb({ targetExists: true });
    const change = changeContact(db, oldId, { email: 'b@x.org', phone: NEW_PHONE, name: null });
    await expect(change).rejects.toBeInstanceOf(ContactTakenError);
    await expect(change).rejects.toThrow('already belong to another person');
    expect(log.some((s) => s.kind === 'update')).toBe(false);
  });

  it('refuses to change a contact shared by two roles (SharedContactError)', async () => {
    const { db, log } = fakeDb({ refs: 2 });
    const change = changeContact(db, oldId, { email: 'a@x.org', phone: NEW_PHONE, name: null });
    await expect(change).rejects.toBeInstanceOf(SharedContactError);
    await expect(change).rejects.toThrow('shared by another role');
    expect(log.some((s) => s.kind === 'update')).toBe(false);
  });
});
