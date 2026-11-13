/**
 * Writes to the `contact` table (`@aggregator-dpg/api`).
 *
 * The user and org Postgres stores call these inside their own transaction, so
 * a contact and the row that references it are written together. They are
 * plain functions, not a store, so the transaction handle stays out of service interfaces.
 *
 * A clash with another person's email or phone raises the unique violation
 * (`contact_email_unique` / `contact_phone_unique`); the store maps it to
 * `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`.
 *
 * Contact ids are derived from PII. Never log them.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { contact } from './schema.js';
import type * as schema from './schema.js';

/** A Drizzle database or transaction handle. */
export type DbExecutor = Pick<
  NodePgDatabase<typeof schema>,
  'select' | 'insert' | 'update' | 'execute'
>;

/**
 * Thrown by {@link changeContact} when another row shares the contact (one
 * person in two roles). Changing it would also change the other role, and Keycloak would not follow.
 */
export class SharedContactError extends Error {
  constructor() {
    super('contact is shared by another role; changing its email or phone is not supported yet');
    this.name = 'SharedContactError';
  }
}

/**
 * Thrown by {@link changeContact} when the new email and phone already form
 * another person's contact. Contacts are never merged.
 */
export class ContactTakenError extends Error {
  constructor() {
    super('the email and phone already belong to another person');
    this.name = 'ContactTakenError';
  }
}

/** Splits a Beckn contact into identity (`contact`) and the optional extras. */
export function splitBecknContact(c: {
  name: string;
  email: string;
  phone: string;
  alternatePhone?: string | undefined;
  company?: string | undefined;
  gstNumber?: string | undefined;
}): {
  identity: ContactInput;
  extra: { alternatePhone?: string; company?: string; gstNumber?: string };
} {
  const extra: { alternatePhone?: string; company?: string; gstNumber?: string } = {};
  if (c.alternatePhone !== undefined) extra.alternatePhone = c.alternatePhone;
  if (c.company !== undefined) extra.company = c.company;
  if (c.gstNumber !== undefined) extra.gstNumber = c.gstNumber;
  return { identity: { email: c.email, phone: c.phone, name: c.name }, extra };
}

/** Identity + name of the person a row belongs to. */
export interface ContactInput {
  /** Any casing; stored lowercased and trimmed. */
  email: string;
  /** Canonical (`normalisePhone`) phone, or `null`. */
  phone: string | null;
  /** Display name, or `null` when not captured. */
  name: string | null;
}

/**
 * Keeps a name as submitted, turning a blank one into `null` (the table rejects blank names).
 */
function cleanName(name: string | null | undefined): string | null {
  return name?.trim() ? name : null;
}

/**
 * Returns the id of the contact for `input`, creating it when absent. An
 * existing contact keeps its name unless it has none.
 *
 * @param db - Executor (normally the caller's transaction).
 * @param input - The person's email / phone / name.
 * @returns The contact id.
 * @throws {TypeError} When the email is blank or the phone is not canonical.
 * @throws The driver's unique-violation error when the email or phone belongs
 *   to a different contact.
 */
export async function linkContact(db: DbExecutor, input: ContactInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const id = contactId(email, input.phone);
  const name = cleanName(input.name);
  // Conflict on the primary key only, so a clash on email or phone alone still raises.
  await db
    .insert(contact)
    .values({ id, email, phone: input.phone, name })
    .onConflictDoNothing({ target: contact.id });
  if (name) {
    await db
      .update(contact)
      .set({ name })
      .where(and(eq(contact.id, id), isNull(contact.name)));
  }
  // Hold the row until the transaction ends so contact_gc() cannot delete it
  // before the FK check. Recreate it if it vanished.
  const held = await db.execute(sql`SELECT 1 FROM contact WHERE id = ${id} FOR KEY SHARE`);
  if (held.rows.length === 0) {
    await db
      .insert(contact)
      .values({ id, email, phone: input.phone, name })
      .onConflictDoNothing({ target: contact.id });
    await db.execute(sql`SELECT 1 FROM contact WHERE id = ${id} FOR KEY SHARE`);
  }
  return id;
}

/**
 * Moves a row's contact to new details and returns the id the row must now
 * reference.
 *
 *   - same id           → name update only (an explicit update: new name wins)
 *   - target id exists  → {@link ContactTakenError} (another person's contact)
 *   - old contact shared with another row → {@link SharedContactError}
 *   - otherwise         → the old row is re-keyed in place; `ON UPDATE
 *                          CASCADE` moves every FK
 *
 * @param db - Executor (the caller's transaction).
 * @param oldId - The row's current contact id.
 * @param input - The new details.
 * @returns The contact id the row must reference afterwards.
 * @throws {SharedContactError} When another row shares the old contact.
 * @throws {ContactTakenError} When the new email + phone are another person's contact.
 * @throws The driver's unique-violation error on a clash with another person.
 */
export async function changeContact(
  db: DbExecutor,
  oldId: string,
  input: ContactInput,
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const newId = contactId(email, input.phone);
  const name = cleanName(input.name);

  if (oldId === newId) {
    if (name) await db.update(contact).set({ name }).where(eq(contact.id, newId));
    return newId;
  }
  // Lock the current contact so the shared check below stays true.
  await db.execute(sql`SELECT 1 FROM contact WHERE id = ${oldId} FOR UPDATE`);

  const [target] = await db.select({ id: contact.id }).from(contact).where(eq(contact.id, newId));
  if (target) {
    throw new ContactTakenError();
  }

  // Every contact reference is a `users` row; two rows mean one person in two roles.
  const refs = await db.execute<{ n: number }>(sql`
    SELECT count(*) AS n FROM users WHERE contact_id = ${oldId}`);
  const shared = Number(refs.rows[0]?.n ?? 0) > 1;
  if (shared) throw new SharedContactError();

  await db
    .update(contact)
    .set({
      id: newId,
      email,
      phone: input.phone,
      ...(name ? { name } : {}),
    })
    .where(eq(contact.id, oldId));
  return newId;
}
