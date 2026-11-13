'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { dashboardService, type DashboardQuery } from '../services/dashboard.service';

/**
 * Reads the aggregator dashboard payload from Signals.
 *
 * Omit `status` for the full rollup and unfiltered items. Pass
 * `refresh: true` to bypass the rollup cache upstream.
 *
 * @param query - Domain (required to run), filters and paging.
 * @returns The React Query result for the dashboard page.
 */
export function useDashboard(query?: DashboardQuery) {
  // Domain comes from the network config; there is no default.
  const domain = query?.domain;
  const status = query?.status ?? null;
  const lifecycle = query?.lifecycle ?? null;
  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const refresh = query?.refresh ?? false;
  return useQuery({
    // Every filter, including refresh, is part of the key so a change refetches.
    queryKey: [
      'dashboard',
      'dashboard',
      domain ?? '(no-domain)',
      status,
      lifecycle,
      page,
      limit,
      refresh,
    ],
    queryFn: () => dashboardService.dashboard(query),
    enabled: Boolean(domain),
    staleTime: 0,
    // Keep the previous page shown while the next loads, so the table stays
    // mounted and keeps its cross-page selection.
    placeholderData: keepPreviousData,
  });
}
