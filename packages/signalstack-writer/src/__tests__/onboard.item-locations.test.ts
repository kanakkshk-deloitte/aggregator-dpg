/**
 * Unit tests for the `item_locations` passthrough on
 * `HttpSignalStackWriter.onboard`.
 *
 * The field carries coordinates the caller already resolved (a registrant
 * picking an address from a Places autocomplete). Its contract is asymmetric in
 * a way worth pinning: a non-empty array means "store exactly this", while an
 * absent OR empty one means "geocode the address text yourself" — so sending an
 * empty array must be indistinguishable on the wire from sending nothing. These
 * tests assert the key is present only when it carries a real coordinate, and
 * never on the account_only path, which creates no item to attach one to.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpSignalStackWriter } from '../http.js';
import type { SignalStackOnboardParticipantInput } from '../interface.js';

const ONBOARD_RESPONSE = {
  user_id: 'user-abc',
  user_existed: false,
  onboarded_at: '2026-01-01T00:00:00Z',
  items: [{ item_id: 'item-xyz', lifecycle_status: 'live' }],
};

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A complete with_item onboard input; each test overrides only what it asserts. */
function baseInput(
  overrides: Partial<SignalStackOnboardParticipantInput> = {},
): SignalStackOnboardParticipantInput {
  return {
    actingOrgId: 'org-abc',
    name: 'Asha',
    phoneNumber: '+919876543210',
    channel: 'link',
    source_id: 'link-1',
    network: 'blue_dot',
    domain: 'seeker',
    item_type: 'profile_1.0',
    profile: { location: 'Jayanagar, Bengaluru' },
    ...overrides,
  };
}

describe('HttpSignalStackWriter.onboard — item_locations', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  /** The JSON body of the single request the writer made. */
  function sentBody(): Record<string, unknown> {
    return JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
  }

  it('forwards supplied coordinates verbatim alongside item_state', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(
      baseInput({ item_locations: [{ lat: 12.9251, lng: 77.5938, label: 'Jayanagar' }] }),
    );

    const body = sentBody();
    expect(body.item_locations).toEqual([{ lat: 12.9251, lng: 77.5938, label: 'Jayanagar' }]);
    expect(body.item_state).toEqual({ location: 'Jayanagar, Bengaluru' });
  });

  it('carries a coordinate with no label', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(baseInput({ item_locations: [{ lat: 12.9251, lng: 77.5938 }] }));

    expect(sentBody().item_locations).toEqual([{ lat: 12.9251, lng: 77.5938 }]);
  });

  it('forwards every entry of a multi-location field', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(
      baseInput({
        item_locations: [
          { lat: 12.9, lng: 77.5, label: 'Bengaluru' },
          { lat: 28.6, lng: 77.2, label: 'Delhi' },
        ],
      }),
    );

    expect(sentBody().item_locations).toHaveLength(2);
  });

  it('omits the key entirely when no coordinates are supplied', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(baseInput());

    expect(sentBody()).not.toHaveProperty('item_locations');
  });

  it('omits the key for an empty array rather than sending []', async () => {
    // Load-bearing: signalstack reads an absent key as "geocode the address
    // text". An empty array would be read the same way, but only because of a
    // length check on its side — not sending it at all keeps this side's intent
    // explicit and independent of that.
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(baseInput({ item_locations: [] }));

    expect(sentBody()).not.toHaveProperty('item_locations');
  });

  it('never sends coordinates on the account_only path, even when supplied', async () => {
    // account_only creates a user row and no item, so a coordinate has nothing
    // to attach to. It rides the same branch as item_state for that reason.
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard(
      baseInput({
        submit_mode: 'account_only',
        item_locations: [{ lat: 12.9251, lng: 77.5938 }],
      }),
    );

    const body = sentBody();
    expect(body).not.toHaveProperty('item_locations');
    expect(body).not.toHaveProperty('item_state');
  });
});
