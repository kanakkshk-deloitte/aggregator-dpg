/**
 * Unit tests for the pure, behaviour-changing helpers in the bulk row
 * processor: empty-cell stripping and the required-error pass-through filter.
 *
 * These two functions decide which bulk rows fail vs. pass through to signals
 * as `draft`, so a regression here would silently ship malformed or
 * unintended-partial data upstream — hence direct coverage.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  stripAllEmptyCells,
  blockingValidationReasons,
  pushToSignalStack,
  type SchemaValidationError,
} from './bulk-row-process.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setDb } from '../db.js';
import { logger } from '../logger.js';

/**
 * Minimal fake Drizzle db: the push path runs exactly one read —
 * `select({signalstackOrgId}).from(users).where(...).limit(1)` — so the
 * chain resolves to a single row carrying a non-null org id (else the push
 * short-circuits with SIGNALSTACK_ORG_NOT_REGISTERED before the onboard call).
 */
function fakeDbWithOrgId(orgId: string | null): unknown {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ signalstackOrgId: orgId }],
        }),
      }),
    }),
  };
}

describe('stripAllEmptyCells', () => {
  it('removes empty strings (including whitespace-only)', () => {
    const payload: Record<string, unknown> = { name: 'Asha', bio: '', city: '   ' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ name: 'Asha' });
  });

  it('removes null and undefined cells', () => {
    const payload: Record<string, unknown> = { a: null, b: undefined, c: 'keep' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ c: 'keep' });
  });

  it('removes empty arrays but keeps non-empty ones', () => {
    const payload: Record<string, unknown> = { tags: [], skills: ['welding'] };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ skills: ['welding'] });
  });

  it('keeps falsy-but-populated values (0, false)', () => {
    const payload: Record<string, unknown> = { count: 0, active: false, note: '' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ count: 0, active: false });
  });

  it('is a no-op on an already-clean payload', () => {
    const payload: Record<string, unknown> = { name: 'Asha', age: 30 };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ name: 'Asha', age: 30 });
  });
});

describe('blockingValidationReasons', () => {
  const required: SchemaValidationError = {
    keyword: 'required',
    schemaPath: '#/required',
    message: "must have required property 'name'",
  };
  const typeErr: SchemaValidationError = {
    keyword: 'type',
    instancePath: '/age',
    message: 'must be number',
  };
  const enumErr: SchemaValidationError = {
    keyword: 'enum',
    instancePath: '/status',
    message: 'must be equal to one of the allowed values',
  };

  it('returns empty when the only errors are missing-required (partial → draft)', () => {
    expect(blockingValidationReasons([required])).toEqual([]);
  });

  it('returns empty for no errors', () => {
    expect(blockingValidationReasons([])).toEqual([]);
  });

  it('surfaces a type error as a blocking reason', () => {
    const reasons = blockingValidationReasons([typeErr]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe('age: must be number');
    expect(reasons[0]).toContain('must be number');
  });

  // A conditional requirement (`allOf: [{ if: category === 'licensed', then:
  // { required: [...] } }]`) makes Ajv report each missing field as `required`
  // PLUS one `if` error ("must match \"then\" schema") that only summarises
  // them. Unlike a plain required gap, Signals never accepts it as a draft, so
  // each missing field fails the row here, by name; the summary is dropped.
  const ifErr: SchemaValidationError = {
    keyword: 'if',
    schemaPath: '#/allOf/0/if',
    message: 'must match "then" schema',
  };
  const conditionalRequired = (field: string): SchemaValidationError => ({
    keyword: 'required',
    instancePath: '',
    schemaPath: '#/allOf/0/then/required',
    params: { missingProperty: field },
    message: `must have required property '${field}'`,
  });

  it('fails a conditional requirement, naming each missing field, without the if summary', () => {
    expect(
      blockingValidationReasons([
        conditionalRequired('licence_number'),
        conditionalRequired('licence_type'),
        ifErr,
      ]),
    ).toEqual(['licence_number: is required', 'licence_type: is required']);
  });

  it('still treats a top-level required gap as advisory next to a conditional one', () => {
    expect(
      blockingValidationReasons([required, conditionalRequired('licence_number'), ifErr]),
    ).toEqual(['licence_number: is required']);
  });

  it('still fails a content error inside a conditional branch, without the if summary', () => {
    const licencePattern: SchemaValidationError = {
      keyword: 'pattern',
      instancePath: '/licence_number',
      message: 'must match pattern "^$|^[0-9]+$"',
    };
    const reasons = blockingValidationReasons([licencePattern, ifErr]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe('licence_number: Please enter a valid value.');
    expect(reasons.join(' ')).not.toContain('"then"');
  });

  it('keeps only the non-required errors when required + content errors are mixed', () => {
    const reasons = blockingValidationReasons([required, typeErr, enumErr]);
    expect(reasons).toHaveLength(2);
    expect(reasons).toEqual([
      'age: must be number',
      'status: must be equal to one of the allowed values',
    ]);
    expect(reasons.join(' ')).not.toContain('required property');
  });

  it('words a failed link field as Signals does, never showing the regex (#904)', () => {
    const schema = {
      type: 'object',
      properties: { website: { type: 'string', 'x-uri': true, pattern: '^x$' } },
    };
    expect(
      blockingValidationReasons(
        [{ keyword: 'pattern', instancePath: '/website', message: 'must match pattern "^x$"' }],
        schema,
      ),
    ).toEqual(['website: Please enter a valid web address.']);
  });

  it('falls back to schemaPath and a default message when instancePath/message are absent', () => {
    const reasons = blockingValidationReasons([{ keyword: 'pattern', schemaPath: '#/pattern' }]);
    expect(reasons).toEqual(['#/pattern: Please enter a valid value.']);
  });
});

describe('pushToSignalStack — owned_elsewhere handling', () => {
  const job = {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
    payload: { name: 'Asha', phone: '+919876543210' },
  };

  beforeEach(() => {
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
    _setNetworkConfig(buildBlueDotConfig());
    _setDb(fakeDbWithOrgId('org-signalstack-1') as never);
  });

  afterEach(() => {
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setDb(null);
  });

  it('fails the row when Signals reports the participant is owned elsewhere', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedForeignUser({ phoneNumber: '+919876543210' });
    _setSignalStackWriter(ss);

    const result = await pushToSignalStack(job, 'pid-1', '+919876543210', null, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SIGNALSTACK_OWNED_ELSEWHERE');
    expect(result.ownedElsewhere).toBe(true);
  });

  it('succeeds on a normal onboard (not owned elsewhere)', async () => {
    _setSignalStackWriter(new SignalStackWriterFake());

    const result = await pushToSignalStack(job, 'pid-2', '+919876500000', null, logger);

    expect(result.success).toBe(true);
  });

  it('treats a disabled signalstack as success (push is opt-out)', async () => {
    _setSignalStackWriter(null);

    const result = await pushToSignalStack(job, 'pid-3', '+919876500001', null, logger);

    expect(result.success).toBe(true);
  });
});

describe('pushToSignalStack — consent forwarding', () => {
  const job = {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
    payload: { name: 'Asha', phone: '+919876543210' },
  };

  beforeEach(() => {
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
    _setDb(fakeDbWithOrgId('org-signalstack-1') as never);
  });

  afterEach(() => {
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setDb(null);
  });

  it('forwards a compliance accept record — not the retired terms_accepted/privacy_accepted booleans — when the network presumes consent', async () => {
    _setNetworkConfig(buildBlueDotConfig());
    const ss = new SignalStackWriterFake();
    const onboardSpy = vi.spyOn(ss, 'onboard');
    _setSignalStackWriter(ss);

    const result = await pushToSignalStack(job, 'pid-4', '+919876500002', null, logger);

    expect(result.success).toBe(true);
    expect(onboardSpy).toHaveBeenCalledTimes(1);
    const input = onboardSpy.mock.calls[0]![0];
    expect(input.compliance).toEqual([
      { key: 'user_terms', value: true },
      { key: 'user_privacy', value: true },
      { key: 'profile_creation', value: true },
    ]);
    expect(input).not.toHaveProperty('terms_accepted');
    expect(input).not.toHaveProperty('privacy_accepted');
  });

  it('omits compliance entirely — rather than sending a decline that would reject the row — when the network does not presume consent', async () => {
    const cfg = buildBlueDotConfig();
    cfg.aggregator.onboarding.presume_consent = false;
    _setNetworkConfig(cfg);
    const ss = new SignalStackWriterFake();
    const onboardSpy = vi.spyOn(ss, 'onboard');
    _setSignalStackWriter(ss);

    const result = await pushToSignalStack(job, 'pid-5', '+919876500003', null, logger);

    expect(result.success).toBe(true);
    expect(onboardSpy).toHaveBeenCalledTimes(1);
    const input = onboardSpy.mock.calls[0]![0];
    expect(input).not.toHaveProperty('compliance');
    expect(input).not.toHaveProperty('terms_accepted');
    expect(input).not.toHaveProperty('privacy_accepted');
  });
});

describe('pushToSignalStack — age forwarding', () => {
  const baseJob = {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
  };
  const jobWith = (extra: Record<string, unknown>) => ({
    ...baseJob,
    payload: { name: 'Asha', phone: '+919876543210', ...extra },
  });

  beforeEach(() => {
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
    _setDb(fakeDbWithOrgId('org-signalstack-1') as never);
    _setNetworkConfig(buildBlueDotConfig());
  });

  afterEach(() => {
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setDb(null);
  });

  const pushAndCaptureInput = async (job: ReturnType<typeof jobWith>) => {
    const ss = new SignalStackWriterFake();
    const onboardSpy = vi.spyOn(ss, 'onboard');
    _setSignalStackWriter(ss);
    const result = await pushToSignalStack(job, 'pid-age', '+919876500009', null, logger);
    expect(result.success).toBe(true);
    expect(onboardSpy).toHaveBeenCalledTimes(1);
    return onboardSpy.mock.calls[0]![0];
  };

  // Without this, signals rejects every row on a guardian-gated domain with
  // `AGE_REQUIRED` because consent is sent but no age ever is.
  it('forwards the age column so consent can be recorded on a guardian-gated domain', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: 34 }));

    expect(input.age).toBe(34);
    expect(input.compliance).toBeDefined();
  });

  it('coerces a numeric age string from the CSV cell', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: '27' }));

    expect(input.age).toBe(27);
  });

  it('derives the age from year_of_birth when present, preferring it over age', async () => {
    const expected = new Date().getUTCFullYear() - 1990;

    const input = await pushAndCaptureInput(jobWith({ year_of_birth: 1990, age: 5 }));

    expect(input.age).toBe(expected);
  });

  it('omits age when the cell is blank, rather than sending 0', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: '   ' }));

    expect(input).not.toHaveProperty('age');
  });

  it('omits age when the cell is non-numeric, rather than sending NaN', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: 'abc' }));

    expect(input).not.toHaveProperty('age');
  });

  // Mirrors the link flow's minor path: signals rejects a server-to-server
  // onboard carrying age < 18 (`U18_NOT_ALLOWED`), but accepts the row when
  // neither age nor consent is sent.
  it('sends neither age nor consent for a minor row', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: 15 }));

    expect(input).not.toHaveProperty('age');
    expect(input).not.toHaveProperty('compliance');
  });

  it('treats exactly 18 as a minor, matching the link flow boundary', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: 18 }));

    expect(input).not.toHaveProperty('age');
    expect(input).not.toHaveProperty('compliance');
  });

  it('treats 19 as an adult', async () => {
    const input = await pushAndCaptureInput(jobWith({ age: 19 }));

    expect(input.age).toBe(19);
    expect(input.compliance).toBeDefined();
  });
});
