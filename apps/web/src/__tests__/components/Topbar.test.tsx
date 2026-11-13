import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { toggle, useThemeMode } = vi.hoisted(() => ({
  toggle: vi.fn(),
  useThemeMode: vi.fn(),
}));

vi.mock('@/lib/theme-mode', () => ({ useThemeMode }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      switch_to_light: 'Switch to light theme',
      switch_to_dark: 'Switch to dark theme',
      toggle_aria: 'Toggle theme',
    };
    return map[key] ?? key;
  },
}));
// Real LanguageSwitcher needs an EnabledLocalesProvider above it (the root
// layout supplies one) — stub it out here since Topbar's own behaviour, not
// LanguageSwitcher's, is under test.
vi.mock('@/components/shell/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));

import { Topbar } from '@/components/shell/Topbar';

beforeEach(() => {
  toggle.mockClear();
  useThemeMode.mockReturnValue({ mode: 'light', toggle });
});

describe('<Topbar />', () => {
  it('renders the title', () => {
    render(<Topbar title="Dashboard" />);
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<Topbar title="Dashboard" subtitle="All your participants" />);
    expect(screen.getByText('All your participants')).toBeInTheDocument();
  });

  it('omits the subtitle paragraph when not provided', () => {
    const { container } = render(<Topbar title="Dashboard" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders the `right` slot content', () => {
    render(<Topbar title="Dashboard" right={<button>Export</button>} />);
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('shows the moon icon and "switch to dark" hint in light mode', () => {
    useThemeMode.mockReturnValue({ mode: 'light', toggle });
    render(<Topbar title="Dashboard" />);
    const btn = screen.getByRole('button', { name: 'Toggle theme' });
    expect(btn).toHaveAttribute('title', 'Switch to dark theme');
  });

  it('shows the sun icon and "switch to light" hint in dark mode', () => {
    useThemeMode.mockReturnValue({ mode: 'dark', toggle });
    render(<Topbar title="Dashboard" />);
    const btn = screen.getByRole('button', { name: 'Toggle theme' });
    expect(btn).toHaveAttribute('title', 'Switch to light theme');
  });

  it('calls toggle when the theme button is clicked', () => {
    render(<Topbar title="Dashboard" />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('renders the LanguageSwitcher alongside the theme toggle', () => {
    render(<Topbar title="Dashboard" />);
    expect(screen.getByTestId('language-switcher')).toBeInTheDocument();
  });
});
