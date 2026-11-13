import type { ReactNode } from 'react';
import { LanguageSwitcher } from '../../components/shell/LanguageSwitcher';
import { ThemeToggle } from '../../components/shell/ThemeToggle';

/**
 * Layout for the public auth routes (`/login`, `/register`).
 *
 * Follows the same light/dark theme as the rest of the app. The corner slot
 * holds the language and theme controls so a visitor can set both before
 * signing in.
 */
export default function PublicAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute right-4 top-4 z-50 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
