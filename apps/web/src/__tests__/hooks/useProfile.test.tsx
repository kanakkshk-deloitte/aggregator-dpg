import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { profileService } from '@/services/profile.service';

vi.mock('@/services/profile.service', () => ({
  profileService: { get: vi.fn(), getRaw: vi.fn(), update: vi.fn(), edit: vi.fn() },
}));

const { useProfile, useProfileRaw } = await import('@/hooks/useProfile');

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

const svc = profileService as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('useProfile hooks', () => {
  afterEach(() => {
    for (const fn of Object.values(svc)) fn.mockReset();
  });

  it('useProfile resolves with the display-mapped profile', async () => {
    svc.get!.mockResolvedValue({ id: 'agg-1', org: 'TRRAIN' });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useProfile(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: 'agg-1', org: 'TRRAIN' });
  });

  it('useProfileRaw resolves with the raw API shape', async () => {
    svc.getRaw!.mockResolvedValue({ aggregator_id: 'agg-1' });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useProfileRaw(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ aggregator_id: 'agg-1' });
  });
});
