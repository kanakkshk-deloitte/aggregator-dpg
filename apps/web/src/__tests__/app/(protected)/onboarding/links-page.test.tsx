/**
 * Smoke test for the registration-links page
 * (`app/(protected)/onboarding/links/page.tsx`).
 *
 * A thin client wrapper: Topbar chrome (back/refresh) + `CreateLinkSection`.
 * `CreateLinkSection` is stubbed since it's covered in depth by
 * `RegistrationLinksSection.test.tsx`; this file only exercises the page's
 * own composition and navigation wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

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

vi.mock('@/app/(protected)/onboarding/_components/RegistrationLinksSection', () => ({
  CreateLinkSection: () => <div data-testid="create-link-section" />,
}));

import RegistrationLinksPage from '@/app/(protected)/onboarding/links/page';

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <RegistrationLinksPage />
    </NextIntlClientProvider>,
  );
}

describe('RegistrationLinksPage', () => {
  beforeEach(() => pushMock.mockClear());
  afterEach(() => vi.clearAllMocks());

  it('renders the title/subtitle and the create-link section', () => {
    renderPage();
    expect(screen.getByText('Registration Links')).toBeInTheDocument();
    expect(
      screen.getByText('Generate, share, and manage public registration links.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('create-link-section')).toBeInTheDocument();
  });

  it('navigates back to /onboarding on back click', async () => {
    const user = userEvent.setup();
    renderPage();
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

    renderPage();
    await user.click(screen.getByText('Refresh'));
    expect(reloadSpy).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });
});
