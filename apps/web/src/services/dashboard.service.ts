/**
 * Dashboard service for the web app.
 *
 * Reads the aggregator dashboard (rollup and participant rows) through the
 * BFF. Signals scopes every read to the caller's org, so this service does
 * no ownership filtering.
 */

import { jsonFetch } from './http';

/**
 * Query for the aggregator dashboard.
 *
 * Omit `status` to get full by-status counts and an unfiltered list.
 */
export interface DashboardQuery {
  domain?: string;
  page?: number;
  limit?: number;
  status?: string;
  /**
   * Server-side lifecycle filter for the participant list. Omit it to get
   * the default draft + live set.
   */
  lifecycle?: 'draft' | 'live';
  /**
   * When true, Signals bypasses the rollup cache and recomputes.
   * Set it only for user-initiated refreshes.
   */
  refresh?: boolean;
}

/** Pre-computed participant and action counts for one domain. */
export interface DashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Record<string, number>;
  by_initiated_action_status: Record<string, number>;
  by_received_action_status: Record<string, number>;
  total_users: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}

/** Per-domain slice of the dashboard payload: rollup and paginated items. */
export interface DashboardDomainSlice {
  rollup: DashboardRollup;
  /** One row per item. */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}

/** Signals metadata about the cached rollup, used for the "last updated" hint. */
export interface DashboardMetadata {
  last_computed_at: string;
  ttl_seconds: number;
  refreshed: boolean;
}

/** Full dashboard payload, with every domain keyed by id in `by_domain`. */
export interface DashboardPage {
  by_domain: Record<string, DashboardDomainSlice>;
  metadata: DashboardMetadata;
}

/**
 * Lifecycle bucket a dashboard row can be in.
 *
 * The API accepts all four; the dashboard dropdown offers only `draft` and `live`.
 */
export type LifecycleFilter = 'draft' | 'live' | 'paused' | 'account_only';

/** Query for the dashboard CSV export. Only `status` is supported as a filter. */
export interface DashboardExportQuery {
  domain?: string;
  status?: string;
}

/**
 * Result of a dashboard CSV download.
 *
 * `filename` comes from the `Content-Disposition` header, or a default.
 */
export interface DashboardExportResult {
  blob: Blob;
  filename: string;
  /**
   * Number of requested rows the API withheld, from `X-Export-Skipped-Count`.
   *
   * Set only by the profile export, which drops item ids that are not this
   * aggregator's. `undefined` when the header is absent.
   */
  skippedCount?: number;
}

/**
 * Bulk action request for selected dashboard rows.
 * The BFF checks `action` against its allowlist.
 */
export interface DashboardBulkActionInput {
  action: string;
  domain: string;
  ids: string[];
}

/** Acknowledgement from the bulk-action endpoint (202 envelope). */
export interface DashboardBulkActionResult {
  accepted: number;
}

export interface DashboardService {
  /**
   * Fetches the aggregator dashboard payload.
   *
   * @param query - Domain (required), filters and paging.
   * @returns The dashboard page.
   * @throws {Error} If `domain` is missing or the request fails.
   */
  dashboard(query?: DashboardQuery): Promise<DashboardPage>;
  /**
   * Downloads the dashboard as a CSV file.
   *
   * Pass the result to {@link triggerCsvDownload} to save it. Columns come from Signals as-is.
   *
   * @param query - Domain (required) and optional status filter.
   * @returns The CSV blob and filename.
   * @throws {Error} If `domain` is missing or the request fails.
   */
  dashboardExport(query?: DashboardExportQuery): Promise<DashboardExportResult>;
  /**
   * Submits a bulk action (e.g. `trigger_callback`) for the selected rows.
   *
   * Delivery is asynchronous and currently stubbed.
   *
   * @param input - Action name, domain and row ids.
   * @returns The 202 acknowledgement.
   * @throws {Error} If an input is missing or the request fails.
   */
  dashboardBulkAction(input: DashboardBulkActionInput): Promise<DashboardBulkActionResult>;
  /**
   * Downloads decrypted profile data for the selected items as a CSV file.
   *
   * Ids that are not this aggregator's are dropped; `skippedCount` reports how many.
   *
   * @param input - Domain and item ids.
   * @returns The CSV blob, filename and optional skipped count.
   * @throws {Error} If an input is missing or the request fails.
   */
  dashboardExportProfiles(input: {
    domain: string;
    itemIds: string[];
  }): Promise<DashboardExportResult>;
}

class HttpDashboardService implements DashboardService {
  async dashboard(query?: DashboardQuery): Promise<DashboardPage> {
    const params = new URLSearchParams();
    // Domain is required and has no default; it comes from the network config.
    if (!query?.domain) throw new Error('dashboard query requires `domain`');
    params.set('domain', query.domain);
    if (query?.page !== undefined) params.set('page', String(query.page));
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    // No `status` means the full rollup and an unfiltered list.
    if (query?.status) params.set('status', query.status);
    if (query?.lifecycle) params.set('lifecycle', query.lifecycle);
    if (query?.refresh) params.set('refresh', 'true');
    const url = `/api/dashboard?${params.toString()}`;
    return jsonFetch<DashboardPage>(url);
  }

  async dashboardExport(query?: DashboardExportQuery): Promise<DashboardExportResult> {
    const params = new URLSearchParams();
    if (!query?.domain) throw new Error('dashboardExport query requires `domain`');
    params.set('domain', query.domain);
    if (query?.status) params.set('status', query.status);
    const url = `/api/dashboard/export?${params.toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/csv' },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      // Use the upstream error message when the body has one.
      let message = `dashboard export failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = body?.error?.detail ?? body?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      parseFilenameFromContentDisposition(disposition) ?? defaultExportFilename(query);
    return { blob, filename };
  }

  async dashboardExportProfiles(input: {
    domain: string;
    itemIds: string[];
  }): Promise<DashboardExportResult> {
    if (!input.domain) throw new Error('dashboardExportProfiles requires `domain`');
    if (!input.itemIds.length)
      throw new Error('dashboardExportProfiles requires at least one item id');
    const res = await fetch('/api/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      credentials: 'same-origin',
      body: JSON.stringify({ item_ids: input.itemIds, domain: input.domain }),
    });
    if (!res.ok) {
      // Use the upstream error message when the body has one.
      let message = `profile export failed: ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = errBody?.error?.detail ?? errBody?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      parseFilenameFromContentDisposition(disposition) ?? `profiles-${input.domain}.csv`;
    // A missing, empty or non-numeric header means no count, not zero.
    // `Number(null)` and `Number('')` are 0, so guard before converting.
    const rawHeader = res.headers.get('x-export-skipped-count')?.trim();
    const rawSkipped = rawHeader ? Number(rawHeader) : Number.NaN;
    const skippedCount = Number.isInteger(rawSkipped) && rawSkipped >= 0 ? rawSkipped : undefined;
    return { blob, filename, ...(skippedCount === undefined ? {} : { skippedCount }) };
  }

  async dashboardBulkAction(input: DashboardBulkActionInput): Promise<DashboardBulkActionResult> {
    if (!input.action) throw new Error('dashboardBulkAction requires `action`');
    if (!input.domain) throw new Error('dashboardBulkAction requires `domain`');
    if (input.ids.length === 0) throw new Error('dashboardBulkAction requires at least one id');
    const res = await fetch('/api/dashboard/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      let message = `bulk action failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = body?.error?.detail ?? body?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    return (await res.json()) as DashboardBulkActionResult;
  }
}
export const dashboardService: DashboardService = new HttpDashboardService();

/**
 * Triggers a browser download for a CSV blob.
 *
 * Does nothing during server rendering.
 *
 * @param result - The CSV blob and filename to save.
 */
export function triggerCsvDownload(result: DashboardExportResult): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Reads the RFC 6266 `filename*=charset'lang'value` parameter.
 *
 * Uses index lookups instead of a single regex so a hostile header cannot
 * cause super-linear backtracking.
 *
 * @param header - The raw `Content-Disposition` header value.
 * @returns The decoded filename, or `null` when the parameter is absent,
 *   truncated, or not valid percent-encoding.
 */
function parseEncodedFilename(header: string): string | null {
  const starKey = /filename\*\s*=/i.exec(header);
  if (!starKey) return null;

  const afterKey = header.slice(starKey.index + starKey[0].length);
  const quoted = afterKey.indexOf("''");
  if (quoted === -1) return null;

  const rest = afterKey.slice(quoted + 2);
  const end = rest.indexOf(';');
  const value = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding; the caller falls back to the plain form.
    return null;
  }
}

/**
 * Extracts the filename from a `Content-Disposition` header.
 *
 * @param header - The raw header value.
 * @returns The filename, or `null` if absent or malformed.
 */
function parseFilenameFromContentDisposition(header: string): string | null {
  if (!header) return null;
  // Prefer the encoded `filename*` form, then plain `filename=`.
  const encoded = parseEncodedFilename(header);
  if (encoded !== null) return encoded;
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain && plain[1] ? plain[1].trim() : null;
}

/**
 * Default export filename when the BFF sends no `Content-Disposition`.
 *
 * Matches the API's format.
 */
function defaultExportFilename(query?: DashboardExportQuery): string {
  const status = (query?.status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${status}-${date}.csv`;
}
