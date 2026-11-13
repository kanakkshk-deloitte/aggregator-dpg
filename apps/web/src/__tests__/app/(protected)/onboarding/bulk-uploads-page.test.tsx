/**
 * Smoke test for the bulk-uploads server page
 * (`app/(protected)/onboarding/bulk-uploads/page.tsx`).
 *
 * The page itself has no logic beyond "load the attestation server-side,
 * hand it to the client body" — so this covers both branches of
 * `loadBulkAttestation` (configured / null) and confirms the prop is
 * forwarded, without re-testing `BulkUploadsClient`'s own behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { loadBulkAttestation } = vi.hoisted(() => ({ loadBulkAttestation: vi.fn() }));
vi.mock('@/lib/bulk-attestation.server', () => ({
  loadBulkAttestation: () => loadBulkAttestation(),
}));

const { clientPropsSpy } = vi.hoisted(() => ({ clientPropsSpy: vi.fn() }));
vi.mock('@/app/(protected)/onboarding/_components/BulkUploadsClient', () => ({
  BulkUploadsClient: (props: { attestation: unknown }) => {
    clientPropsSpy(props);
    return <div data-testid="bulk-uploads-client" />;
  },
}));

import BulkUploadsPage from '@/app/(protected)/onboarding/bulk-uploads/page';

describe('BulkUploadsPage (server component)', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards a configured attestation to the client body', async () => {
    const attestation = { version: 1, title: 'T', content: 'C' };
    loadBulkAttestation.mockResolvedValue(attestation);

    const el = await BulkUploadsPage();
    render(el);

    expect(clientPropsSpy).toHaveBeenCalledWith({ attestation });
    expect(screen.getByTestId('bulk-uploads-client')).toBeInTheDocument();
  });

  it('forwards null when the attestation is unconfigured', async () => {
    loadBulkAttestation.mockResolvedValue(null);

    const el = await BulkUploadsPage();
    render(el);

    expect(clientPropsSpy).toHaveBeenCalledWith({ attestation: null });
  });
});
