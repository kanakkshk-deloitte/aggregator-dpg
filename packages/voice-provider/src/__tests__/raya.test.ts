/**
 * Unit tests for {@link RayaVoiceProvider} — the Raya HTTP adapter for the
 * campaign voice channel (aggregator-dpg#577).
 *
 * Every test stubs `fetchImpl` (typed as `typeof fetch`) and `acquireSlot`
 * so no real network call or Redis egress gate is exercised. The 429-retry
 * tests inject a fake `sleep` so the suite stays fast and can assert the
 * exact computed wait deterministically, without needing fake timers.
 *
 * @module @aggregator-dpg/voice-provider
 */
import { describe, it, expect, vi } from 'vitest';
import { RayaVoiceProvider } from '../raya.js';
import type { VoiceDispatchInput } from '../interface.js';

// Modelled on Raya's REAL `POST /batch` 200 response — it echoes the
// submitted contact rows back in `data[]` (name/phone, PII) in addition to
// the whitelisted bookkeeping fields. `data` must never reach
// `providerResponse.create` — see the curation assertions below.
const CREATE_OK_BODY = {
  status: 'success',
  message: 'batch created',
  batchId: 42,
  totalRows: 1,
  validRows: 1,
  invalidRows: 0,
  contactsInserted: 1,
  data: [{ ref: 'i1', contact_name: 'Asha', contact_phone: '9000000001' }],
};

// Modelled on Raya's REAL `POST /batch/{id}/start` response — includes extra
// fields beyond the persistence whitelist to prove curation drops them.
const START_OK_BODY = {
  id: 42,
  status: 'Active',
  total_contacts: 1,
  completed_contacts: 0,
  unanswered_contacts: 0,
  schedule: null,
  max_retries: 2,
  concurrency: 5,
  retry_after_hrs: 1,
  webhook_url: 'https://internal.example.com/hooks/raya', // NOT whitelisted
};

/** The curated (whitelist-only) shape `providerResponse.create` must equal for {@link CREATE_OK_BODY}. */
const CREATE_OK_CURATED = {
  status: 'success',
  message: 'batch created',
  batchId: 42,
  totalRows: 1,
  validRows: 1,
  invalidRows: 0,
  contactsInserted: 1,
};

/** The curated (whitelist-only) shape `providerResponse.start` must equal for {@link START_OK_BODY}. */
const START_OK_CURATED = {
  id: 42,
  status: 'Active',
  total_contacts: 1,
  completed_contacts: 0,
  unanswered_contacts: 0,
  schedule: null,
  max_retries: 2,
  concurrency: 5,
  retry_after_hrs: 1,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function baseInput(overrides: Partial<VoiceDispatchInput> = {}): VoiceDispatchInput {
  return {
    agentRef: 'agent-1',
    batchName: 'batch-1',
    contacts: [
      {
        ref: 'i1',
        name: 'Asha',
        phone: '9000000001',
        variables: { role: 'Electrician', employer: 'Acme' },
      },
    ],
    startOptions: { max_concurrent_calls: 5 },
    ...overrides,
  };
}

describe('RayaVoiceProvider', () => {
  it('creates then starts a batch, acquiring a slot before each call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));
    const acquireSlot = vi.fn().mockResolvedValue(undefined);

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    // First attempt (reuseExisting unset) — no I4 lookup call, just create + start.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(acquireSlot).toHaveBeenCalledTimes(2);

    // create body carries contact_name/contact_phone/ref plus flattened variables.
    const [createUrl, createInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://raya.example.com/api/batch');
    const createBody = JSON.parse(createInit.body as string);
    expect(createBody).toEqual({
      agent_id: 'agent-1',
      batch_name: 'batch-1',
      contacts: [
        {
          contact_name: 'Asha',
          contact_phone: '9000000001',
          ref: 'i1',
          role: 'Electrician',
          employer: 'Acme',
        },
      ],
    });
    expect(new Headers(createInit.headers).get('x-api-key')).toBe('key-abc');

    // start body forwards only the supplied startOptions keys, verbatim.
    const [startUrl, startInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(startUrl).toBe('https://raya.example.com/api/batch/42/start');
    expect(JSON.parse(startInit.body as string)).toEqual({ max_concurrent_calls: 5 });

    expect(result).toEqual({
      success: true,
      value: {
        providerBatchRef: '42',
        accepted: ['i1'],
        rejected: [],
        providerResponse: { create: CREATE_OK_CURATED, start: START_OK_CURATED },
      },
    });
  });

  it('does not call the I4 batch-reuse lookup on a first attempt (reuseExisting unset) — only create + start', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.dispatch(baseInput()); // reuseExisting omitted — the happy-path default

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [createUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://raya.example.com/api/batch');
    // Never hits GET /api/batch (the list-batches lookup) on a first attempt.
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('agent_id='))).toBe(false);
  });

  it('persists only the curated whitelist — never the raw data[]/webhook_url payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { create, start } = result.value.providerResponse as {
      create: Record<string, unknown>;
      start: Record<string, unknown>;
    };
    expect(Object.keys(create).sort()).toEqual(
      [
        'status',
        'message',
        'totalRows',
        'validRows',
        'invalidRows',
        'batchId',
        'contactsInserted',
      ].sort(),
    );
    expect(Object.keys(start).sort()).toEqual(
      [
        'id',
        'status',
        'total_contacts',
        'completed_contacts',
        'unanswered_contacts',
        'schedule',
        'max_retries',
        'concurrency',
        'retry_after_hrs',
      ].sort(),
    );
    // The raw payload's contact echo/private webhook must never survive curation.
    const serialized = JSON.stringify(result.value.providerResponse);
    expect(serialized).not.toContain('data');
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('9000000001');
    expect(serialized).not.toContain('webhook_url');
  });

  it('injects no defaults into the start body beyond the supplied startOptions keys', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.dispatch(baseInput({ startOptions: {} }));

    const [, startInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(startInit.body as string)).toEqual({});
  });

  it('maps a create-time row rejection to rejected and excludes it from accepted, without leaking the rejected row PII into providerResponse', async () => {
    const createWithError = {
      ...CREATE_OK_BODY,
      validRows: 0,
      invalidRows: 1,
      // Raya's real shape: `errors[].value` echoes the raw offending
      // phone/name back — this must never survive into `providerResponse`.
      errors: [{ row: 1, field: 'contact_phone', value: '9000000001', message: 'bad' }],
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, createWithError));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    // start is never called when nothing was accepted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      value: {
        providerBatchRef: '42',
        accepted: [],
        rejected: [{ ref: 'i1', error: 'bad' }],
        providerResponse: {
          create: { ...CREATE_OK_CURATED, validRows: 0, invalidRows: 1 },
          start: null,
        },
      },
    });
    if (!result.success) return;
    const serialized = JSON.stringify(result.value.providerResponse);
    expect(serialized).not.toContain('9000000001');
    expect(serialized).not.toContain('"errors"');
    expect(serialized).not.toContain('"value"');
  });

  it("retries a 429 honouring the JSON body retry_after — Raya's actual RateLimitError/ConcurrencyLimitError shape, which carries no Retry-After header", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: 'RateLimitError', message: 'rate limited', retry_after: 20 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 20s body retry_after → 20000ms wait, not the computed exponential backoff.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.providerBatchRef).toBe('42');
  });

  it('falls back to the HTTP Retry-After header when the 429 body carries no retry_after', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'rate limited' }, { 'retry-after': '5' }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(result.success).toBe(true);
  });

  it('prefers the body retry_after over the Retry-After header when both are present', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { retry_after: 3 }, { 'retry-after': '99' }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await provider.dispatch(baseInput());

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('maps a 401 to AuthError without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: 'bad key' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('AuthError');
  });

  it('maps a non-429 4xx to ValidationError without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(400, { message: 'bad request' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
  });

  it('maps an exhausted-retry 5xx to UpstreamError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 2,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });

  it('maps an exhausted-retry network failure to UpstreamError', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 2,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });

  it('throws when a required constructor option is missing', () => {
    const acquireSlot = vi.fn();
    expect(() => new RayaVoiceProvider({ baseUrl: '', apiKey: 'k', acquireSlot })).toThrow(
      /baseUrl/,
    );
    expect(
      () => new RayaVoiceProvider({ baseUrl: 'https://raya.example.com', apiKey: '', acquireSlot }),
    ).toThrow(/apiKey/);
    expect(
      () =>
        new RayaVoiceProvider({
          baseUrl: 'https://raya.example.com',
          apiKey: 'k',
          acquireSlot: undefined as unknown as () => Promise<void>,
        }),
    ).toThrow(/acquireSlot/);
  });

  it('maps a create response with a non-numeric batchId to UpstreamError RAYA_BAD_RESPONSE', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...CREATE_OK_BODY, batchId: 'not-a-number' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1); // start is never reached
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
    expect(result.error.message).toContain('unexpected payload');
  });

  it('includes country_code in the create body when a contact supplies one', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.dispatch(
      baseInput({
        contacts: [
          { ref: 'i1', name: 'Asha', phone: '9000000001', countryCode: '+91', variables: {} },
        ],
      }),
    );

    const [, createInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const createBody = JSON.parse(createInit.body as string);
    expect(createBody.contacts[0].country_code).toBe('+91');
  });

  it('applies the full error-row mapping ruleset: explicit message, field-fallback, "rejected"-fallback, duplicate rows, and out-of-range rows', async () => {
    const input = baseInput({
      contacts: [
        { ref: 'i1', name: 'A', phone: '9000000001', variables: {} },
        { ref: 'i2', name: 'B', phone: '9000000002', variables: {} },
      ],
    });
    const createWithErrors = {
      ...CREATE_OK_BODY,
      errors: [
        { row: 1, field: 'contact_phone' }, // no message -> falls back to `field`
        { row: 1, message: 'duplicate for row 1, must be ignored' }, // already rejected -> ignored
        { row: 2 }, // no message, no field -> falls back to 'rejected'
        { row: 99, message: 'out of range, must be ignored' },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, createWithErrors));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.accepted).toEqual([]);
    expect(result.value.rejected).toEqual(
      expect.arrayContaining([
        { ref: 'i1', error: 'contact_phone' },
        { ref: 'i2', error: 'rejected' },
      ]),
    );
    expect(result.value.rejected).toHaveLength(2);
  });

  it('I5: demotes the tail of accepted when an errors[].row cannot be mapped to a specific contact (0-based drift)', async () => {
    const input = baseInput({
      contacts: [
        { ref: 'i1', name: 'A', phone: '9000000001', variables: {} },
        { ref: 'i2', name: 'B', phone: '9000000002', variables: {} },
      ],
    });
    // row: 0 is out of the 1-based range Raya documents — an unmappable
    // error. Never silently drop it; it means Raya rejected *something* we
    // can't attribute to a specific contact, so the accepted set must not
    // silently claim both contacts succeeded.
    const createWithUnmappedError = {
      ...CREATE_OK_BODY,
      contactsInserted: 2,
      validRows: 2,
      errors: [{ row: 0, message: 'unmappable' }],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, createWithUnmappedError))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // One unmapped error -> the tail (last) contact is demoted, never both
    // contacts silently reported as accepted.
    expect(result.value.accepted).toEqual(['i1']);
    expect(result.value.rejected).toEqual([{ ref: 'i2', error: 'raya_unmapped_rejection' }]);
  });

  it("I5: demotes the tail of accepted when it would exceed Raya's own contactsInserted count", async () => {
    const input = baseInput({
      contacts: [
        { ref: 'i1', name: 'A', phone: '9000000001', variables: {} },
        { ref: 'i2', name: 'B', phone: '9000000002', variables: {} },
      ],
    });
    // No errors reported at all, but Raya's own contactsInserted says only
    // 1 of the 2 submitted contacts actually landed in the batch — trust
    // that count over a naive "no errors means everyone's accepted" read.
    const createShortCount = {
      ...CREATE_OK_BODY,
      contactsInserted: 1,
      validRows: 1,
      errors: [],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, createShortCount))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.accepted).toEqual(['i1']);
    expect(result.value.rejected).toEqual([{ ref: 'i2', error: 'raya_short_count' }]);
  });

  it('returns err when the start call fails after a successful create', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'bad start options' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 1,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
  });

  it('maps a per-attempt abort (timeout) to UpstreamError RAYA_TIMEOUT', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      timeoutMs: 5000,
      maxAttempts: 1,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
    expect(result.error.message).toContain('timed out after 5000ms');
  });

  it('maps a malformed JSON 2xx create response to UpstreamError RAYA_BAD_RESPONSE', async () => {
    const badJsonResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token in JSON');
      },
      text: async () => 'not json',
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(badJsonResponse);

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('raya returned a malformed JSON body');
  });

  it('falls back to computed exponential backoff when a 429 has a non-JSON body and no usable Retry-After header', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const badBody429 = {
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => 'not-json{{{',
    } as unknown as Response;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(badBody429)
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await provider.dispatch(baseInput());

    // No usable retry_after anywhere — falls to 200 * 2^(1-1) computed backoff.
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('ignores an invalid (non-numeric) Retry-After header and falls back to computed backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': 'soon' }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await provider.dispatch(baseInput());

    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('does not sleep when the signalled retry_after is exactly 0', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { retry_after: 0 }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await provider.dispatch(baseInput());

    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps a 401 to AuthError with an empty body even when reading the response body fails', async () => {
    const throwingTextResponse = {
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => {
        throw new Error('stream already consumed');
      },
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(throwingTextResponse);

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('AuthError');
    expect(result.error.details?.['body']).toBe('');
  });

  it('I4 (retry only): reuses an existing batch by deterministic name instead of creating a duplicate', async () => {
    const listBody = {
      batches: [
        { id: 42, name: 'batch-1', agent_id: 'agent-1', status: 'Created', total_contacts: 1 },
      ],
      total: 1,
      offset: 0,
      limit: 100,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, listBody)) // GET /api/batch (list) — a match
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY)); // POST /batch/42/start

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput({ reuseExisting: true }));

    // Only the list + start calls — no POST /batch (create) call at all.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [listUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toBe('https://raya.example.com/api/batch?agent_id=agent-1&limit=100&sort=desc');
    const [startUrl] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(startUrl).toBe('https://raya.example.com/api/batch/42/start');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.providerBatchRef).toBe('42');
    expect(result.value.accepted).toEqual(['i1']);
    expect(result.value.rejected).toEqual([]);
    // No real create response exists on the reuse path — the persisted
    // `create` marker documents the reuse rather than fabricating one.
    expect(result.value.providerResponse.create).toMatchObject({ status: 'reused', batchId: 42 });
  });

  it('I4 (retry only): does not reuse a batch whose name matches a different agent (lookup is agent-scoped)', async () => {
    const listBody = {
      batches: [{ id: 99, name: 'batch-1', agent_id: 'other-agent', total_contacts: 1 }],
      total: 1,
      offset: 0,
      limit: 100,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, listBody))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput({ reuseExisting: true }));

    // The list query is itself agent-scoped (agent_id=agent-1), so a match
    // returned for a different agent is a defensive-only guard — this
    // confirms the create call still ran.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.providerBatchRef).toBe('42');
  });

  it("I4+I5 (retry only): demotes contacts beyond the reused batch's confirmed total_contacts", async () => {
    const listBody = {
      batches: [{ id: 42, name: 'batch-1', agent_id: 'agent-1', total_contacts: 1 }],
      total: 1,
      offset: 0,
      limit: 100,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, listBody))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(
      baseInput({
        reuseExisting: true,
        contacts: [
          { ref: 'i1', name: 'A', phone: '9000000001', variables: {} },
          { ref: 'i2', name: 'B', phone: '9000000002', variables: {} },
        ],
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.accepted).toEqual(['i1']);
    expect(result.value.rejected).toEqual([{ ref: 'i2', error: 'raya_batch_reused_short_count' }]);
  });

  it('I4 (retry only): when the list-batches lookup itself fails, falls through to a normal create (best-effort, non-fatal)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { message: 'down' })) // list fails, exhausts its own retry budget
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 1,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput({ reuseExisting: true }));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.providerBatchRef).toBe('42');
  });
});
