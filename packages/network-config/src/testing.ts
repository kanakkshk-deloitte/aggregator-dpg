/**
 * Testing fake for the network-config loader.
 *
 * Lets tests inject a fixed {@link ResolvedNetworkConfig} without the file
 * or HTTP loader. The `build*` helpers return blue_dot and purple_dot
 * configs.
 *
 * @module @aggregator-dpg/network-config/testing
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  DEFAULT_ORGANISATION,
  NetworkConfigLoaderBase,
  type NetworkConfigError,
  type ResolvedDomain,
  type ResolvedNetworkConfig,
} from './interface.js';

export class InMemoryNetworkConfigLoader extends NetworkConfigLoaderBase {
  constructor(private readonly pinned: ResolvedNetworkConfig) {
    super();
  }

  async load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>> {
    return ok(this.pinned);
  }
}

/** The per-network inputs the shared builder below varies on. */
interface NetworkFixture {
  /** Network id, e.g. `blue_dot`. */
  networkId: string;
  /** Brand block for the aggregator section. */
  brand: { short_name: string; long_name: string; url_slug: string };
  /** Resolved seeker domain for this network. */
  seeker: ResolvedDomain;
  /** Resolved provider domain for this network. */
  provider: ResolvedDomain;
}

/**
 * Builds a full resolved config from the fields that differ between networks.
 *
 * @param fixture - The per-network values to splice in.
 * @param overrides - Caller overrides applied last, as in the public builders.
 * @returns A complete {@link ResolvedNetworkConfig}.
 */
function buildConfig(
  fixture: NetworkFixture,
  overrides: Partial<ResolvedNetworkConfig>,
): ResolvedNetworkConfig {
  return {
    aggregator: {
      name: 'Test Aggregator',
      network: {
        source: `https://example.invalid/${fixture.networkId}/network.json`,
        csv_array_delimiter: '|',
      },
      brand: fixture.brand,
      onboarding: { presume_consent: true, bulk_max_rows: 10000 },
      admin_emails: [],
      registration_modes: {
        voice: {
          label_i18n_key: 'registration_mode.voice.label',
          submission_shape: 'account_only',
          public_hint_i18n_key: 'registration_mode.voice.hint',
          signals_cta: false,
        },
        form: {
          label_i18n_key: 'registration_mode.form.label',
          submission_shape: 'account_and_profile',
          public_hint_i18n_key: null,
          signals_cta: true,
        },
      },
      organisation: DEFAULT_ORGANISATION,
    },
    network: {
      id: fixture.networkId,
      domains: [
        { id: 'seeker', item_schemas: { [fixture.seeker.itemType]: {} } },
        { id: 'provider', item_schemas: { [fixture.provider.itemType]: {} } },
      ],
    },
    domains: { seeker: fixture.seeker, provider: fixture.provider },
    domainIds: ['seeker', 'provider'],
    ...overrides,
  };
}

/**
 * Returns a fixed blue_dot resolved config.
 *
 * Use it as the default when a test does not depend on the network.
 *
 * @param overrides - Fields to replace on the returned config.
 * @returns The pinned blue_dot config.
 */
export function buildBlueDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  return buildConfig(
    {
      networkId: 'blue_dot',
      brand: {
        short_name: 'Blue Dots',
        long_name: 'Blue Dots Aggregator Portal',
        url_slug: 'blue-dots',
      },
      seeker: {
        id: 'seeker',
        label: 'Seekers',
        pluralLabel: 'Seekers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'name', phone: 'phone', email: 'email' },
        guardianConsentRequired: false,
        goLiveRequired: [],
      },
      provider: {
        id: 'provider',
        label: 'Providers',
        pluralLabel: 'Providers',
        itemType: 'job_posting_1.0',
        schema: {},
        identity: {
          name: 'jobProviderName',
          phone: 'hiringManagerPhoneNumber',
          email: 'hiringManagerEmail',
        },
        guardianConsentRequired: false,
        goLiveRequired: [],
      },
    },
    overrides,
  );
}

/**
 * Returns a fixed purple_dot resolved config.
 *
 * Uses different identity field names from blue_dot, such as `beneficiary_name`.
 *
 * @param overrides - Fields to replace on the returned config.
 * @returns The pinned purple_dot config.
 */
export function buildPurpleDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  return buildConfig(
    {
      networkId: 'purple_dot',
      brand: {
        short_name: 'Purple Dots',
        long_name: 'Purple Dot Aggregator Portal',
        url_slug: 'purple-dots',
      },
      seeker: {
        id: 'seeker',
        label: 'Seekers',
        pluralLabel: 'Seekers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'beneficiary_name', phone: 'mobile_number', email: 'email' },
        guardianConsentRequired: false,
        goLiveRequired: [],
      },
      provider: {
        id: 'provider',
        label: 'Service Providers',
        pluralLabel: 'Service Providers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'contact_name', phone: 'contact_phone', email: 'contact_email' },
        guardianConsentRequired: false,
        goLiveRequired: [],
      },
    },
    overrides,
  );
}
