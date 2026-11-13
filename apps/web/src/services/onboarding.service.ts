/**
 * Onboarding service for the web app: registration links and bulk uploads.
 *
 * Runs in the browser and calls the BFF, which attaches the bearer token.
 */

import { jsonFetch } from './http';

export interface ApiRegistrationLink {
  link_id: string;
  slug: string;
  domain: string;
  status: 'draft' | 'live' | 'retired';
  /**
   * Registration mode key (e.g. `voice`, `form`), set at creation and
   * immutable. The network config maps modes to form shapes.
   */
  registration_mode?: string;
  context: Record<string, unknown>;
  expires_at: string | null;
  /** Set only while the link is live; `null` for drafts and retired links. */
  public_url: string | null;
  qr_url: string | null;
  qr_expires_at: string | null;
  /** Submission counters from the listing endpoint. Zero when there are none. */
  metrics?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  created_at: string;
  updated_at: string;
}

export interface ListLinksResponse {
  items: ApiRegistrationLink[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateLinkInput {
  domain: string;
  /** Optional human-readable slug. Server falls back to random when omitted. */
  slug?: string;
  /** Display label shown as the card title. Stored on `context.title`. */
  title?: string;
  context?: Record<string, unknown>;
  status?: 'draft' | 'live';
  /**
   * Registration mode key (e.g. `voice`, `form`), checked by the API against
   * the network config. Defaults to `form`. Immutable after creation.
   */
  registration_mode?: string;
  expires_at?: string | null;
}

/** Patch for `PATCH /api/links/:id`. Applies to drafts only; other links return 409. */
export interface UpdateLinkInput {
  slug?: string;
  context?: Record<string, unknown>;
  expires_at?: string | null;
}

export interface OnboardingSummary {
  aggregator_id: string;
  from: string | null;
  to: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** One entry-source slice of the onboarding rollup (`source` is `bulk` or `link`). */
export interface OnboardingSourceSlice {
  source: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface OnboardingBySource {
  aggregator_id: string;
  from: string | null;
  to: string | null;
  by_source: OnboardingSourceSlice[];
}

export interface BulkUploadCreateResponse {
  upload_id: string;
  upload_url: string;
  s3_key: string;
  expires_at: string;
  content_type: string;
  max_bytes: number;
  schema_id: string;
  schema_version: string;
  status: string;
}

export interface BulkUploadStatus {
  upload_id: string;
  status: string;
  status_reason: string | null;
  participant_type: string;
  total_rows: number | null;
  passed: number;
  failed: number;
  skipped: number;
  errors_csv_s3_key: string | null;
  schema_id: string;
  schema_version: string;
  created_at: string;
  completed_at: string | null;
}

export interface BulkUploadErrorsResponse {
  upload_id: string;
  url: string;
  s3_key: string;
  expires_at: string;
  content_type: string;
  counts: {
    total_rows: number | null;
    passed: number;
    failed: number;
    skipped: number;
  };
}

export const onboardingService = {
  async listLinks(
    opts: {
      domain?: string;
      status?: 'draft' | 'live' | 'retired';
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ListLinksResponse> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const data = await jsonFetch<ListLinksResponse>(`/api/links${qs ? `?${qs}` : ''}`);
    if (opts.domain) {
      return { ...data, items: data.items.filter((it) => it.domain === opts.domain) };
    }
    return data;
  },

  async createLink(input: CreateLinkInput): Promise<ApiRegistrationLink> {
    return jsonFetch<ApiRegistrationLink>('/api/links', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateLink(id: string, patch: UpdateLinkInput): Promise<ApiRegistrationLink> {
    return jsonFetch<ApiRegistrationLink>(`/api/links/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async activateLink(id: string): Promise<ApiRegistrationLink> {
    return jsonFetch<ApiRegistrationLink>(`/api/links/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    });
  },

  async deactivateLink(id: string): Promise<ApiRegistrationLink> {
    return jsonFetch<ApiRegistrationLink>(`/api/links/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    });
  },

  async summary(opts: { from?: string; to?: string } = {}): Promise<OnboardingSummary> {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    const qs = params.toString();
    return jsonFetch<OnboardingSummary>(`/api/onboarding/summary${qs ? `?${qs}` : ''}`);
  },

  async bySource(opts: { from?: string; to?: string } = {}): Promise<OnboardingBySource> {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    const qs = params.toString();
    return jsonFetch<OnboardingBySource>(`/api/onboarding/by-source${qs ? `?${qs}` : ''}`);
  },

  async createBulkUpload(participantType: string): Promise<BulkUploadCreateResponse> {
    return jsonFetch<BulkUploadCreateResponse>('/api/bulk-uploads', {
      method: 'POST',
      body: JSON.stringify({ participant_type: participantType }),
    });
  },

  async startBulkUpload(uploadId: string, attestation: boolean): Promise<BulkUploadStatus> {
    return jsonFetch<BulkUploadStatus>(`/api/bulk-uploads/${encodeURIComponent(uploadId)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attestation }),
    });
  },

  async readBulkUpload(uploadId: string): Promise<BulkUploadStatus> {
    return jsonFetch<BulkUploadStatus>(`/api/bulk-uploads/${encodeURIComponent(uploadId)}`);
  },

  async listBulkUploads(opts: { limit?: number; offset?: number } = {}): Promise<{
    items: BulkUploadStatus[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return jsonFetch(`/api/bulk-uploads/list${qs ? `?${qs}` : ''}`);
  },

  async errorsCsvUrl(uploadId: string): Promise<BulkUploadErrorsResponse> {
    return jsonFetch<BulkUploadErrorsResponse>(
      `/api/bulk-uploads/${encodeURIComponent(uploadId)}/errors`,
    );
  },

  /**
   * Runs a bulk upload: presign, PUT to S3, then start.
   *
   * `duplicate` is true when the file matches a prior upload; the existing run is returned.
   *
   * @param file - The CSV file.
   * @param participantType - Domain of the rows.
   * @param attestation - Whether the coordinator accepted the attestation.
   * @returns The upload id and status.
   * @throws {Error} If the S3 upload or an API call fails.
   */
  async uploadCsv(
    file: File,
    participantType: string,
    attestation: boolean,
  ): Promise<{
    uploadId: string;
    status: BulkUploadStatus;
    duplicate?: boolean;
    message?: string;
  }> {
    const presigned = await this.createBulkUpload(participantType);
    const put = await fetch(presigned.upload_url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': presigned.content_type },
    });
    if (!put.ok) {
      throw new Error(`S3 PUT failed (${put.status}): ${await put.text().catch(() => '')}`);
    }
    const status = (await this.startBulkUpload(
      presigned.upload_id,
      attestation,
    )) as BulkUploadStatus & {
      duplicate?: boolean;
      message?: string;
    };
    const out: {
      uploadId: string;
      status: BulkUploadStatus;
      duplicate?: boolean;
      message?: string;
    } = {
      uploadId: status.upload_id,
      status,
    };
    if (status.duplicate) out.duplicate = true;
    if (status.message) out.message = status.message;
    return out;
  },
};
