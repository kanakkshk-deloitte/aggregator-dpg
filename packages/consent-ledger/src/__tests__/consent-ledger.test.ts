/**
 * Unit tests for InMemoryConsentLedger and ConsentLedgerFake.
 *
 * These tests exercise the in-memory implementation directly (same package,
 * per testing.md §5). ConsentLedgerFake is also exercised for the seed /
 * builder paths. All tests are pure in-memory — no real DB or network calls.
 *
 * @module @aggregator-dpg/consent-ledger
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryConsentLedger } from '../memory.js';
import { ConsentLedgerFake, buildConsentRecord } from '../testing.js';
import { RecordConsentInputSchema, ConsentRecordSchema } from '../interface.js';
import type { RecordConsentInput } from '../interface.js';
import { PostgresConsentLedger } from '../postgres.js';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<RecordConsentInput> = {}): RecordConsentInput {
  return {
    subjectType: 'user',
    subjectId: '11111111-1111-1111-1111-111111111111',
    network: 'blue_dot',
    brand: undefined,
    termsVersion: 1,
    privacyVersion: 1,
    ...overrides,
  };
}

// ─── RecordConsentInputSchema validation ─────────────────────────────────────

describe('RecordConsentInputSchema', () => {
  it('parses a valid aggregator input', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput());
    expect(result.success).toBe(true);
  });

  it('parses a valid org input with brand', () => {
    const result = RecordConsentInputSchema.safeParse(
      makeInput({
        subjectType: 'organisation',
        subjectId: '22222222-2222-2222-2222-222222222222',
        brand: 'purple_dot',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an invalid subjectType', () => {
    const result = RecordConsentInputSchema.safeParse(
      makeInput({ subjectType: 'unknown' as 'organisation' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID subjectId', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput({ subjectId: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty network', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput({ network: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects termsVersion below 1', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput({ termsVersion: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects privacyVersion below 1', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput({ privacyVersion: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-integer termsVersion', () => {
    const result = RecordConsentInputSchema.safeParse(makeInput({ termsVersion: 1.5 }));
    expect(result.success).toBe(false);
  });
});

// ─── ConsentRecordSchema validation ──────────────────────────────────────────

describe('ConsentRecordSchema', () => {
  it('parses a valid record', () => {
    const record = buildConsentRecord();
    const result = ConsentRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it('allows null brand', () => {
    const result = ConsentRecordSchema.safeParse(buildConsentRecord({ brand: null }));
    expect(result.success).toBe(true);
  });
});

// ─── InMemoryConsentLedger ────────────────────────────────────────────────────

describe('InMemoryConsentLedger.recordRegistrationConsent', () => {
  let ledger: InMemoryConsentLedger;

  beforeEach(() => {
    ledger = new InMemoryConsentLedger();
  });

  it('returns ok with the persisted record on success', async () => {
    const input = makeInput();
    const result = await ledger.recordRegistrationConsent(input);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.subjectType).toBe('user');
    expect(result.value.subjectId).toBe(input.subjectId);
    expect(result.value.termsVersion).toBe(1);
    expect(result.value.privacyVersion).toBe(1);
    expect(result.value.network).toBe('blue_dot');
    expect(result.value.source).toBe('registration');
  });

  it('defaults source to "registration" when omitted, else records the given source', async () => {
    const def = await ledger.recordRegistrationConsent(makeInput());
    expect(def.success && def.value.source).toBe('registration');

    // Bulk-upload attestation encodes the upload id + statement version here.
    const bulk = await ledger.recordRegistrationConsent(
      makeInput({
        subjectId: '33333333-3333-3333-3333-333333333333',
        source: 'bulk_upload:up-123:v1',
      }),
    );
    expect(bulk.success).toBe(true);
    if (!bulk.success) return;
    expect(bulk.value.source).toBe('bulk_upload:up-123:v1');
  });

  it('assigns a generated id to each record', async () => {
    const r1 = await ledger.recordRegistrationConsent(makeInput());
    const r2 = await ledger.recordRegistrationConsent(
      makeInput({ subjectId: '22222222-2222-2222-2222-222222222222' }),
    );

    expect(r1.success && r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.value.id).not.toBe(r2.value.id);
  });

  it('appends multiple rows (ledger is append-only)', async () => {
    const input = makeInput();
    await ledger.recordRegistrationConsent(input);
    await ledger.recordRegistrationConsent(input);

    expect(ledger.list()).toHaveLength(2);
  });

  it('stores null brand when brand is omitted', async () => {
    const result = await ledger.recordRegistrationConsent(makeInput({ brand: undefined }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.brand).toBeNull();
  });

  it('stores the provided brand when given', async () => {
    const result = await ledger.recordRegistrationConsent(
      makeInput({ brand: 'purple_dot', subjectType: 'organisation' }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.brand).toBe('purple_dot');
  });

  it('handles organisation subjectType correctly', async () => {
    const input = makeInput({
      subjectType: 'organisation',
      subjectId: '33333333-3333-3333-3333-333333333333',
    });
    const result = await ledger.recordRegistrationConsent(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.subjectType).toBe('organisation');
  });

  it('stores acceptedAt and createdAt as Date objects', async () => {
    const result = await ledger.recordRegistrationConsent(makeInput());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.acceptedAt).toBeInstanceOf(Date);
    expect(result.value.createdAt).toBeInstanceOf(Date);
  });
});

// ─── ConsentLedgerFake ────────────────────────────────────────────────────────

describe('ConsentLedgerFake', () => {
  let fake: ConsentLedgerFake;

  beforeEach(() => {
    fake = new ConsentLedgerFake();
  });

  it('seed() makes rows retrievable via list()', () => {
    const record = buildConsentRecord({ id: '00000000-0000-0000-0000-000000000010' });
    fake.seed([record]);
    expect(fake.list()).toHaveLength(1);
    expect(fake.list()[0]?.id).toBe('00000000-0000-0000-0000-000000000010');
  });

  it('seed() overwrites a row with the same id', () => {
    const r1 = buildConsentRecord({ id: '00000000-0000-0000-0000-000000000011', termsVersion: 1 });
    const r2 = buildConsentRecord({ id: '00000000-0000-0000-0000-000000000011', termsVersion: 2 });
    fake.seed([r1]);
    fake.seed([r2]);
    expect(fake.list()).toHaveLength(1);
    expect(fake.list()[0]?.termsVersion).toBe(2);
  });

  it('seed() does not interfere with subsequent recordRegistrationConsent calls', async () => {
    const existing = buildConsentRecord({ id: '00000000-0000-0000-0000-000000000020' });
    fake.seed([existing]);

    const result = await fake.recordRegistrationConsent(makeInput());
    expect(result.success).toBe(true);
    expect(fake.list()).toHaveLength(2);
  });

  it('still inherits recordRegistrationConsent from InMemoryConsentLedger', async () => {
    const result = await fake.recordRegistrationConsent(makeInput());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.source).toBe('registration');
  });
});

// ─── buildConsentRecord ───────────────────────────────────────────────────────

describe('buildConsentRecord', () => {
  it('returns a record that passes ConsentRecordSchema validation', () => {
    const record = buildConsentRecord();
    const parseResult = ConsentRecordSchema.safeParse(record);
    expect(parseResult.success).toBe(true);
  });

  it('applies overrides on top of defaults', () => {
    const record = buildConsentRecord({
      subjectType: 'organisation',
      network: 'yellow_dot',
      termsVersion: 3,
    });
    expect(record.subjectType).toBe('organisation');
    expect(record.network).toBe('yellow_dot');
    expect(record.termsVersion).toBe(3);
    // Non-overridden defaults are still present
    expect(record.privacyVersion).toBe(1);
    expect(record.source).toBe('registration');
  });

  it('produces deterministic defaults', () => {
    const r1 = buildConsentRecord();
    const r2 = buildConsentRecord();
    expect(r1).toEqual(r2);
  });
});

// ─── PostgresConsentLedger — boundary validation (FIX-4) ─────────────────────

describe('PostgresConsentLedger.recordRegistrationConsent — input validation', () => {
  // We use a minimal stub DB that asserts it is never reached when input is
  // invalid; if validation passes the stub throws so the test knows the DB
  // path would have been entered. This avoids a real DB connection while still
  // exercising the validation boundary independently of the in-memory impl.
  function makeNeverCalledDb() {
    return {
      insert: () => {
        throw new Error('DB should not be called on invalid input');
      },
    } as unknown as ConstructorParameters<typeof PostgresConsentLedger>[0];
  }

  it('returns err(ValidationError) for an invalid subjectId without calling the DB', async () => {
    const ledger = new PostgresConsentLedger(makeNeverCalledDb());
    const result = await ledger.recordRegistrationConsent({
      subjectType: 'user',
      subjectId: 'not-a-uuid', // invalid
      network: 'blue_dot',
      brand: null,
      termsVersion: 1,
      privacyVersion: 1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.code).toBe('CONSENT_INPUT_INVALID');
  });

  it('returns err(ValidationError) for a termsVersion below 1 without calling the DB', async () => {
    const ledger = new PostgresConsentLedger(makeNeverCalledDb());
    const result = await ledger.recordRegistrationConsent({
      subjectType: 'organisation',
      subjectId: '22222222-2222-2222-2222-222222222222',
      network: 'blue_dot',
      brand: null,
      termsVersion: 0, // invalid — must be ≥ 1
      privacyVersion: 1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('returns err(ValidationError) for an empty network string without calling the DB', async () => {
    const ledger = new PostgresConsentLedger(makeNeverCalledDb());
    const result = await ledger.recordRegistrationConsent({
      subjectType: 'user',
      subjectId: '33333333-3333-3333-3333-333333333333',
      network: '', // invalid — must be min(1)
      brand: null,
      termsVersion: 1,
      privacyVersion: 1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
  });
});

describe('PostgresConsentLedger — typed links, valid_till and the caller transaction (0029)', () => {
  /** A stub Drizzle handle recording the inserted values and echoing them back. */
  function recordingDb(fail?: Error) {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return {
            returning: () =>
              fail
                ? Promise.reject(fail)
                : Promise.resolve([
                    { id: '99999999-9999-9999-9999-999999999999', createdAt: new Date(), ...v },
                  ]),
          };
        },
      }),
    } as unknown as ConstructorParameters<typeof PostgresConsentLedger>[0];
    return { db, inserted };
  }

  it('links a user subject through user_id and stores valid_till', async () => {
    const { db, inserted } = recordingDb();
    const validTill = new Date('2027-01-01T00:00:00.000Z');
    const result = await new PostgresConsentLedger(db).recordRegistrationConsent(
      makeInput({ validTill }),
    );
    expect(result.success).toBe(true);
    expect(inserted[0]).toMatchObject({
      subjectType: 'user',
      userId: '11111111-1111-1111-1111-111111111111',
      orgId: null,
      source: 'registration',
      validTill,
    });
    if (result.success) expect(result.value.validTill).toEqual(validTill);
  });

  it('links an organisation subject through org_id', async () => {
    const { db, inserted } = recordingDb();
    await new PostgresConsentLedger(db).recordRegistrationConsent(
      makeInput({ subjectType: 'organisation', subjectId: '22222222-2222-2222-2222-222222222222' }),
    );
    expect(inserted[0]).toMatchObject({
      userId: null,
      orgId: '22222222-2222-2222-2222-222222222222',
      validTill: null,
    });
  });

  it('withExecutor writes through the given transaction, not the bound handle', async () => {
    const pool = recordingDb();
    const tx = recordingDb();
    const ledger = new PostgresConsentLedger(pool.db).withExecutor(tx.db);
    await ledger.recordRegistrationConsent(makeInput({ source: 'bulk_upload:u1:v1' }));
    expect(pool.inserted).toHaveLength(0);
    expect(tx.inserted[0]).toMatchObject({ source: 'bulk_upload:u1:v1' });
  });

  it('maps a database failure to err(CONSENT_INSERT_FAILED) without throwing', async () => {
    const { db } = recordingDb(new Error('connection reset'));
    const result = await new PostgresConsentLedger(db).recordRegistrationConsent(makeInput());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('CONSENT_INSERT_FAILED');
  });

  it('the in-memory ledger is its own executor-bound ledger', () => {
    const ledger = new InMemoryConsentLedger();
    expect(ledger.withExecutor({})).toBe(ledger);
  });
});
