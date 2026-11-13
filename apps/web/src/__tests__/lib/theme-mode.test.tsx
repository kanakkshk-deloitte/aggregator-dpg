import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeModeProvider, useThemeMode, THEME_STORAGE_KEY } from '@/lib/theme-mode';

function Consumer() {
  const { mode, setMode, toggle } = useThemeMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={toggle}>toggle</button>
      <button onClick={() => setMode('dark')}>set-dark</button>
    </div>
  );
}

describe('ThemeModeProvider / useThemeMode', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light and applies no dark class', () => {
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('hydrates from a previously stored preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
  });

  it('toggle flips between light and dark and persists the choice', () => {
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
  });

  it('setMode sets an explicit value', () => {
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    fireEvent.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('tolerates localStorage.setItem throwing (private mode / quota)', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    render(
      <ThemeModeProvider>
        <Consumer />
      </ThemeModeProvider>,
    );
    expect(() => fireEvent.click(screen.getByText('toggle'))).not.toThrow();
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    spy.mockRestore();
  });

  it('useThemeMode throws when used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/useThemeMode must be used inside/);
    spy.mockRestore();
  });
});
