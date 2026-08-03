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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
 * `select({signalstackOrgId}).from(aggregators).where(...).limit(1)` — so the
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
    expect(reasons[0]).toContain('/age');
    expect(reasons[0]).toContain('must be number');
  });

  it('keeps only the non-required errors when required + content errors are mixed', () => {
    const reasons = blockingValidationReasons([required, typeErr, enumErr]);
    expect(reasons).toHaveLength(2);
    expect(reasons.join(' ')).toContain('/age');
    expect(reasons.join(' ')).toContain('/status');
    expect(reasons.join(' ')).not.toContain('required property');
  });

  it('falls back to schemaPath and a default message when instancePath/message are absent', () => {
    const reasons = blockingValidationReasons([{ keyword: 'pattern', schemaPath: '#/pattern' }]);
    expect(reasons).toEqual(['#/pattern: invalid']);
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
