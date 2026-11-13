import type { AggregatorProfile } from '../types';
import { jsonFetch } from './http';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  /** Raw read of the API response (pre-mapping) for form pre-fill. */
  getRaw(): Promise<ProfileApiResponse>;
}

/**
 * Shape of `contact` on `GET /v1/aggregators/profile/me`.
 *
 * Mirrors `BecknContactSchema` in `@aggregator-dpg/shared-primitives/beckn`.
 */
interface BecknContact {
  name: string;
  phone: string;
  email: string;
  alternatePhone?: string;
  company?: string;
  gstNumber?: string;
}

interface BecknLocation {
  geo: { type: string; coordinates?: unknown };
  address?: Record<string, string | undefined>;
}

/** Response of `GET /v1/aggregators/profile/me`, plus the Keycloak `identity` fragment. */
export interface ProfileApiResponse {
  aggregator_id: string;
  org_slug: string;
  org_name: string;
  actor_type: 'aggregator' | 'seeker' | 'provider';
  // Domain id from the network config; any network domain is possible.
  type: string | null;
  url: string | null;
  contact: BecknContact;
  locations: BecknLocation[];
  // From the consent ledger; null when it has no registration row.
  consent: { value: boolean; given_at: string; valid_till: string } | null;
  status: 'pending' | 'active' | 'inactive' | 'retired';
  identity?: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    active: boolean;
  };
  created_at: string;
  updated_at: string;
}

class ApiProfileService implements ProfileService {
  async get(): Promise<AggregatorProfile> {
    const body = await this.getRaw();
    return mapToAggregatorProfile(body);
  }

  async getRaw(): Promise<ProfileApiResponse> {
    return jsonFetch<ProfileApiResponse>('/api/aggregator/profile/me');
  }
}

function mapToAggregatorProfile(api: ProfileApiResponse): AggregatorProfile {
  // Use contact.name, else the Keycloak first and last name.
  const identityFull = [api.identity?.first_name, api.identity?.last_name]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' ');
  const coordinator = api.contact?.name || identityFull;

  // First location's address as one line.
  const firstLoc = api.locations?.[0]?.address;
  const address = firstLoc
    ? [
        firstLoc.streetAddress,
        firstLoc.addressLocality,
        firstLoc.addressRegion,
        firstLoc.postalCode,
      ]
        .filter((p): p is string => Boolean(p && p.length > 0))
        .join(', ')
    : '';

  // Older rows have `addressRegion`; newer rows only have `streetAddress`.
  const geographies = (api.locations ?? [])
    .map((loc) => loc.address?.addressRegion || loc.address?.streetAddress)
    .filter((r): r is string => Boolean(r && r.length > 0))
    .join(' · ');

  const fmtDate = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  return {
    id: api.aggregator_id,
    org: api.org_name || '',
    registered: fmtDate(api.created_at),
    coordinator,
    contact: {
      name: coordinator,
      mobile: api.contact?.phone ?? api.identity?.phone ?? '',
      email: api.contact?.email ?? api.identity?.email ?? '',
    },
    // Not rendered anywhere; kept to satisfy the display type.
    beneficiaries: '',
    address,
    geographies,
    sectors: '',
    network: {
      activeSeekers: 0,
      openRoles: 0,
      hires3mo: 0,
      matchRate: '—',
    },
    consent: {
      profileCreation: Boolean(api.consent?.value),
      sharing: false,
      notifications: false,
      analytics: false,
      marketing: false,
      retention: false,
      lastReviewed: fmtDate(api.updated_at),
    },
  };
}

export const profileService: ProfileService = new ApiProfileService();
