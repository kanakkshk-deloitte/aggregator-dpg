export type ParticipantStatus = 'active' | 'satisfied' | 'at-risk' | 'inactive';

export type ProfileStatus = 'complete' | 'incomplete';

export interface ParticipantStats {
  total: number;
  shortlisted?: number;
  /** `accept` bucket. */
  accepted?: number;
  /** `reject` bucket. */
  rejected: number;
  /** `create` bucket. */
  pending: number;
  /** `cancel` bucket. */
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
  /** Actions this profile initiated, by action state. */
  initiated: DirectionalStats;
  /** Actions this profile received, by action state. */
  received: DirectionalStats;
  status: ParticipantStatus;
  last: string;
  /**
   * Signals `actionable_tags` for the row (e.g. `missing_contact_phone`).
   * Drives the Recommended Action column.
   */
  actionableTags?: string[];
  /**
   * Lifecycle bucket for the row. Items without a lifecycle status show as
   * `'live'`. Undefined when the row has no Signals item.
   */
  lifecycle_status?: LifecycleStatus;
}

export type Seeker = ParticipantBase;

export interface Provider extends ParticipantBase {
  role: string;
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
