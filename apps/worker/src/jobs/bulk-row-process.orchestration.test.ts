/**
 * Orchestration tests for `processBulkRow` — the per-row bulk-upload pipeline
 * entry point. The pure helpers (`stripAllEmptyCells`, `blockingValidationReasons`,
 * `pushToSignalStack`) already have dedicated unit tests in
 * `bulk-row-process.test.ts`; this file drives the *whole* function through
 * every branch that file's ~30% baseline coverage missed: participant-type /
 * schema / validation / normalisation / domain failures, the writer +
 * signalstack push interplay (passed / skipped-duplicate / failed, and every
 * way the push itself can fail), the Redis-Lua commit outcome handling
 * (replay, heartbeat flush, Finaliser enqueue), and array-cell preprocessing.
 *
 * DB and Redis are faked (hand-built chainable stubs, matching the pattern
 * already used by the sibling job test files). The signalstack-writer
 * dependency uses the real in-memory `./testing` fake per testing.md
 * ("fakes over mocks").
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BulkRowProcessJob } from '@aggregator-dpg/queue';
import { err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  SignalStackWriterFake,
  InMemorySignalStackWriter,
} from '@aggregator-dpg/signalstack-writer/testing';
import type {
  SignalStackOnboardParticipantInput,
  SignalStackOnboardParticipantResult,
} from '@aggregator-dpg/signalstack-writer/interface';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

// ─── DB fake: signalstack-org lookup + heartbeat update ─────────────────────

let orgId: string | null = 'org-signalstack-1';
let heartbeatShouldThrow: Error | null = null;
const heartbeatUpdates: Array<Record<string, unknown>> = [];

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ signalstackOrgId: orgId }],
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        heartbeatUpdates.push(v);
        return {
          where: async () => {
            if (heartbeatShouldThrow) throw heartbeatShouldThrow;
            return undefined;
          },
        };
      },
    }),
  };
}

// ─── Redis fake: `script` (SCRIPT LOAD) + `evalsha` (the Lua row-commit) ────

let evalshaResult: [number, number, number, number] = [1, -1, 0, 1];
const evalshaCalls: unknown[][] = [];

vi.mock('../services/redis.js', () => ({
  getRedis: () => ({
    // The loader asks Redis for the script digest rather than hashing the
    // source itself; any non-empty string is an acceptable stand-in here.
    script: vi.fn(async () => 'f'.repeat(40)),
    evalsha: vi.fn(async (...args: unknown[]) => {
      evalshaCalls.push(args);
      return evalshaResult;
    }),
  }),
}));

// ─── Schema loader fake ──────────────────────────────────────────────────────

interface FakeValidate {
  (data: unknown): boolean;
  errors: Array<{ keyword?: string; instancePath?: string; message?: string }> | null;
}

function makeValidate(
  valid: boolean,
  errors: Array<{ keyword?: string; instancePath?: string; message?: string }> = [],
): FakeValidate {
  const fn = ((_data: unknown) => valid) as FakeValidate;
  fn.errors = errors.length > 0 ? errors : null;
  return fn;
}

type ValidatorResult =
  { success: true; value: FakeValidate } | { success: false; error: { code: string } };
type SchemaResult =
  { success: true; value: Record<string, unknown> } | { success: false; error: { code: string } };

let validatorResult: ValidatorResult = { success: true, value: makeValidate(true) };
let schemaResultVal: SchemaResult = { success: true, value: { required: [], properties: {} } };

vi.mock('../services/schema-loader.js', () => ({
  getSchemaLoader: () => ({
    getValidator: async () => validatorResult,
    getSchema: async () => schemaResultVal,
  }),
}));

// ─── Bulk-queue (Finaliser enqueue) fake ────────────────────────────────────

const enqueueFinalise = vi.fn(async () => undefined);
vi.mock('../services/bulk-queue.js', () => ({ enqueueFinalise }));

vi.mock('../config.js', () => ({
  config: {
    BULK_UPLOAD_REDIS_TTL_SECONDS: 86_400,
    SIGNALSTACK_ITEM_NETWORK: 'blue_dot',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

const { processBulkRow, pushToSignalStack } = await import('./bulk-row-process.js');
const { _setSignalStackWriter } = await import('../services/signalstack.js');
const { _setNetworkConfig } = await import('../services/network-config.js');
const { _setDb } = await import('../db.js');
const { logger } = await import('../logger.js');

// ─── Fakes that fail on demand (extend the real in-memory impls) ───────────

/**
 * Records every `onboard` input so a test can assert what actually reached the
 * wire — `item_locations` presence and the absence of `geo_location` from the
 * profile are the two claims #807 makes, and neither is observable from the
 * row outcome alone.
 */
class RecordingSignalStackWriter extends InMemorySignalStackWriter {
  readonly inputs: SignalStackOnboardParticipantInput[] = [];
  override async onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    this.inputs.push(input);
    return await super.onboard(input);
  }
}

class FailingSignalStackWriter extends InMemorySignalStackWriter {
  constructor(
    private readonly code = 'UPSTREAM_TIMEOUT',
    private readonly message = 'signalstack unreachable',
    /** The bare upstream sentence the real writer puts on `details.signalsMessage`. */
    private readonly signalsMessage?: string,
    /** Signals' own error code and per-field map, as the real writer forwards them. */
    private readonly upstream: { code?: string; fields?: Record<string, string> } = {},
  ) {
    super();
  }
  override async onboard(
    _input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    const details = {
      ...(this.signalsMessage ? { signalsMessage: this.signalsMessage } : {}),
      ...(this.upstream.code ? { upstreamCode: this.upstream.code } : {}),
      ...(this.upstream.fields ? { signalsFields: this.upstream.fields } : {}),
    };
    return err(
      new UpstreamError(this.message, {
        code: this.code,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      }),
    );
  }
}

function makeJob(overrides: Partial<BulkRowProcessJob> = {}): BulkRowProcessJob {
  return {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
    payload: { name: 'Asha', phone: '9876543210', email: 'asha@example.com' },
    ...overrides,
  };
}

/** Extracts {outcome, errorPayload} from the last `evalsha` call args. */
function lastCommit(): { outcome: string; errorPayload: string } {
  const call = evalshaCalls.at(-1)!;
  return { outcome: call[8] as string, errorPayload: call[9] as string };
}

let signalStackWriter: SignalStackWriterFake;

beforeEach(() => {
  vi.clearAllMocks();
  evalshaResult = [1, -1, 0, 1];
  evalshaCalls.length = 0;
  validatorResult = { success: true, value: makeValidate(true) };
  schemaResultVal = { success: true, value: { required: [], properties: {} } };
  orgId = 'org-signalstack-1';
  heartbeatShouldThrow = null;
  heartbeatUpdates.length = 0;
  _setDb(makeDb() as never);
  _setNetworkConfig(buildBlueDotConfig());
  signalStackWriter = new SignalStackWriterFake();
  _setSignalStackWriter(signalStackWriter);
});

afterEach(() => {
  _setDb(null);
  _setNetworkConfig(null);
  _setSignalStackWriter(null);
});

describe('processBulkRow — normal execution', () => {
  it('passes a well-formed row: writes the participant and pushes to signalstack', async () => {
    const result = await processBulkRow(makeJob());
    expect(result).toEqual({ outcome: 'passed', category: null, reasons: [] });
    expect(lastCommit()).toEqual({ outcome: 'passed', errorPayload: '' });
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('omits a missing optional email from the signalstack push', async () => {
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '9876543210' } }),
    );
    expect(result.outcome).toBe('passed');
    const [user] = signalStackWriter.listUsers();
    expect(user?.email ?? null).toBeNull();
  });

  it('splits a delimited array-typed cell using the network csv_array_delimiter', async () => {
    schemaResultVal = {
      success: true,
      value: {
        required: [],
        properties: { skills: { type: 'array' }, name: {}, phone: {}, email: {} },
      },
    };
    await processBulkRow(
      makeJob({
        payload: {
          name: 'Asha',
          phone: '9876543210',
          email: 'a@x.com',
          skills: 'welding|carpentry',
        },
      }),
    );
    const [profile] = signalStackWriter.listProfiles();
    expect(profile?.item_state['skills']).toEqual(['welding', 'carpentry']);
  });
});

describe('processBulkRow — edge cases: rejected before persistence', () => {
  it('fails fast on an unrecognised participant_type', async () => {
    const result = await processBulkRow(makeJob({ participantType: 'ghost' }));
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain('invalid participant_type: ghost');
    expect(lastCommit().outcome).toBe('failed');
    expect(lastCommit().errorPayload).toContain('invalid participant_type');
  });

  it('fails when the schema/validator fails to load', async () => {
    validatorResult = { success: false, error: { code: 'SCHEMA_NOT_FOUND' } };
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain('schema_load_failed: SCHEMA_NOT_FOUND');
  });

  it('fails a row with a blocking (non-required) schema validation error', async () => {
    validatorResult = {
      success: true,
      value: makeValidate(false, [
        { keyword: 'type', instancePath: '/age', message: 'must be number' },
      ]),
    };
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('validation');
    expect(result.reasons[0]).toMatch(/^age: /);
  });

  it('passes a row through when the only validation errors are missing-required fields', async () => {
    validatorResult = {
      success: true,
      value: makeValidate(false, [
        { keyword: 'required', message: "must have required property 'x'" },
      ]),
    };
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });

  it('fails with system_error when the participant type has no domain config', async () => {
    _setNetworkConfig(buildBlueDotConfig({ domainIds: ['seeker', 'provider', 'ghost'] }));
    const result = await processBulkRow(makeJob({ participantType: 'ghost' }));
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain("unknown domain 'ghost'");
  });

  it('fails on an unnormalisable phone number', async () => {
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '123', email: 'a@x.com' } }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('normalisation');
    expect(result.reasons[0]).toContain('phone:');
  });
});

describe('processBulkRow — signalstack push outcomes', () => {
  // There is no local participant row any more, so there is no local dedup and
  // no `skipped`/`duplicate` outcome on this path. A repeat row is pushed and
  // reported as `passed` — which is what actually happens upstream, since
  // signals `onboard` always inserts. Deduplication, if wanted, belongs there.
  it('reports a repeat row as passed — dedup is not done locally', async () => {
    const payload = { participant_id: 'dup-1', name: 'Asha', phone: '9876543210' };
    const first = await processBulkRow(makeJob({ payload }));
    const second = await processBulkRow(makeJob({ payload }));
    expect(first).toEqual({ outcome: 'passed', category: null, reasons: [] });
    expect(second).toEqual({ outcome: 'passed', category: null, reasons: [] });
    // Pins the reason it is `passed` twice: signals really did create a second
    // profile. Without this the test would still pass if signals deduped.
    expect(signalStackWriter.listProfiles()).toHaveLength(2);
  });

  it('fails a fresh row with system_error when the signalstack push fails generically', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter('UPSTREAM_TIMEOUT', 'signalstack unreachable'),
    );
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toBe('signalstack [UPSTREAM_TIMEOUT]: signalstack unreachable');
  });

  it('categorises a profile-limit push rejection distinctly from a generic system error', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter('SIGNALSTACK_PROFILE_LIMIT_REACHED', 'profile cap hit'),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('limit_reached');
  });

  it('categorises a coordinate outside the country as a validation failure, not a system error (signals-dpg#789)', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter(
        'SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY',
        'signalstack onboard returned 400: LOCATION_OUTSIDE_COUNTRY: Location 23.8103, 90.4125 is outside the allowed region (IN).',
        'Location 23.8103, 90.4125 is outside the allowed region (IN).',
      ),
    );
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('validation');
    // errors.csv gets the bare sentence the operator can act on, exactly like a
    // local validation failure — not the transport/status prefix chain.
    expect(result.reasons).toEqual([
      'Location 23.8103, 90.4125 is outside the allowed region (IN).',
    ]);
  });

  it('falls back to the full upstream message when Signals sent no bare sentence', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter(
        'SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY',
        'signalstack onboard returned 400',
      ),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('validation');
    expect(result.reasons).toEqual(['signalstack onboard returned 400']);
  });

  it('keeps the diagnostic prefix on a system error, where operators need the code', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter('UPSTREAM_TIMEOUT', 'signalstack unreachable'),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('system_error');
    expect(result.reasons).toEqual(['signalstack [UPSTREAM_TIMEOUT]: signalstack unreachable']);
  });

  it.each([
    ['INVALID_ITEM_STATE', 'validation'],
    ['FST_ERR_VALIDATION', 'validation'],
    ['MISSING_IDENTIFIER', 'validation'],
    ['AGE_REQUIRED', 'validation'],
    ['USER_LEVEL_INCOMPLETE', 'validation'],
    ['CONSENT_DECLINED', 'validation'],
    ['U18_NOT_ALLOWED', 'validation'],
    ['LOCATION_OUTSIDE_COUNTRY', 'validation'],
    ['DOMAIN_LOCKED', 'duplicate'],
    ['USER_ALREADY_EXISTS', 'duplicate'],
    ['IDENTITY_CONFLICT', 'duplicate'],
    ['PROFILE_LIMIT_REACHED', 'limit_reached'],
    ['UNSERVED_DOMAIN', 'system_error'],
    ['ONBOARD_FAILED', 'system_error'],
  ])("categorises Signals' %s as %s", async (upstreamCode, category) => {
    _setSignalStackWriter(
      new FailingSignalStackWriter(
        'SIGNALSTACK_BAD_REQUEST',
        'signalstack onboard returned 400',
        'why',
        {
          code: upstreamCode,
        },
      ),
    );
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe(category);
  });

  it("lists Signals' per-field messages as the row's reasons, like a local schema failure", async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter(
        'SIGNALSTACK_BAD_REQUEST',
        'signalstack onboard returned 400: INVALID_ITEM_STATE: …',
        'Invalid item_state: mobile_number: Enter a 10-digit mobile number, gender: must be one of: Male, Female',
        {
          code: 'INVALID_ITEM_STATE',
          fields: {
            mobile_number: 'Enter a 10-digit mobile number',
            gender: 'must be one of: Male, Female',
          },
        },
      ),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('validation');
    expect(result.reasons).toEqual([
      'mobile_number: Enter a 10-digit mobile number',
      'gender: must be one of: Male, Female',
    ]);
  });

  it("uses Signals' sentence for a duplicate, not the transport prefix", async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter(
        'SIGNALSTACK_FORBIDDEN',
        'signalstack onboard returned 403: DOMAIN_LOCKED: …',
        'This participant is already registered as a provider.',
        { code: 'DOMAIN_LOCKED' },
      ),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('duplicate');
    expect(result.reasons).toEqual(['This participant is already registered as a provider.']);
  });

  it('categorises an owned-elsewhere push rejection distinctly', async () => {
    signalStackWriter.seedForeignUser({ phoneNumber: '+919876543210' });
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '9876543210' } }),
    );
    expect(result.category).toBe('owned_elsewhere');
  });

  it('treats a disabled signalstack push (opt-out) as success', async () => {
    _setSignalStackWriter(null);
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });
});

describe('pushToSignalStack — direct-call edge cases not reachable through processBulkRow', () => {
  const job = makeJob();

  it('fails with SIGNALSTACK_ORG_NOT_REGISTERED when the aggregator has no signalstack_org_id on file', async () => {
    orgId = null;
    _setDb(makeDb() as never);
    const result = await pushToSignalStack(job, 'pid-1', '+919876543210', null, logger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SIGNALSTACK_ORG_NOT_REGISTERED');
  });

  it('fails with UNKNOWN_DOMAIN when the resolved network has no config for the domain', async () => {
    _setNetworkConfig(buildBlueDotConfig({ domainIds: ['seeker', 'provider', 'ghost'] }));
    const result = await pushToSignalStack(
      { ...job, participantType: 'ghost' },
      'pid-2',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('UNKNOWN_DOMAIN');
  });

  it('falls back to the participantId as the pushed name when the identity name field is absent from the payload', async () => {
    const result = await pushToSignalStack(
      { ...job, payload: { phone: '+919876543210' } },
      'pid-fallback-name',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(true);
  });

  it('overrides an empty/missing raw phone cell with the already-normalised pushPhone', async () => {
    // domainCfg.identity.phone === 'phone'; omit it from the payload entirely
    // so buildSignalStackItemState's override branch (rawPhone undefined,
    // pushPhone truthy) is exercised.
    const result = await pushToSignalStack(
      { ...job, payload: { name: 'Asha' } },
      'pid-phone-override',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(true);
  });
});

describe('processBulkRow — Redis commit outcome handling', () => {
  it('short-circuits bookkeeping on a replay (wasNew=0): no heartbeat, no Finaliser enqueue', async () => {
    evalshaResult = [5, 10, 0, 0];
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
    expect(heartbeatUpdates).toHaveLength(0);
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('flushes a heartbeat on a PROGRESS_FLUSH_EVERY boundary', async () => {
    evalshaResult = [500, 1000, 0, 1];
    await processBulkRow(makeJob());
    expect(heartbeatUpdates).toHaveLength(1);
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('flushes a heartbeat when processed reaches total even off the 500-boundary', async () => {
    evalshaResult = [7, 7, 0, 1];
    await processBulkRow(makeJob());
    expect(heartbeatUpdates).toHaveLength(1);
  });

  it('enqueues the Finaliser exactly when processed==total and reader_done, with total>0', async () => {
    evalshaResult = [3, 3, 1, 1];
    await processBulkRow(makeJob());
    expect(enqueueFinalise).toHaveBeenCalledTimes(1);
    expect(enqueueFinalise).toHaveBeenCalledWith({ uploadId: 'up-1' });
  });

  it('does not enqueue the Finaliser when total is not yet known (<=0), even if processed==total', async () => {
    evalshaResult = [0, 0, 1, 1];
    await processBulkRow(makeJob());
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('swallows a heartbeat write failure without failing the row (logged, not thrown)', async () => {
    evalshaResult = [500, 1000, 0, 1];
    heartbeatShouldThrow = new Error('db unavailable');
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });
});

describe('processBulkRow — geo_location column (#807)', () => {
  let recorder: RecordingSignalStackWriter;

  beforeEach(() => {
    recorder = new RecordingSignalStackWriter();
    _setSignalStackWriter(recorder);
  });

  it('sends a valid cell as item_locations and keeps it out of the profile', async () => {
    const result = await processBulkRow(
      makeJob({
        payload: {
          name: 'Asha',
          phone: '9876543210',
          geo_location: '12.9352|77.6245',
        },
      }),
    );

    expect(result.outcome).toBe('passed');
    const input = recorder.inputs.at(-1)!;
    expect(input.item_locations).toEqual([{ lat: 12.9352, lng: 77.6245 }]);
    // The column is not a schema property; leaking it would reach Signals as a
    // junk item_state field.
    expect(input.profile).not.toHaveProperty('geo_location');
  });

  it('omits item_locations entirely when the column is absent', async () => {
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
    // Omitted, not `[]` — Signals reads a present non-empty array as "use
    // these, do not geocode", and an empty one would be ambiguous.
    expect(recorder.inputs.at(-1)!.item_locations).toBeUndefined();
  });

  it('passes the row and falls back to geocoding when the cell is unusable', async () => {
    // `12.9352|` is the case that matters: Number('') is 0, not NaN, so this
    // once parsed as a valid point at longitude 0.
    const result = await processBulkRow(
      makeJob({
        payload: { name: 'Asha', phone: '9876543210', geo_location: '12.9352|' },
      }),
    );

    expect(result.outcome).toBe('passed');
    expect(lastCommit()).toEqual({ outcome: 'passed', errorPayload: '' });
    const input = recorder.inputs.at(-1)!;
    expect(input.item_locations).toBeUndefined();
    expect(input.profile).not.toHaveProperty('geo_location');
  });

  it('leaves the value alone when the schema itself declares geo_location', async () => {
    // The schema wins. Extracting here would delete a real property before Ajv
    // sees it, failing every row on a column the operator can see in the file.
    schemaResultVal = {
      success: true,
      value: { required: [], properties: { geo_location: { type: 'string' } } },
    };

    const result = await processBulkRow(
      makeJob({
        payload: { name: 'Asha', phone: '9876543210', geo_location: '12.9352|77.6245' },
      }),
    );

    expect(result.outcome).toBe('passed');
    const input = recorder.inputs.at(-1)!;
    expect(input.item_locations).toBeUndefined();
    expect(input.profile).toHaveProperty('geo_location', '12.9352|77.6245');
  });
});
