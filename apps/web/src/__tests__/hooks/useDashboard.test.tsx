import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dashboardService } from '@/services/dashboard.service';

vi.mock('@/services/dashboard.service', () => ({
  dashboardService: {
    dashboard: vi.fn(),
  },
}));

const { useDashboard } = await import('@/hooks/useDashboard');

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDashboard', () => {
  afterEach(() => {
    vi.mocked(dashboardService.dashboard).mockReset();
  });

  it('stays disabled until a domain is provided', () => {
    const { result } = renderHook(() => useDashboard(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches the dashboard payload once domain is set', async () => {
    vi.mocked(dashboardService.dashboard).mockResolvedValue({
      by_domain: {},
      metadata: { last_computed_at: '2026-01-01', ttl_seconds: 60, refreshed: false },
    });
    const { result } = renderHook(() => useDashboard({ domain: 'seeker' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dashboardService.dashboard).toHaveBeenCalledWith({ domain: 'seeker' });
  });
});
