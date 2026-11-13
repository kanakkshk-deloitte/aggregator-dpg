'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/**
 * localStorage key for the user's chosen theme.
 *
 * Also read by the inline script in `app/layout.tsx` before hydration, so the
 * first paint uses the stored theme.
 */
export const THEME_STORAGE_KEY = 'bd:theme-mode';

/**
 * Applies the light/dark mode to `<html>` and saves it to localStorage.
 *
 * Defaults to `light`; loads a stored preference on mount.
 *
 * @param children - Subtree that may call `useThemeMode`.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');

  // Server markup is always light; load the stored choice on the client.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      setModeState(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (mode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Storage may be unavailable; the theme still applies for this session.
    }
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggle = useCallback(
    () => setModeState((prev) => (prev === 'light' ? 'dark' : 'light')),
    [],
  );

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

/**
 * Reads or changes the active light/dark theme.
 *
 * @returns The mode and its setters.
 * @throws {Error} If used outside {@link ThemeModeProvider}.
 */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used inside <ThemeModeProvider>');
  }
  return ctx;
}
