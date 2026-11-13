/**
 * Test: `(public)/layout.tsx` — the shell shared by `/login` and `/register`.
 *
 * The layout used to pin light theme via `bd-public-light`. That is gone, so
 * the assertion is inverted: the class must NOT come back, because its return
 * would silently make the login page the one surface a dark-mode user cannot
 * escape. The corner slot now carries both the language and theme controls.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/shell/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div data-testid="lang-switcher" />,
}));
vi.mock('@/components/shell/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

import PublicAuthLayout from '@/app/(public)/layout';

describe('<PublicAuthLayout />', () => {
  it('does not pin light theme, and renders its children', () => {
    const { container } = render(
      <PublicAuthLayout>
        <div data-testid="child">hello</div>
      </PublicAuthLayout>,
    );
    expect(container.querySelector('.bd-public-light')).not.toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('renders the language switcher and theme toggle in the top-right slot', () => {
    render(
      <PublicAuthLayout>
        <div />
      </PublicAuthLayout>,
    );
    expect(screen.getByTestId('lang-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });
});
