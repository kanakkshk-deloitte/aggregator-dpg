/**
 * Testing fake for SignalStackWriterBase.
 *
 * Part of the signalstack-writer package. Other packages import this fake
 * from `@aggregator-dpg/signalstack-writer/testing`, not from `./memory`.
 * `seed()` inserts existing users and profiles without calling `onboard()`.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { InMemorySignalStackWriter } from './memory.js';
import { SignalStackTokenProviderBase } from './interface.js';
import type {
  SignalStackContactCanonical,
  SignalStackContactValue,
  SignalStackDashboardPage,
  SignalStackDecryptedProfileRow,
  SignalStackOnboardParticipantInput,
} from './interface.js';

export { InMemorySignalStackWriter };

/**
 * In-memory fake for {@link SignalStackTokenProviderBase}.
 *
 * Returns a fixed token by default. `failNext()` makes the next `getToken()`
 * call fail.
 */
export class SignalStackTokenProviderFake extends SignalStackTokenProviderBase {
  private token: string;
  private failNextError: BaseError | null = null;
  callCount = 0;
  /** How many times {@link invalidate} was called. */
  invalidateCount = 0;

  constructor(token = 'fake-signalstack-token') {
    super();
    this.token = token;
  }

  /** Sets the token returned by later calls. */
  setToken(token: string): void {
    this.token = token;
  }

  /** Makes the next `getToken()` call fail with this error. */
  failNext(
    error: BaseError = new UpstreamError('token grant failed', { code: 'SIGNALSTACK_AUTH_FAILED' }),
  ): void {
    this.failNextError = error;
  }

  override async getToken(): Promise<Result<string, BaseError>> {
    this.callCount += 1;
    if (this.failNextError) {
      const e = this.failNextError;
      this.failNextError = null;
      return err(e);
    }
    return ok(this.token);
  }

  /** Increments `invalidateCount`. The fake has no cache to clear. */
  override invalidate(): void {
    this.invalidateCount += 1;
  }
}

export interface SignalStackUserSeed {
  id?: string;
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  role?: string | null;
}

export interface SignalStackProfileSeed {
  item_id?: string;
  created_by: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state?: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
  created_at?: string;
  updated_at?: string;
  /** Signalstack organisation id the row belongs to; defaults to empty string. */
  acting_org_id?: string;
  /** Channel attribution; defaults to `'bulk'`. */
  channel?: 'bulk' | 'link';
  /** Source workflow id; defaults to empty string. */
  source_id?: string;
  /**
   * Contact block returned when decrypt requests `contact`. Unseeded fields
   * resolve to `{ value: null, source: null }`.
   */
  contact?: Partial<Record<SignalStackContactCanonical, SignalStackContactValue>>;
}

/**
 * Pre-built signalstack aggregator row for `seed()`.
 *
 * Set `org_id` to fix the returned id; otherwise the fake assigns
 * `seed-org-N`.
 */
export interface SignalStackAggregatorSeed {
  org_id?: string;
  external_id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

/**
 * Dashboard payload that {@link InMemorySignalStackWriter.fetchDashboard}
 * returns for `acting_org_id`. Without one, the fake returns an empty rollup.
 */
export interface SignalStackDashboardSeed {
  acting_org_id: string;
  page: SignalStackDashboardPage;
}

/**
 * CSV that {@link InMemorySignalStackWriter.exportDashboardCsv} returns for
 * `acting_org_id`. Without one, the export returns `SIGNALSTACK_BAD_RESPONSE`.
 */
export interface SignalStackDashboardExportSeed {
  acting_org_id: string;
  csv: string;
}

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

export class SignalStackWriterFake extends InMemorySignalStackWriter {
  /**
   * Inserts users, profiles, aggregators, and dashboard payloads directly
   * into the store, without calling `onboard()`.
   *
   * Seeding the same id again overwrites the previous row.
   */
  seed(seeds: {
    users?: SignalStackUserSeed[];
    profiles?: SignalStackProfileSeed[];
    aggregators?: SignalStackAggregatorSeed[];
    dashboards?: SignalStackDashboardSeed[];
    dashboardExports?: SignalStackDashboardExportSeed[];
  }): void {
    let userCounter = 1;
    for (const s of seeds.users ?? []) {
      const id = s.id ?? `seed-user-${userCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).users.set(id, {
        id,
        name: s.name,
        email: s.email ?? null,
        phoneNumber: s.phoneNumber ?? null,
        role: s.role ?? 'user',
      });
    }

    let profileCounter = 1;
    for (const s of seeds.profiles ?? []) {
      const id = s.item_id ?? `seed-item-${profileCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).profiles.set(id, {
        item_id: id,
        item_network: s.item_network,
        item_domain: s.item_domain,
        item_type: s.item_type,
        item_state: s.item_state ?? {},
        item_latitude: s.item_latitude ?? null,
        item_longitude: s.item_longitude ?? null,
        created_at: s.created_at ?? ISO_FIXED,
        updated_at: s.updated_at ?? ISO_FIXED,
        created_by: s.created_by,
        acting_org_id: s.acting_org_id ?? '',
        channel: s.channel ?? 'bulk',
        source_id: s.source_id ?? '',
        ...(s.contact !== undefined ? { contact: s.contact } : {}),
      });
    }

    let aggregatorCounter = 1;
    for (const s of seeds.aggregators ?? []) {
      const orgId = s.org_id ?? `seed-org-${aggregatorCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).aggregators.set(s.external_id, {
        org_id: orgId,
        external_id: s.external_id,
        name: s.name,
        slug: s.slug,
        ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      });
    }

    for (const s of seeds.dashboards ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).dashboards.set(s.acting_org_id, s.page);
    }

    for (const s of seeds.dashboardExports ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).dashboardExports.set(s.acting_org_id, s.csv);
    }
  }
}

/**
 * Builds a complete `SignalStackOnboardParticipantInput` with fixed defaults.
 *
 * Defaults:
 *   - `actingOrgId: 'org-1'`
 *   - `name: 'Default User'`
 *   - `email: 'user@example.com'`
 *   - `terms_accepted: true`, `privacy_accepted: true`
 *   - `channel: 'link'`, `source_id: 'link-1'`
 *   - `network: 'blue_dot'`, `domain: 'seeker'`, `item_type: 'profile_1.0'`
 *   - `profile: {}`
 *
 * @param overrides - Fields that replace the defaults.
 * @returns A complete `SignalStackOnboardParticipantInput`.
 */
export function buildOnboardInput(
  overrides: Partial<SignalStackOnboardParticipantInput> = {},
): SignalStackOnboardParticipantInput {
  return {
    actingOrgId: 'org-1',
    name: 'Default User',
    email: 'user@example.com',
    terms_accepted: true,
    privacy_accepted: true,
    channel: 'link',
    source_id: 'link-1',
    network: 'blue_dot',
    domain: 'seeker',
    item_type: 'profile_1.0',
    profile: {},
    ...overrides,
  };
}

/**
 * Builds a decrypted profile row (see {@link SignalStackDecryptedProfiles}).
 *
 * @param overrides - Fields that replace the defaults.
 * @returns A complete `SignalStackDecryptedProfileRow`.
 */
export function buildDecryptedProfileRow(
  overrides: Partial<SignalStackDecryptedProfileRow> = {},
): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Default Name', phone: '+910000000000' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
