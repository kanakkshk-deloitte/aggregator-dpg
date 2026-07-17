export type ParticipantStatus = 'active' | 'satisfied' | 'at-risk' | 'inactive';

export type ProfileStatus = 'complete' | 'incomplete';

export interface ParticipantStats {
  total: number;
  shortlisted?: number;
  /** accept bucket — "Connected" for purple_dot. */
  accepted?: number;
  /** reject bucket — "Declined" for purple_dot. */
  rejected: number;
  /** create bucket — "Requested" for purple_dot. */
  pending: number;
  /** cancel bucket — "Cancelled". */
  cancelled?: number;
}

export interface ParticipantProfile {
  title: string;
  exp: string;
  verified: boolean;
  complete: number;
}

/** One direction's action counts, keyed by canonical action state. */
export interface DirectionalStats {
  create: number;
  accept: number;
  reject: number;
  cancel: number;
}

export type LifecycleStatus = 'draft' | 'live' | 'paused';

export interface ParticipantBase {
  id: string;
  name: string;
  city: string;
  joined: string;
  avatar: string;
  profile: ParticipantProfile;
  applied: ParticipantStats;
  /** Actions this profile INITIATED, by canonical action state. */
  initiated: DirectionalStats;
  /** Actions this profile RECEIVED, by canonical action state. */
  received: DirectionalStats;
  status: ParticipantStatus;
  last: string;
  /**
   * Signalstack-computed `actionable_tags` for the row, e.g.
   * `missing_contact_phone`. Drives the Recommended Action column.
   * Empty when signalstack returns no tags.
   */
  actionableTags?: string[];
  /**
   * Onboarding lifecycle bucket for the row. Sourced from
   * `/v1/dashboard/items` (which normalises via `resolveLifecycle` so
   * legacy items without `lifecycle_status` surface as `'live'`).
   * Undefined when the lifecycle fetch hasn't resolved yet or this row
   * has no associated signals item.
   */
  lifecycle_status?: LifecycleStatus;
}

export type Seeker = ParticipantBase;

export interface Provider extends ParticipantBase {
  role: string;
}

export type OpportunityProvider = Provider;

export type ParticipantKind = 'seeker' | 'provider' | 'opp';

export interface ParticipantFilter {
  kind?: ParticipantKind;
  status?: ParticipantStatus;
  city?: string;
  search?: string;
}

export interface User {
  id: string;
  name: string;
  org: string;
  /** Coordinator email from the session, when present. Prefills the support form. */
  email?: string;
  /** Coordinator phone from the session, when present. Prefills the support form. */
  phone?: string;
}

export interface RegistrationLink {
  id: string;
  title: string;
  desc: string;
  slug: string;
  kind: 'Seeker' | 'Provider';
  regs: number;
  verified: number;
  last: string;
  active: boolean;
}

export interface RegistrationFormState {
  org: string;
  state: string;
  lever: string;
  date: string;
  location: string;
  district: string;
  domain: 'Seeker' | 'Provider' | 'Both';
  signal: 'Event' | 'Outreach' | 'Partner' | 'Walk-in';
  sub: 'On-ground' | 'Online' | 'Referral';
  full: string;
  type: 'Walk-in' | 'Campaign' | 'Referral' | 'Direct';
}

export interface AggregatorProfile {
  id: string;
  org: string;
  registered: string;
  coordinator: string;
  contact: {
    name: string;
    mobile: string;
    email: string;
  };
  beneficiaries: string;
  address: string;
  geographies: string;
  sectors: string;
  network: {
    activeSeekers: number;
    openRoles: number;
    hires3mo: number;
    matchRate: string;
  };
  consent: {
    profileCreation: boolean;
    sharing: boolean;
    notifications: boolean;
    analytics: boolean;
    marketing: boolean;
    retention: boolean;
    lastReviewed: string;
  };
}
