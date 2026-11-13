/**
 * Tests for `BulkUploadsClient` — the client body of the bulk-uploads page.
 *
 * Covers the Topbar wiring (back / refresh actions) and that the server-loaded
 * attestation prop is threaded through to `CSVUpload` unchanged, including
 * the `null` (unconfigured) case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type { BulkAttestationContent } from '@/lib/bulk-attestation.server';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {right}
    </div>
  ),
}));

const { csvUploadPropsSpy } = vi.hoisted(() => ({ csvUploadPropsSpy: vi.fn() }));
vi.mock('@/app/(protected)/onboarding/_components/CSVUpload', () => ({
  CSVUpload: (props: { attestation: BulkAttestationContent | null }) => {
    csvUploadPropsSpy(props);
    return <div data-testid="csv-upload">{props.attestation?.content ?? 'no-attestation'}</div>;
  },
}));

import { BulkUploadsClient } from '@/app/(protected)/onboarding/_components/BulkUploadsClient';

function renderClient(attestation: BulkAttestationContent | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <BulkUploadsClient attestation={attestation} />
    </NextIntlClientProvider>,
  );
}

describe('<BulkUploadsClient />', () => {
  beforeEach(() => {
    pushMock.mockClear();
    csvUploadPropsSpy.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('renders the page title/subtitle', () => {
    renderClient(null);
    expect(screen.getByText('Bulk Upload')).toBeInTheDocument();
    expect(screen.getByText('Import participants from a CSV file.')).toBeInTheDocument();
  });

  it('passes a non-null attestation through to CSVUpload unchanged', () => {
    const attestation: BulkAttestationContent = {
      version: 2,
      title: 'Attestation',
      content: 'I confirm consent from every listed participant.',
    };
    renderClient(attestation);
    expect(csvUploadPropsSpy).toHaveBeenCalledWith({ attestation });
    expect(screen.getByTestId('csv-upload')).toHaveTextContent(
      'I confirm consent from every listed participant.',
    );
  });

  it('passes null attestation through when unconfigured', () => {
    renderClient(null);
    expect(csvUploadPropsSpy).toHaveBeenCalledWith({ attestation: null });
    expect(screen.getByTestId('csv-upload')).toHaveTextContent('no-attestation');
  });

  it('navigates back to /onboarding on back click', async () => {
    const user = userEvent.setup();
    renderClient(null);
    await user.click(screen.getByText('Back to Onboarding'));
    expect(pushMock).toHaveBeenCalledWith('/onboarding');
  });

  it('reloads the window on refresh click', async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, reload: reloadSpy },
    });

    renderClient(null);
    await user.click(screen.getByText('Refresh'));
    expect(reloadSpy).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });
});
