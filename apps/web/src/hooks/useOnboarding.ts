'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  onboardingService,
  type ApiRegistrationLink,
  type CreateLinkInput,
  type OnboardingBySource,
  type OnboardingSummary,
  type UpdateLinkInput,
} from '../services/onboarding.service';

export function useRegistrationLinks(domain: string) {
  return useQuery<ApiRegistrationLink[]>({
    queryKey: ['onboarding', 'links', domain],
    queryFn: async () => {
      const res = await onboardingService.listLinks({ domain });
      return res.items;
    },
    staleTime: 15_000,
  });
}

export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLinkInput) => onboardingService.createLink(input),
    onSuccess: (link) => {
      qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useUpdateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLinkInput }) =>
      onboardingService.updateLink(id, patch),
    onSuccess: (link) => {
      qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useActivateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => onboardingService.activateLink(id),
    onSuccess: (link) => {
      qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useDeactivateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => onboardingService.deactivateLink(id),
    onSuccess: (link) => {
      qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useOnboardingSummary() {
  return useQuery<OnboardingSummary>({
    queryKey: ['onboarding', 'summary'],
    queryFn: () => onboardingService.summary(),
    staleTime: 30_000,
  });
}

/**
 * Fetches onboarding counters grouped by entry source (`bulk` / `link`).
 *
 * @returns The React Query result for the by-source counters.
 */
export function useOnboardingBySource() {
  return useQuery<OnboardingBySource>({
    queryKey: ['onboarding', 'by-source'],
    queryFn: () => onboardingService.bySource(),
    staleTime: 30_000,
  });
}

export function useBulkUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      participantType,
      attestation,
    }: {
      file: File;
      participantType: string;
      attestation: boolean;
    }) => onboardingService.uploadCsv(file, participantType, attestation),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding', 'summary'] });
    },
  });
}

export function useRecentBulkUploads(limit = 10) {
  return useQuery({
    queryKey: ['onboarding', 'bulk-uploads', 'list', limit],
    queryFn: () => onboardingService.listBulkUploads({ limit }),
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const inFlight = items.some((it) =>
        ['pending', 'uploaded', 'file_validating', 'row_processing', 'finalising'].includes(
          it.status,
        ),
      );
      return inFlight ? 3000 : false;
    },
    staleTime: 5_000,
  });
}
