import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const { refresh, setLocale } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setLocale: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => (key === 'label' ? 'Language' : key),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/i18n/locale-cookie', () => ({ setLocale }));

import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { EnabledLocalesProvider, useEnabledLocales } from '@/i18n/EnabledLocalesProvider';
import type { Locale } from '@/i18n/config';

// The switcher takes its locale list from context, never from process.env —
// it is a client component, so an env read there would be build-time inlined.
// Tests therefore state the enabled set explicitly.
function renderSwitcher(enabled: Locale[]) {
  return render(
    <EnabledLocalesProvider value={enabled}>
      <LanguageSwitcher />
    </EnabledLocalesProvider>,
  );
}

// jsdom does not implement scrollIntoView; Radix Select's open-item-scroll
// logic calls it unconditionally when the content mounts. Stub it locally
// (rather than in the shared test setup) since only Select-opening tests
// need it.
beforeEach(() => {
  refresh.mockClear();
  setLocale.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe('<LanguageSwitcher />', () => {
  it('renders a trigger labelled with the language label when >1 locale enabled', () => {
    renderSwitcher(['en', 'kn', 'hi']);
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
  });

  it('renders nothing when fewer than two locales are enabled', () => {
    const { container } = renderSwitcher(['en']);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers only the enabled locales, so a disabled language is unreachable', async () => {
    // The whole point of the runtime list: dropping `kn` must remove the option
    // rather than merely reject it after the click.
    renderSwitcher(['en', 'hi']);
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('हिन्दी')).toBeInTheDocument();
    expect(screen.queryByText('ಕನ್ನಡ')).not.toBeInTheDocument();
  });

  it('persists the new locale and refreshes the route on selection', async () => {
    renderSwitcher(['en', 'kn', 'hi']);
    // Radix Select's trigger is a native <button role="combobox">; open it and
    // pick the "kn" item via its accessible role rather than simulating a
    // native <select> change event (Select is not a native element here).
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByText('ಕನ್ನಡ');
    fireEvent.click(option);
    await vi.waitFor(() => expect(setLocale).toHaveBeenCalledWith('kn'));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('renders nothing without a provider, rather than offering every language', () => {
    // The safety property of the fallback: a mis-wired subtree must never
    // surface a language the deployment switched off. English-only means the
    // switcher hides itself instead.
    const { container } = render(<LanguageSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<EnabledLocalesProvider />', () => {
  it('passes the list through to consumers unchanged', () => {
    function Probe(): ReactNode {
      return <span data-testid="probe">{useEnabledLocales().join(',')}</span>;
    }
    render(
      <EnabledLocalesProvider value={['en', 'hi']}>
        <Probe />
      </EnabledLocalesProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('en,hi');
  });
});
