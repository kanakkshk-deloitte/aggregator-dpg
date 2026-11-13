'use client';

import { useQuery } from '@tanstack/react-query';
import { profileService } from '../services/profile.service';

const QUERY_KEY = ['profile'] as const;
const RAW_QUERY_KEY = ['profile', 'raw'] as const;

export function useProfile() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => profileService.get(),
  });
}

/**
 * Fetches the profile in its raw API shape, before display mapping.
 *
 * @returns The React Query result for the raw profile.
 */
export function useProfileRaw() {
  return useQuery({
    queryKey: RAW_QUERY_KEY,
    queryFn: () => profileService.getRaw(),
  });
}
